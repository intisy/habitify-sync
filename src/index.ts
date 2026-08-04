import { HabitifyClient, HabitInputValidationError } from "./habitify";
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
// `?raw=1` switches to the untouched GET /habits payload instead of the trimmed
// { id, name, unit } summaries — a diagnostic escape hatch for when the trimmed shape hides the
// field that explains a habit's unexpected behavior (scheduling, area, time-of-day, archived
// flag, created timestamp, etc.). The default (no `raw`) behavior is unchanged.
async function handleListHabits(request: Request, context: RouteContext): Promise<Response> {
  if (!context.env.HABITIFY_API_KEY) {
    return Response.json({ error: "HABITIFY_API_KEY is not configured" }, { status: 503 });
  }
  const url = new URL(request.url);
  const raw = url.searchParams.has("raw");
  const habitify = new HabitifyClient(context.env.HABITIFY_API_KEY, context.fetchFn);
  try {
    const habits = raw ? await habitify.listHabitsRaw() : await habitify.listHabits();
    return Response.json(habits);
  } catch (error) {
    if (error instanceof HabitInputValidationError) {
      return Response.json({ error: error.message }, { status: 400 });
    }
    // The thrown error's message already omits the API key (see HabitifyClient.listHabits), so
    // it's safe to surface directly here.
    return Response.json(
      { error: `Habitify request failed: ${error instanceof Error ? error.message : String(error)}` },
      { status: 502 },
    );
  }
}

// Lets an operator see the day-by-day journal view Habitify's own app renders for a given
// date — completion status and progress per habit — so it can be compared against GET /habits
// (or its `?raw=1` payload) when a habit that exists via the API doesn't appear as expected in
// the app. `?date=YYYY-MM-DD` selects the day; omitted, Habitify defaults to today in the
// account's own timezone.
async function handleJournal(request: Request, context: RouteContext): Promise<Response> {
  if (!context.env.HABITIFY_API_KEY) {
    return Response.json({ error: "HABITIFY_API_KEY is not configured" }, { status: 503 });
  }
  const url = new URL(request.url);
  const habitify = new HabitifyClient(context.env.HABITIFY_API_KEY, context.fetchFn);
  try {
    const journal = await habitify.getJournalRaw(url.searchParams.get("date") ?? undefined);
    return Response.json(journal);
  } catch (error) {
    if (error instanceof HabitInputValidationError) {
      return Response.json({ error: error.message }, { status: 400 });
    }
    return Response.json(
      { error: `Habitify request failed: ${error instanceof Error ? error.message : String(error)}` },
      { status: 502 },
    );
  }
}

// Lets an operator provision a Habitify habit to log into without ever handling
// HABITIFY_API_KEY locally, symmetric with GET /habits above.
async function handleCreateHabit(request: Request, context: RouteContext): Promise<Response> {
  if (!context.env.HABITIFY_API_KEY) {
    return Response.json({ error: "HABITIFY_API_KEY is not configured" }, { status: 503 });
  }
  let parsedBody: unknown;
  try {
    parsedBody = await request.json();
  } catch {
    return Response.json({ error: "Request body must be valid JSON" }, { status: 400 });
  }
  if (typeof parsedBody !== "object" || parsedBody === null) {
    return Response.json({ error: "Request body must be a JSON object" }, { status: 400 });
  }
  // Pick only the fields HabitifyClient.createHabit understands — anything else in the body
  // (areaIds, timeOfDayIds, or unrecognized fields) is silently dropped rather than forwarded.
  const { name, type, description, goal, occurrence } = parsedBody as Record<string, unknown>;
  const habitify = new HabitifyClient(context.env.HABITIFY_API_KEY, context.fetchFn);
  try {
    const created = await habitify.createHabit({
      name: name as string,
      type: type as "good" | "bad" | undefined,
      description: description as string | undefined,
      goal: goal as { periodicity: "daily" | "weekly" | "monthly" | "yearly"; value: number; unit: string } | undefined,
      occurrence,
    });
    return Response.json(created, { status: 201 });
  } catch (error) {
    // HabitInputValidationError is thrown synchronously by createHabit before any request is
    // made (see assertValidCreateHabitInput in habitify.ts) — a 400, since the mistake is in the
    // request body, not upstream. Anything else came from the Habitify call itself, a 502.
    if (error instanceof HabitInputValidationError) {
      return Response.json({ error: error.message }, { status: 400 });
    }
    return Response.json(
      { error: `Habitify request failed: ${error instanceof Error ? error.message : String(error)}` },
      { status: 502 },
    );
  }
}

const CORE_ROUTES: IntegrationRoute[] = [
  { method: "POST", path: "/sync", auth: "admin", handler: handleSync },
  { method: "GET", path: "/status", auth: "admin", handler: (_request, context) => handleStatus(context.env) },
  { method: "GET", path: "/habits", auth: "admin", handler: handleListHabits },
  { method: "POST", path: "/habits", auth: "admin", handler: handleCreateHabit },
  { method: "GET", path: "/journal", auth: "admin", handler: handleJournal },
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

// Cloudflare's edge cache keys on the full URL including the query string, so a stale response
// cached for one query string (e.g. a 404 cached before a deployment finished propagating) can
// keep being served while requests with a different query string see the real, current result.
// Every route here either reports live state (status, habits, journal) or performs an action
// (sync, habit creation, the Strava OAuth handshake), so none of it is safe to cache at any
// layer — this stamps every response dispatch returns with Cache-Control: no-store, regardless
// of which branch below produced it.
function withNoStore(response: Response): Response {
  // Response.headers can be immutable depending on how the response was constructed (e.g.
  // Response.redirect()), so build a fresh Response around the original's body/status/headers
  // rather than mutating the response we were handed.
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "no-store");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
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
    return withNoStore(await route.handler(request, { env, fetchFn }));
  }
  // A route that isn't registered is treated as requiring the strictest auth (bearer token
  // only, no query fallback), so probing for routes without a token gets the same 401 a real
  // admin route would, rather than a bare 404 leaking which paths exist.
  if (!isAuthorized(request, env, route?.auth ?? "admin")) {
    return withNoStore(Response.json({ error: "unauthorized" }, { status: 401 }));
  }
  if (!route) {
    return withNoStore(Response.json({ error: "not found" }, { status: 404 }));
  }
  return withNoStore(await route.handler(request, { env, fetchFn }));
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
