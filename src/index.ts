import { HabitifyClient } from "./habitify";
import { readJson, STATE_KEYS, type SourceStatus } from "./state";
import { INTEGRATIONS } from "./integrations/registry";
import type { AuthMode, Env, IntegrationRoute, RouteContext } from "./integrations/types";
import { runSync } from "./sync";

// Query-param auth is honored only for routes declared "admin-or-query-token" (currently just
// Strava's authorize route: it's opened directly in a browser, so it can't attach an
// Authorization header). Every other route requires the header, since query strings leak into
// access logs, proxy logs, and browser history.
function isAuthorized(request: Request, env: Env, auth: AuthMode): boolean {
  const headerToken = request.headers.get("Authorization")?.replace(/^Bearer /, "");
  const queryToken = auth === "admin-or-query-token" ? new URL(request.url).searchParams.get("token") : null;
  const token = headerToken ?? queryToken;
  return Boolean(env.ADMIN_TOKEN) && token === env.ADMIN_TOKEN;
}

async function handleStatus(env: Env): Promise<Response> {
  const statuses: Record<string, SourceStatus | null> = {};
  for (const integration of INTEGRATIONS) {
    statuses[integration.name] = await readJson<SourceStatus>(env.STATE, STATE_KEYS.sourceStatus(integration.name));
  }
  // Keys can outlive their integration when it's removed from the registry; surface those too.
  const prefix = STATE_KEYS.sourceStatus("");
  const stored = await env.STATE.list({ prefix });
  for (const key of stored.keys) {
    const name = key.name.slice(prefix.length);
    if (!(name in statuses)) {
      statuses[name] = await readJson<SourceStatus>(env.STATE, key.name);
    }
  }
  return Response.json(statuses);
}

async function handleSync(request: Request, context: RouteContext): Promise<Response> {
  const url = new URL(request.url);
  const sourceParam = url.searchParams.get("source") ?? undefined;
  if (sourceParam && !INTEGRATIONS.some((integration) => integration.name === sourceParam)) {
    return Response.json(
      {
        error: `unknown source "${sourceParam}"; valid sources: ${INTEGRATIONS.map((integration) => integration.name).join(", ")}`,
      },
      { status: 404 },
    );
  }
  return Response.json(await runSync(context.env, INTEGRATIONS, new Date(), context.fetchFn, sourceParam));
}

// Lets an operator discover Habitify habit ids without ever handling HABITIFY_API_KEY locally —
// the worker already holds the secret, so it can look habits up on the operator's behalf.
async function handleListHabits(context: RouteContext): Promise<Response> {
  if (!context.env.HABITIFY_API_KEY) {
    return Response.json({ error: "HABITIFY_API_KEY is not configured" }, { status: 503 });
  }
  const habitify = new HabitifyClient(context.env.HABITIFY_API_KEY, context.fetchFn);
  try {
    const habits = await habitify.listHabits();
    return Response.json(habits);
  } catch (error) {
    // The thrown error's message already omits the API key (see HabitifyClient.listHabits), so
    // it's safe to surface directly here.
    return Response.json(
      { error: `Habitify request failed: ${error instanceof Error ? error.message : String(error)}` },
      { status: 502 },
    );
  }
}

const CORE_ROUTES: IntegrationRoute[] = [
  { method: "POST", path: "/sync", auth: "admin", handler: handleSync },
  { method: "GET", path: "/status", auth: "admin", handler: (_request, context) => handleStatus(context.env) },
  { method: "GET", path: "/habits", auth: "admin", handler: (_request, context) => handleListHabits(context) },
];

// Builds a lookup table keyed by "METHOD path" from a flat list of routes (core routes plus
// every route each integration contributes). Exported so tests can prove duplicate detection
// and generic dispatch behavior using routes that don't belong to any real integration.
export function buildRouteTable(routes: IntegrationRoute[]): Map<string, IntegrationRoute> {
  const table = new Map<string, IntegrationRoute>();
  for (const route of routes) {
    const key = `${route.method} ${route.path}`;
    if (table.has(key)) {
      throw new Error(`Duplicate route registration: ${key}`);
    }
    table.set(key, route);
  }
  return table;
}

export async function dispatch(
  routeTable: Map<string, IntegrationRoute>,
  request: Request,
  env: Env,
  fetchFn: typeof fetch,
): Promise<Response> {
  const url = new URL(request.url);
  const route = routeTable.get(`${request.method} ${url.pathname}`);
  if (route?.auth === "public") {
    return route.handler(request, { env, fetchFn });
  }
  // A route that isn't registered is treated as requiring the strictest auth (bearer token
  // only, no query fallback), so probing for routes without a token gets the same 401 a real
  // admin route would, rather than a bare 404 leaking which paths exist.
  if (!isAuthorized(request, env, route?.auth ?? "admin")) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!route) {
    return Response.json({ error: "not found" }, { status: 404 });
  }
  return route.handler(request, { env, fetchFn });
}

const ROUTE_TABLE = buildRouteTable([
  ...CORE_ROUTES,
  ...INTEGRATIONS.flatMap((integration) => integration.routes ?? []),
]);

// Takes an injectable fetchFn (defaulted to the global fetch) so tests can exercise the Strava
// code exchange and /sync route without hitting the network. Bound to globalThis so the default
// keeps working as a defensive invariant: every call site here treats fetchFn as a plain
// function, and HabitifyClient already detaches it before calling it (see habitify.ts), but a
// pre-bound function tolerates being called as `something.fetchFn(...)` too, in case that
// invariant is ever broken by future code touching this default.
export async function handleFetch(
  request: Request,
  env: Env,
  fetchFn: typeof fetch = fetch.bind(globalThis),
): Promise<Response> {
  return dispatch(ROUTE_TABLE, request, env, fetchFn);
}

export default {
  async fetch(request: Request, env: Env, _context: ExecutionContext): Promise<Response> {
    return handleFetch(request, env);
  },

  async scheduled(_controller: ScheduledController, env: Env, _context: ExecutionContext): Promise<void> {
    // Awaiting directly (instead of context.waitUntil) means a thrown error surfaces to
    // Cloudflare's cron failure reporting rather than being silently swallowed.
    try {
      await runSync(env, INTEGRATIONS, new Date());
    } catch (error) {
      console.error("habitify-sync scheduled run failed:", error);
    }
  },
} satisfies ExportedHandler<Env>;
