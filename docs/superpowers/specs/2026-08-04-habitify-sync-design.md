# habitify-sync — Design

**Date:** 2026-08-04
**Status:** Approved
**Repo:** `F:\Documents\GitHub\web\habitify-sync` — public GitHub repository

## Purpose

A single TypeScript Cloudflare Worker that syncs daily metrics from external
services into Habitify habits:

- **Kindle** — pages read today (**not implemented**, see below)
- **Strava** — minutes of activity published today
- **WakaTime** — minutes coded today

The design leaves integration of new apps open and cheap: one new source file,
one registry entry, its secrets.

## Decisions

| Decision | Choice |
|---|---|
| Kindle data source | Not implemented — no page-count endpoint reachable with session cookies (see below) |
| Logged values | Real quantities (pages, minutes), not check-ins |
| Trigger | Hourly Cloudflare cron + authenticated manual HTTP endpoint |
| Architecture | Single Worker, connector interface, KV for mutable state |
| Secrets | `.dev.vars` (gitignored) locally, `wrangler secret put` in production |

## Architecture

**Superseded by** `2026-08-04-modular-integrations.md`, which moved each
integration (implementation, routes, KV state, tests, README) into its own
directory under `src/integrations/<name>/`. The file tree and extension
point below describe that layout — see the modular-integrations doc for the
full design and the `Integration` interface.

```
src/
  index.ts          worker entry: scheduled (hourly cron) + fetch (HTTP API), route dispatch
  sync.ts           orchestrator: run all integrations, isolate failures, record status
  habitify.ts       Habitify API client (upsert today's log per habit)
  state.ts          generic KV helpers only (tokens/routes/state live with each integration)
  integrations/
    types.ts        the Integration interface — the extension point
    registry.ts     INTEGRATIONS array — the one place to register
    strava/
      index.ts      fetchToday + its OAuth routes + its own KV keys
      index.test.ts
      README.md
    wakatime/
      index.ts
      index.test.ts
      README.md
    # kindle/ — not implemented, see "Kindle — Not implemented" below
```

### Extension point

```ts
interface Integration {
  name: string;
  enabled(env: Env): boolean;            // true when its secrets/vars are set
  fetchToday(ctx: SourceContext): Promise<HabitValue[]>;
  routes?: IntegrationRoute[];           // HTTP endpoints it contributes, if any
}

interface HabitValue {
  habitId: string;
  value: number;
  unit: string;                           // Habitify unit_type, e.g. "min"
}
```

`sync.ts` iterates a registry array of integrations. Each integration runs
inside its own try/catch; results are pushed to Habitify and a per-integration
status record (last success time, last error) is written to KV. One broken
integration never blocks the others.

**Adding a new app** = one directory in `integrations/` implementing
`Integration` (with its own routes and KV keys if it needs any) + one
registry entry + its secrets/vars. Documented as a recipe in the README.

## Per-source behavior

### Strava

- Secrets: `STRAVA_CLIENT_ID`, `STRAVA_CLIENT_SECRET`.
- One-time OAuth bootstrap in the browser: `GET /strava/authorize` redirects to
  Strava consent; `GET /strava/callback` exchanges the code and stores the
  refresh token in KV.
- Strava rotates refresh tokens on every use: after each token refresh the new
  refresh token is persisted back to KV.
- Data: `GET /api/v3/athlete/activities?after=<local midnight epoch>`; value =
  sum of `moving_time` across today's activities, in minutes.

### WakaTime

- Secret: `WAKATIME_API_KEY` (Basic auth).
- Data: `GET /api/v1/users/current/summaries?start=today&end=today`; value =
  grand total minutes.

### Kindle — Not implemented

Amazon exposes no page-count data reachable with a session cookie for this
account. Empirical probe results:

- `www.amazon.com/kindle/reading/insights/data?locale=en_US` works with
  session cookies but returns only streaks (`current_daily_streak` with
  start/end) and completed-title dates — no pages, no minutes.
- `read.amazon.com/kindle-library/search?libraryType=BOOKS` works and returns
  `percentageRead`, but it is `0` for every book on this account.
- `read.amazon.com/service/mobile/reader/startReading` — the only endpoint
  carrying `lastPageReadData.position` and a page-number map — returns 403
  "The given request is not an ADP session request".
- `read.amazon.com/service/web/register/getDeviceToken` returns 403
  "Insufficient or invalid information to authenticate the session".
- Only `libraryType=BOOKS` is accepted (other values 400), so personal
  documents — where the reading actually happens — are unreachable.

Conclusion: a page-count source would require a device token captured from
the Kindle mobile/desktop app, and even then `percentageRead` is 0 here. The
`Source` seam keeps Kindle a later addition; no Kindle code exists in the
repo (the `PUT /state/amazon-cookies` route and `HABIT_ID_KINDLE` var were
removed after this was confirmed).

## HTTP API

All routes require `Authorization: Bearer <ADMIN_TOKEN>` except the Strava
OAuth callback.

