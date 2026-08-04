import { readJson, STATE_KEYS, writeJson, type AmazonCookies, type SourceStatus } from "./state";
import { SOURCES } from "./sources/registry";
import { exchangeStravaCode } from "./sources/strava";
import type { Env } from "./sources/types";
import { runSync } from "./sync";

const STRAVA_AUTHORIZE_URL = "https://www.strava.com/oauth/authorize";

// Query-param auth is scoped to the Strava authorize route only (it's opened directly in a
// browser, so it can't attach an Authorization header); every other route requires the header,
// since query strings leak into access logs, proxy logs, and browser history.
function isAuthorized(request: Request, env: Env, allowQueryToken: boolean): boolean {
  const headerToken = request.headers.get("Authorization")?.replace(/^Bearer /, "");
  const queryToken = allowQueryToken ? new URL(request.url).searchParams.get("token") : null;
  const token = headerToken ?? queryToken;
  return Boolean(env.ADMIN_TOKEN) && token === env.ADMIN_TOKEN;
}

async function handleStatus(env: Env): Promise<Response> {
  const statuses: Record<string, SourceStatus | null> = {};
  for (const source of SOURCES) {
    statuses[source.name] = await readJson<SourceStatus>(env.STATE, STATE_KEYS.sourceStatus(source.name));
  }
  // Keys can outlive their source when an integration is removed from the registry; surface those too.
  const prefix = STATE_KEYS.sourceStatus("");
  const stored = await env.STATE.list({ prefix });
  for (const key of stored.keys) {
    const sourceName = key.name.slice(prefix.length);
    if (!(sourceName in statuses)) {
      statuses[sourceName] = await readJson<SourceStatus>(env.STATE, key.name);
    }
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

async function handleStravaCallback(request: Request, env: Env, fetchFn: typeof fetch): Promise<Response> {
  const url = new URL(request.url);
  const expectedState = await env.STATE.get(STATE_KEYS.stravaOauthState);
  if (!expectedState || url.searchParams.get("state") !== expectedState) {
    return Response.json({ error: "state mismatch; restart at /strava/authorize" }, { status: 403 });
  }
  const code = url.searchParams.get("code");
  if (!code) {
    return Response.json({ error: "missing code parameter" }, { status: 400 });
  }
  try {
    await exchangeStravaCode(env, fetchFn, code);
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 502 });
  }
  await env.STATE.delete(STATE_KEYS.stravaOauthState);
  return new Response("Strava connected. You can close this tab.", { status: 200 });
}

// Takes an injectable fetchFn (defaulted to the global fetch) so tests can exercise the Strava
// code exchange and /sync route without hitting the network.
export async function handleFetch(request: Request, env: Env, fetchFn: typeof fetch = fetch): Promise<Response> {
  const url = new URL(request.url);
  const route = `${request.method} ${url.pathname}`;

  if (route === "GET /strava/callback") {
    return handleStravaCallback(request, env, fetchFn);
  }
  if (!isAuthorized(request, env, route === "GET /strava/authorize")) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  switch (route) {
    case "POST /sync":
      return Response.json(await runSync(env, SOURCES, new Date(), fetchFn, url.searchParams.get("source") ?? undefined));
    case "GET /status":
      return handleStatus(env);
    case "PUT /state/amazon-cookies":
      return handleAmazonCookies(request, env);
    case "GET /strava/authorize":
      return handleStravaAuthorize(request, env);
    default:
      return Response.json({ error: "not found" }, { status: 404 });
  }
}

export default {
  async fetch(request: Request, env: Env, _context: ExecutionContext): Promise<Response> {
    return handleFetch(request, env);
  },

  async scheduled(_controller: ScheduledController, env: Env, _context: ExecutionContext): Promise<void> {
    // Awaiting directly (instead of context.waitUntil) means a thrown error surfaces to
    // Cloudflare's cron failure reporting rather than being silently swallowed.
    try {
      await runSync(env, SOURCES, new Date());
    } catch (error) {
      console.error("habitify-sync scheduled run failed:", error);
    }
  },
} satisfies ExportedHandler<Env>;
