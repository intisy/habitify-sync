import { HabitifyClient, HabitInputValidationError } from "./habitify";
import { readJson, STATE_KEYS, type SourceStatus } from "./state";
import { INTEGRATIONS } from "./integrations/registry";
import type { AuthMode, Env, Integration, IntegrationRoute, RouteContext, SettingDescriptor } from "./integrations/types";
import {
  configKvKey,
  deriveVariableName,
  readConfigOverrides,
  settingsForIntegration,
  SettingsResolver,
  writeConfigOverrides,
  type ResolvedSetting,
} from "./settings";
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

// The shape GET /config and GET /config/<integration> report per setting: value/source/default/
// description/type for discoverability, with secrets redacted to a boolean rather than ever
// echoing the actual value — the asymmetry with non-secret settings (which do report `value`) is
// the point, not an oversight.
interface SettingSnapshot {
  key: string;
  type: SettingDescriptor["type"];
  description: string;
  required: boolean;
  secret: boolean;
  default?: string;
  source: ResolvedSetting["source"];
  value?: string;
  configured?: boolean;
}

function snapshotSetting(resolved: ResolvedSetting): SettingSnapshot {
  const { descriptor } = resolved;
  const snapshot: SettingSnapshot = {
    key: resolved.key,
    type: descriptor.type,
    description: descriptor.description,
    required: Boolean(descriptor.required),
    secret: Boolean(descriptor.secret),
    default: descriptor.default,
    source: resolved.source,
  };
  if (descriptor.secret) {
    snapshot.configured = resolved.value !== undefined;
  } else {
    snapshot.value = resolved.value;
  }
  return snapshot;
}

async function resolvedSettingsFor(integration: Integration, env: Env): Promise<SettingSnapshot[]> {
  const resolver = new SettingsResolver(env, env.STATE, integration.name, integration.settings);
  return (await resolver.resolveAll()).map(snapshotSetting);
}

async function handleGetAllConfig(_request: Request, context: RouteContext): Promise<Response> {
  const result: Record<string, SettingSnapshot[]> = {};
  for (const integration of INTEGRATIONS) {
    result[integration.name] = await resolvedSettingsFor(integration, context.env);
  }
  return Response.json(result);
}

async function handleGetIntegrationConfig(
  integration: Integration,
  _request: Request,
  context: RouteContext,
): Promise<Response> {
  return Response.json({ integration: integration.name, settings: await resolvedSettingsFor(integration, context.env) });
}

// Validates a raw string value (the shape every wrangler.toml var and every KV override actually
// is) against a setting's declared type — a `number` must parse finite, a `json` must parse at
// all — so a bad value is rejected here rather than degrading silently the next time it's read.
// scripts/preflight.mjs reimplements this same number/JSON check in plain JS (it can't import this
// file — see its own header comment for why) — keep the two in sync if this logic changes.
function settingValidationError(descriptor: SettingDescriptor, value: string): string | undefined {
  if (descriptor.type === "number" && !Number.isFinite(Number(value))) {
    return `"${descriptor.key}" must be a number, got ${JSON.stringify(value)}`;
  }
  if (descriptor.type === "json") {
    try {
      JSON.parse(value);
    } catch (cause) {
      return `"${descriptor.key}" must be valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`;
    }
  }
  return undefined;
}

async function handlePutIntegrationConfig(
  integration: Integration,
  request: Request,
  context: RouteContext,
): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "request body must be valid JSON" }, { status: 400 });
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return Response.json(
      { error: "request body must be a JSON object mapping setting key to string value" },
      { status: 400 },
    );
  }
  const descriptors = settingsForIntegration(integration);
  const validKeys = descriptors.map((descriptor) => descriptor.key).join(", ");
  const updates: Record<string, string> = {};
  for (const [key, rawValue] of Object.entries(body as Record<string, unknown>)) {
    const descriptor = descriptors.find((candidate) => candidate.key === key);
    if (!descriptor) {
      return Response.json(
        { error: `unknown setting "${key}" for ${integration.name}; valid settings: ${validKeys}` },
        { status: 400 },
      );
    }
    if (descriptor.secret) {
      return Response.json(
        {
          error:
            `"${key}" is a secret and cannot be set through this API; configure it with ` +
            `wrangler secret put ${deriveVariableName(integration.name, key)}`,
        },
        { status: 400 },
      );
    }
    if (typeof rawValue !== "string") {
      return Response.json({ error: `"${key}" must be a string value, got ${JSON.stringify(rawValue)}` }, { status: 400 });
    }
    const validationError = settingValidationError(descriptor, rawValue);
    if (validationError) {
      return Response.json({ error: validationError }, { status: 400 });
    }
    updates[key] = rawValue;
  }
  const existing = await readConfigOverrides(context.env.STATE, integration.name);
  const merged = { ...existing, ...updates };
  await writeConfigOverrides(context.env.STATE, integration.name, merged);
  return Response.json({ integration: integration.name, overrides: merged });
}

