import { readJson, writeJson } from "../../state";
import { localMidnightEpochSeconds } from "../../time";
import {
  AuthNeededError,
  type Env,
  type HabitValue,
  type Integration,
  type RouteContext,
  type SettingDescriptor,
  type SourceContext,
} from "../types";

const STRAVA_AUTHORIZE_URL = "https://www.strava.com/oauth/authorize";
const STRAVA_TOKEN_URL = "https://www.strava.com/api/v3/oauth/token";
const STRAVA_ACTIVITIES_URL = "https://www.strava.com/api/v3/athlete/activities";

const STRAVA_SETTINGS: SettingDescriptor[] = [
  {
    key: "clientId",
    type: "string",
    secret: true,
    required: true,
    description: "Strava OAuth application client id, from strava.com/settings/api.",
  },
  {
    key: "clientSecret",
    type: "string",
    secret: true,
    required: true,
    description: "Strava OAuth application client secret, from strava.com/settings/api.",
  },
];

// This integration's own KV keys — not shared generic state.
export const STRAVA_STATE_KEYS = {
  tokens: "strava:tokens",
  oauthState: "strava:oauth_state",
};

export interface StravaTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

interface StravaTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_at: number;
}

function mapTokenResponse(body: StravaTokenResponse): StravaTokens {
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    expiresAt: body.expires_at,
  };
}

// Strava documents (and OAuth 2.0 requires) form-urlencoded token requests; URLSearchParams
// sets the Content-Type header itself, so it must not be set manually here.
function requestStravaToken(
  clientId: string,
  clientSecret: string,
  fetchFn: typeof fetch,
  grantParams: Record<string, string>,
): Promise<Response> {
  return fetchFn(STRAVA_TOKEN_URL, {
    method: "POST",
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, ...grantParams }),
  });
}

// Strava rotates refresh tokens on every refresh, so the new one must be persisted.
async function refreshTokens(
  env: Env,
  clientId: string,
  clientSecret: string,
  fetchFn: typeof fetch,
  tokens: StravaTokens,
): Promise<StravaTokens> {
  const response = await requestStravaToken(clientId, clientSecret, fetchFn, {
    grant_type: "refresh_token",
    refresh_token: tokens.refreshToken,
  });
  if (response.status === 400 || response.status === 401) {
    throw new AuthNeededError("Strava refused the refresh token; re-run /strava/authorize");
  }
  if (!response.ok) {
    throw new Error(`Strava token refresh failed with status ${response.status}`);
  }
  const refreshed = mapTokenResponse((await response.json()) as StravaTokenResponse);
  await writeJson(env.STATE, STRAVA_STATE_KEYS.tokens, refreshed);
  return refreshed;
}

// Performs the one-time authorization_code exchange after the user completes Strava's consent
// screen, and persists the resulting tokens the same way refreshTokens does.
export async function exchangeStravaCode(
  env: Env,
  clientId: string,
  clientSecret: string,
  fetchFn: typeof fetch,
  code: string,
): Promise<StravaTokens> {
  const response = await requestStravaToken(clientId, clientSecret, fetchFn, { grant_type: "authorization_code", code });
  if (!response.ok) {
    throw new Error(`Strava code exchange failed with status ${response.status}`);
  }
  const tokens = mapTokenResponse((await response.json()) as StravaTokenResponse);
  await writeJson(env.STATE, STRAVA_STATE_KEYS.tokens, tokens);
  return tokens;
}

async function handleAuthorize(request: Request, context: RouteContext): Promise<Response> {
  const { env, settings } = context;
  const clientId = await settings.getString("clientId");
  if (!clientId) {
    return Response.json({ error: "STRAVA_CLIENT_ID is not configured" }, { status: 500 });
  }
  const state = crypto.randomUUID();
  await env.STATE.put(STRAVA_STATE_KEYS.oauthState, state, { expirationTtl: 600 });
  const redirect = new URL(STRAVA_AUTHORIZE_URL);
  redirect.searchParams.set("client_id", clientId);
  redirect.searchParams.set("redirect_uri", `${new URL(request.url).origin}/strava/callback`);
  redirect.searchParams.set("response_type", "code");
  redirect.searchParams.set("scope", "activity:read_all");
  redirect.searchParams.set("state", state);
  return Response.redirect(redirect.toString(), 302);
}

async function handleCallback(request: Request, context: RouteContext): Promise<Response> {
  const { env, fetchFn, settings } = context;
  const url = new URL(request.url);
  const expectedState = await env.STATE.get(STRAVA_STATE_KEYS.oauthState);
  if (!expectedState || url.searchParams.get("state") !== expectedState) {
    return Response.json({ error: "state mismatch; restart at /strava/authorize" }, { status: 403 });
  }
  const code = url.searchParams.get("code");
  if (!code) {
    return Response.json({ error: "missing code parameter" }, { status: 400 });
  }
  const clientId = await settings.getString("clientId");
  const clientSecret = await settings.getString("clientSecret");
  if (!clientId || !clientSecret) {
    return Response.json({ error: "STRAVA_CLIENT_ID/STRAVA_CLIENT_SECRET are not configured" }, { status: 500 });
  }
  try {
    await exchangeStravaCode(env, clientId, clientSecret, fetchFn, code);
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 502 });
  }
  await env.STATE.delete(STRAVA_STATE_KEYS.oauthState);
  return new Response("Strava connected. You can close this tab.", { status: 200 });
}

export const stravaIntegration: Integration = {
  name: "strava",
  settings: STRAVA_SETTINGS,

  async fetchToday(context: SourceContext): Promise<HabitValue[]> {
    const { env, timeZone, now, fetchFn, settings } = context;
    const clientId = await settings.getString("clientId");
    const clientSecret = await settings.getString("clientSecret");
    // Guaranteed present: fetchToday only runs once SettingsResolver.isEnabled() has confirmed
    // every required setting (both secrets included) resolved non-empty.
    const habitId = await settings.getString("habitId");
    if (!clientId || !clientSecret || !habitId) {
      throw new Error("strava is enabled but a required setting resolved empty; this should be unreachable");
    }

    let tokens = await readJson<StravaTokens>(env.STATE, STRAVA_STATE_KEYS.tokens);
    if (!tokens) {
      throw new AuthNeededError("Strava is not authorized yet; open /strava/authorize");
    }
    const nowEpoch = Math.floor(now.getTime() / 1000);
    if (tokens.expiresAt <= nowEpoch + 60) {
      tokens = await refreshTokens(env, clientId, clientSecret, fetchFn, tokens);
    }
    const after = localMidnightEpochSeconds(timeZone, now);
    const response = await fetchFn(`${STRAVA_ACTIVITIES_URL}?after=${after}&per_page=100`, {
      headers: { Authorization: `Bearer ${tokens.accessToken}` },
    });
    if (response.status === 401) {
      throw new AuthNeededError("Strava rejected the access token; re-run /strava/authorize");
    }
    if (!response.ok) {
      throw new Error(`Strava activities request failed with status ${response.status}`);
    }
    const activities = (await response.json()) as { moving_time: number }[];
    if (!Array.isArray(activities)) {
      throw new Error("Strava returned an unexpected payload shape");
    }
    const totalSeconds = activities.reduce((sum, activity) => sum + activity.moving_time, 0);
    return [{ habitId, value: Math.round(totalSeconds / 60), unit: "min" }];
  },

  routes: [
    { method: "GET", path: "/strava/authorize", auth: "admin-or-query-token", handler: handleAuthorize },
    { method: "GET", path: "/strava/callback", auth: "public", handler: handleCallback },
  ],
};
