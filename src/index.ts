import { readJson, STATE_KEYS, writeJson, type AmazonCookies, type SourceStatus, type StravaTokens } from "./state";
import { SOURCES } from "./sources/registry";
import { STRAVA_TOKEN_URL } from "./sources/strava";
import type { Env } from "./sources/types";
import { runSync } from "./sync";

const STRAVA_AUTHORIZE_URL = "https://www.strava.com/oauth/authorize";

function isAuthorized(request: Request, env: Env): boolean {
  const url = new URL(request.url);
  const token = request.headers.get("Authorization")?.replace(/^Bearer /, "") ?? url.searchParams.get("token");
  return Boolean(env.ADMIN_TOKEN) && token === env.ADMIN_TOKEN;
}

async function handleStatus(env: Env): Promise<Response> {
  // List every stored status directly from KV rather than the current source registry,
  // so status for a deferred or removed source (e.g. kindle) stays visible until cleared.
  const prefix = STATE_KEYS.sourceStatus("");
  const statuses: Record<string, SourceStatus | null> = {};
  const { keys } = await env.STATE.list({ prefix });
  for (const key of keys) {
    const sourceName = key.name.slice(prefix.length);
    statuses[sourceName] = await readJson<SourceStatus>(env.STATE, key.name);
  }
  return Response.json(statuses);
}

async function handleAmazonCookies(request: Request, env: Env): Promise<Response> {
  const body = (await request.json().catch(() => null)) as { cookie?: unknown } | null;
  if (!body || typeof body.cookie !== "string" || body.cookie.length === 0) {
    return Response.json({ error: 'expected body {"cookie": "<cookie header string>"}' }, { status: 400 });
  }
  const cookies: AmazonCookies = { cookie: body.cookie, updatedAt: new Date().toISOString() };
  await writeJson(env.STATE, STATE_KEYS.amazonCookies, cookies);
  return new Response(null, { status: 204 });
}

async function handleStravaAuthorize(request: Request, env: Env): Promise<Response> {
  if (!env.STRAVA_CLIENT_ID) {
    return Response.json({ error: "STRAVA_CLIENT_ID is not configured" }, { status: 500 });
  }
  const state = crypto.randomUUID();
  await env.STATE.put(STATE_KEYS.stravaOauthState, state, { expirationTtl: 600 });
  const redirect = new URL(STRAVA_AUTHORIZE_URL);
  redirect.searchParams.set("client_id", env.STRAVA_CLIENT_ID);
  redirect.searchParams.set("redirect_uri", `${new URL(request.url).origin}/strava/callback`);
  redirect.searchParams.set("response_type", "code");
  redirect.searchParams.set("scope", "activity:read_all");
  redirect.searchParams.set("state", state);
  return Response.redirect(redirect.toString(), 302);
}

async function handleStravaCallback(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const expectedState = await env.STATE.get(STATE_KEYS.stravaOauthState);
  if (!expectedState || url.searchParams.get("state") !== expectedState) {
    return Response.json({ error: "state mismatch; restart at /strava/authorize" }, { status: 403 });
  }
  const code = url.searchParams.get("code");
  if (!code) {
    return Response.json({ error: "missing code parameter" }, { status: 400 });
  }
  const response = await fetch(STRAVA_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: env.STRAVA_CLIENT_ID,
      client_secret: env.STRAVA_CLIENT_SECRET,
      grant_type: "authorization_code",
      code,
    }),
  });
  if (!response.ok) {
    return Response.json({ error: `Strava code exchange failed with status ${response.status}` }, { status: 502 });
  }
  const body = (await response.json()) as { access_token: string; refresh_token: string; expires_at: number };
  const tokens: StravaTokens = {
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    expiresAt: body.expires_at,
  };
  await writeJson(env.STATE, STATE_KEYS.stravaTokens, tokens);
  await env.STATE.delete(STATE_KEYS.stravaOauthState);
  return new Response("Strava connected. You can close this tab.", { status: 200 });
}

export default {
  async fetch(request: Request, env: Env, _context: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const route = `${request.method} ${url.pathname}`;

    if (route === "GET /strava/callback") {
      return handleStravaCallback(request, env);
    }
    if (!isAuthorized(request, env)) {
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }
    switch (route) {
      case "POST /sync":
        return Response.json(await runSync(env, SOURCES, new Date(), fetch, url.searchParams.get("source") ?? undefined));
      case "GET /status":
        return handleStatus(env);
      case "PUT /state/amazon-cookies":
        return handleAmazonCookies(request, env);
      case "GET /strava/authorize":
        return handleStravaAuthorize(request, env);
      default:
        return Response.json({ error: "not found" }, { status: 404 });
    }
  },

  async scheduled(_controller: ScheduledController, env: Env, context: ExecutionContext): Promise<void> {
    context.waitUntil(runSync(env, SOURCES, new Date()));
  },
} satisfies ExportedHandler<Env>;