async function handleDeleteIntegrationConfig(
  integration: Integration,
  request: Request,
  context: RouteContext,
): Promise<Response> {
  const key = new URL(request.url).searchParams.get("key");
  if (key) {
    const descriptors = settingsForIntegration(integration);
    if (!descriptors.some((descriptor) => descriptor.key === key)) {
      return Response.json(
        {
          error: `unknown setting "${key}" for ${integration.name}; valid settings: ${descriptors
            .map((descriptor) => descriptor.key)
            .join(", ")}`,
        },
        { status: 400 },
      );
    }
    const existing = await readConfigOverrides(context.env.STATE, integration.name);
    delete existing[key];
    await writeConfigOverrides(context.env.STATE, integration.name, existing);
    return new Response(null, { status: 204 });
  }
  await context.env.STATE.delete(configKvKey(integration.name));
  return new Response(null, { status: 204 });
}

// Generates the three config routes for one integration, derived entirely from the registry —
// adding an integration never means adding a route here by hand.
function buildConfigRoutesForIntegration(integration: Integration): IntegrationRoute[] {
  return [
    {
      method: "GET",
      path: `/config/${integration.name}`,
      auth: "admin",
      handler: (request, context) => handleGetIntegrationConfig(integration, request, context),
    },
    {
      method: "PUT",
      path: `/config/${integration.name}`,
      auth: "admin",
      handler: (request, context) => handlePutIntegrationConfig(integration, request, context),
    },
    {
      method: "DELETE",
      path: `/config/${integration.name}`,
      auth: "admin",
      handler: (request, context) => handleDeleteIntegrationConfig(integration, request, context),
    },
  ];
}

const CORE_ROUTES: IntegrationRoute[] = [
  { method: "POST", path: "/sync", auth: "admin", handler: handleSync },
  { method: "GET", path: "/status", auth: "admin", handler: (_request, context) => handleStatus(context.env) },
  { method: "GET", path: "/habits", auth: "admin", handler: handleListHabits },
  { method: "POST", path: "/habits", auth: "admin", handler: handleCreateHabit },
  { method: "GET", path: "/journal", auth: "admin", handler: handleJournal },
  { method: "GET", path: "/config", auth: "admin", handler: handleGetAllConfig },
  ...INTEGRATIONS.flatMap((integration) => buildConfigRoutesForIntegration(integration)),
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

// A route's settings resolver is scoped to whichever integration owns it (via routeOwners, built
// from each integration's own `routes` array — see ROUTE_OWNERS below), never to a name the
// handler picks itself. A route with no owner (every CORE_ROUTES entry) gets a resolver with no
// declared settings; harmless, since none of those handlers read context.settings.
function buildRouteContext(
  route: IntegrationRoute,
  env: Env,
  fetchFn: typeof fetch,
  routeOwners: ReadonlyMap<IntegrationRoute, Integration>,
): RouteContext {
  const owner = routeOwners.get(route);
  const settings = new SettingsResolver(env, env.STATE, owner?.name ?? "", owner?.settings ?? []);
  return { env, fetchFn, settings };
}

export async function dispatch(
  routeTable: Map<string, IntegrationRoute>,
  request: Request,
  env: Env,
  fetchFn: typeof fetch,
  routeOwners: ReadonlyMap<IntegrationRoute, Integration> = new Map(),
): Promise<Response> {
  const url = new URL(request.url);
  const route = routeTable.get(`${request.method} ${url.pathname}`);
  if (route?.auth === "public") {
    return withNoStore(await route.handler(request, buildRouteContext(route, env, fetchFn, routeOwners)));
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
  return withNoStore(await route.handler(request, buildRouteContext(route, env, fetchFn, routeOwners)));
}

const ROUTE_TABLE = buildRouteTable([
  ...CORE_ROUTES,
  ...INTEGRATIONS.flatMap((integration) => integration.routes ?? []),
]);

// Maps each integration-contributed route back to the integration that declared it, so dispatch
// can scope that route's settings resolver correctly (see buildRouteContext above) without any
// route hand-declaring its own owner.
const ROUTE_OWNERS = new Map<IntegrationRoute, Integration>();
for (const integration of INTEGRATIONS) {
  for (const route of integration.routes ?? []) {
    ROUTE_OWNERS.set(route, integration);
  }
}

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
  return dispatch(ROUTE_TABLE, request, env, fetchFn, ROUTE_OWNERS);
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
