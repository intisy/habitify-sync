# Modular integrations — Design

**Date:** 2026-08-04
**Status:** Approved
**Supersedes:** the `src/sources/` layout in
`2026-08-04-habitify-sync-design.md`

## Problem

An integration's code is currently spread across five places: its source file
in `src/sources/`, its routes in `src/index.ts`, its state keys in
`src/state.ts`, its env keys in `src/sources/types.ts`, and its tests in
`test/sources/`. Strava proved the point — adding one OAuth integration
touched all five. There is also no per-integration documentation.

## Goal

Each integration is one self-contained directory. Adding or removing an
integration means adding or removing that directory plus one registry line.

## Layout

```
src/
  index.ts                    worker entry: cron + core routes, mounts integration routes
  sync.ts                     orchestrator
  habitify.ts                 Habitify client
  state.ts                    generic KV helpers only (readJson/writeJson, status keys)
  time.ts
  integrations/
    types.ts                  Integration + IntegrationRoute + shared context types
    registry.ts               INTEGRATIONS array — the one place to register
    strava/
      index.ts                integration definition (fetchToday + routes + state keys)
      index.test.ts           colocated tests
      README.md               setup, secrets, metric, gotchas
    wakatime/
      index.ts
      index.test.ts
      README.md
```

Generic infrastructure (`state.ts`, `habitify.ts`, `time.ts`, `sync.ts`) holds
nothing integration-specific. Integration-specific KV keys are declared by the
integration itself.

## The Integration interface

```ts
export interface IntegrationRoute {
  method: string;                       // "GET" | "POST" | "PUT" | "DELETE"
  path: string;                         // absolute, e.g. "/strava/authorize"
  auth: "admin" | "admin-or-query-token" | "public";
  handler(request: Request, context: RouteContext): Promise<Response>;
}

export interface Integration {
  name: string;                         // registry key, also the status key suffix
  enabled(env: Env): boolean;           // true when its secrets/vars are set
  fetchToday(context: SourceContext): Promise<HabitValue[]>;
  routes?: IntegrationRoute[];
}
```

- `auth: "admin"` — requires `Authorization: Bearer <ADMIN_TOKEN>`.
- `auth: "admin-or-query-token"` — additionally accepts `?token=`, for routes
  opened in a browser (only Strava's authorize route needs this).
- `auth: "public"` — no admin token; the handler must authenticate by other
  means (Strava's callback validates the stored OAuth `state`).

`RouteContext` carries `{ env, fetchFn }` so handlers stay testable with an
injected fetch.

## Worker entry

`src/index.ts` keeps only core concerns: the cron handler, `POST /sync`,
`GET /status`, admin-token checking, and route dispatch. It builds its route
table once from `INTEGRATIONS.flatMap(i => i.routes ?? [])` plus the core
routes, and knows nothing about any specific integration. A duplicate
`METHOD /path` across integrations is a programming error and must fail loudly
at module load.

## Per-integration README

Every integration directory carries a `README.md` with the same sections, in
this order:

1. **What it logs** — the metric, its unit, and the Habitify habit var name.
2. **Configuration** — every secret and var it reads, and where to get each.
3. **Setup** — the exact one-time steps, including any browser/OAuth flow.
4. **Routes** — the endpoints it contributes, or "none".
5. **Stored state** — the KV keys it owns, or "none".
6. **Gotchas** — the failure modes and their `GET /status` states.

The root `README.md` keeps the project-level story and links to each
integration README rather than duplicating their content. Its "adding an
integration" section becomes a single recipe (one directory + one registry
line) instead of two divergent ones.

## Constraints

- No behavior change. The 39 existing tests must pass unchanged in substance;
  only import paths and test file locations may move.
- Same auth semantics as today: `?token=` remains accepted **only** on the
  Strava authorize route.
- No new runtime dependencies.
- `HabitValue`, `SourceContext`, `Source`-equivalent shapes keep their current
  field names so the Habitify client and orchestrator are untouched.

## Out of scope

- Any change to what Strava or WakaTime actually log.
- Dynamic/plugin loading of integrations at runtime — the registry stays a
  static import list so the bundle stays statically analyzable.