| Route | Purpose |
|---|---|
| `POST /sync` (optional `?source=`) | Force a sync of all or one source |
| `GET /status` | Last run/result per source |
| `GET /strava/authorize` | Start one-time Strava OAuth |
| `GET /strava/callback` | Finish OAuth, seed refresh token into KV (validated by state param, not bearer) |

## Config & secrets

- Non-secret vars in `wrangler.toml`: `HABIT_ID_STRAVA`, `HABIT_ID_WAKATIME`,
  `TIMEZONE` (default `Europe/Berlin`; defines "today" for all sources and for
  Habitify target dates).
- Secrets: `HABITIFY_API_KEY`, `STRAVA_CLIENT_ID`, `STRAVA_CLIENT_SECRET`,
  `WAKATIME_API_KEY`, `ADMIN_TOKEN`.
- Local development uses `.dev.vars` (gitignored); production uses
  `wrangler secret put`. A committed `.dev.vars.example` documents every key.
- One KV namespace (`STATE`) for all mutable state: Strava tokens, per-source
  sync status.
- A source is `enabled` exactly when its required secrets/vars are present, so
  the public repo works with any subset of integrations configured.

## Idempotency & error handling

- Habitify's API appends logs, so upsert = undo today's logs for the habit
  (`POST /habits/{habitId}/logs/undo`), then `POST` the current total. Hourly
  reruns converge to the correct daily value.

  **2026-08-05 update:** Habitify's v1 API (`https://api.habitify.me`,
  `Authorization: <key>`, `DELETE /logs/{id}?from=&to=`) was retired; a live
  `GET /habits` call started returning 401. The client was rewritten against
  the authoritative v2 OpenAPI spec: base URL `https://api.habitify.me/v2`,
  auth header `X-API-Key`, and — since v2 has no range-delete for logs, only
  a per-log `DELETE /habits/{habitId}/logs/{logId}` with no way to list log
  ids — the upsert's delete step became `POST /habits/{habitId}/logs/undo`
  instead of a date-range `DELETE`. Also new in v2: each habit's own
  configured unit (from its first `goal.unit`) is looked up once per sync run
  and preferred over an integration's declared unit, since Habitify's unit
  symbols are a closed enum that doesn't include every semantic unit an
  integration might declare (e.g. Kindle's `"pages"`).

  **2026-08-05 correction — `logs/undo` observed to be a no-op:** the
  undo-then-post-total upsert above was live for less than a day before
  measurement showed it was silently inflating every habit's daily value on
  every hourly sync. Direct observation on the live worker: `POST
  /habits/{habitId}/logs/undo` returns `200` and changes nothing for a
  measurable log — despite the OpenAPI spec's description ("Remove all log
  entries for a habit on a specific date") — so each hourly run's "post the
  current total" step landed on top of the previous total instead of a
  cleared day. Confirmed by three habits inflating by exactly their true
  daily value on one manual sync (96→104, 1496→1683, 105→123).

  The fix replaces "undo, then post the total" with **convergence by
  difference**: once per run (not once per habit) the worker reads `GET
  /habits/journal` for today and takes each habit's `progress.current` as
  the authoritative value Habitify already holds. For each value it posts
  `target - current` — positive or negative, skipped entirely under a small
  epsilon — which converges the habit to `target` without ever needing a
  clear-the-day primitive. Habitify's log schema declares no minimum on a
  log's `value`, which is what makes posting a negative correction directly
  possible. `POST /habits/{habitId}/logs/undo` is kept only as a best-effort
  fallback for the rare case where Habitify rejects a negative post outright
  (any 4xx) — it is not trusted to succeed, since it was directly observed
  not to; the fallback undoes (whether or not that does anything), posts the
  full target, and records that the fallback path was taken so the next
  run's correction is debuggable rather than silent. A failed journal read
  is fatal for that run's writes (no fallback to posting a total), since a
  guessed "current" value reintroduces the exact inflation this fix removes.

  One consequence worth recording: because the worker no longer clears
  today's logs before writing, a manual entry made in the Habitify app for
  today is no longer wiped on the next run — it is instead **converged away
  from**, since the worker only sees Habitify's total and has no way to
  distinguish a manual entry from its own prior write.
- Per-source isolation via try/catch in the orchestrator; failures land in the
  status record, visible through `GET /status`.
- No retry queues or push notifications in v1 (YAGNI).

## Testing

Vitest with `@cloudflare/vitest-pool-workers`:

- Unit tests per source against mocked `fetch` using recorded real JSON shapes.
- Habitify client tests proving convergence-by-difference: positive and
  negative differences, the zero/epsilon no-request case, and the
  negative-post-rejected fallback to undo-then-post-total.
- Orchestrator test proving one throwing source does not stop the others and
  that status records are written, plus tests proving the journal is read
  once per run and that a failed journal read blocks writes without
  falling back to posting a total.

## Out of scope (v1)

- Historical backfill of past days.
- Notifications on failure.
- Any UI beyond the JSON status endpoint.
