import { readJson, STATE_KEYS, writeJson, type StravaTokens } from "../state";
import { localMidnightEpochSeconds } from "../time";
import { AuthNeededError, type Env, type HabitValue, type Source, type SourceContext } from "./types";

export const STRAVA_TOKEN_URL = "https://www.strava.com/api/v3/oauth/token";
const STRAVA_ACTIVITIES_URL = "https://www.strava.com/api/v3/athlete/activities";

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
function requestStravaToken(env: Env, fetchFn: typeof fetch, grantParams: Record<string, string>): Promise<Response> {
  return fetchFn(STRAVA_TOKEN_URL, {
    method: "POST",
    body: new URLSearchParams({
      client_id: env.STRAVA_CLIENT_ID ?? "",
      client_secret: env.STRAVA_CLIENT_SECRET ?? "",
      ...grantParams,
    }),
  });
}

// Strava rotates refresh tokens on every refresh, so the new one must be persisted.
async function refreshTokens(env: Env, fetchFn: typeof fetch, tokens: StravaTokens): Promise<StravaTokens> {
  const response = await requestStravaToken(env, fetchFn, {
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
  await writeJson(env.STATE, STATE_KEYS.stravaTokens, refreshed);
  return refreshed;
}

// Performs the one-time authorization_code exchange after the user completes Strava's consent
// screen, and persists the resulting tokens the same way refreshTokens does.
export async function exchangeStravaCode(env: Env, fetchFn: typeof fetch, code: string): Promise<StravaTokens> {
  const response = await requestStravaToken(env, fetchFn, { grant_type: "authorization_code", code });
  if (!response.ok) {
    throw new Error(`Strava code exchange failed with status ${response.status}`);
  }
  const tokens = mapTokenResponse((await response.json()) as StravaTokenResponse);
  await writeJson(env.STATE, STATE_KEYS.stravaTokens, tokens);
  return tokens;
}

export const stravaSource: Source = {
  name: "strava",

  enabled(env: Env): boolean {
    return Boolean(env.STRAVA_CLIENT_ID && env.STRAVA_CLIENT_SECRET && env.HABIT_ID_STRAVA);
  },

  async fetchToday(context: SourceContext): Promise<HabitValue[]> {
    const { env, timeZone, now, fetchFn } = context;
    let tokens = await readJson<StravaTokens>(env.STATE, STATE_KEYS.stravaTokens);
    if (!tokens) {
      throw new AuthNeededError("Strava is not authorized yet; open /strava/authorize");
    }
    const nowEpoch = Math.floor(now.getTime() / 1000);
    if (tokens.expiresAt <= nowEpoch + 60) {
      tokens = await refreshTokens(env, fetchFn, tokens);
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
    return [{ habitId: env.HABIT_ID_STRAVA!, value: Math.round(totalSeconds / 60), unit: "min" }];
  },
};
