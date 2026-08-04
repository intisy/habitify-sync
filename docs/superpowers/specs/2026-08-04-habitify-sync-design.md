# habitify-sync — Design

**Date:** 2026-08-04
**Status:** Approved
**Repo:** `F:\Documents\GitHub\web\habitify-sync` — public GitHub repository

## Purpose

A single TypeScript Cloudflare Worker that syncs daily metrics from external
services into Habitify habits:

- **Kindle** — pages read today
- **Strava** — minutes of activity published today
- **WakaTime** — minutes coded today

The design leaves integration of new apps open and cheap: one new source file,
one registry entry, its secrets.

## Decisions

| Decision | Choice |
|---|---|
| Kindle data source | Unofficial Amazon API (read.amazon.com reading insights, session cookies) |
| Logged values | Real quantities (pages, minutes), not check-ins |
| Trigger | Hourly Cloudflare cron + authenticated manual HTTP endpoint |
| Architecture | Single Worker, connector interface, KV for mutable state |
| Secrets | `.dev.vars` (gitignored) locally, `wrangler secret put` in production |

## Architecture

```
src/
  index.ts          worker entry: scheduled (hourly cron) + fetch (HTTP API)
  sync.ts           orchestrator: run all sources, isolate failures, record status
  habitify.ts       Habitify API client (upsert today's log per habit)
  state.ts          KV access (tokens, cookies, sync status)
  sources/
    types.ts        the Source interface — the extension point
    strava.ts
    wakatime.ts
    kindle.ts
```

### Extension point

```ts
interface Source {
  name: string;
  enabled(env: Env): boolean;            // true when its secrets/vars are set
  fetchToday(ctx: SourceContext): Promise<HabitValue[]>;
}

interface HabitValue {
  habitId: string;
  value: number;
  unit: string;                           // Habitify unit_type, e.g. "min"
}
```

`sync.ts` iterates a registry array of sources. Each source runs inside its own
try/catch; results are pushed to Habitify and a per-source status record (last
success time, last error) is written to KV. One broken source never blocks the
others.

**Adding a new app** = one file in `sources/` implementing `Source` + one
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

### Kindle

- Amazon session cookies stored in KV; rotated anytime via
  `PUT /state/amazon-cookies` — no redeploy when they expire.
- Data: the read.amazon.com reading-insights JSON endpoint behind the session
  cookies. The exact endpoint and response shape are captured via browser
  DevTools during implementation; value = pages read today.
- Expired/invalid cookies → the source reports `auth_needed` in its status
  record instead of failing the run.

## HTTP API

All routes require `Authorization: Bearer <ADMIN_TOKEN>` except the Strava
OAuth callback.

| Route | Purpose |
|---|---|
| `POST /sync` (optional `?source=`) | Force a sync of all or one source |
| `GET /status` | Last run/result per source, cookie freshness |
| `PUT /state/amazon-cookies` | Rotate Amazon session cookies |
| `GET /strava/authorize` | Start one-time Strava OAuth |
| `GET /strava/callback` | Finish OAuth, seed refresh token into KV (validated by state param, not bearer) |

## Config & secrets

- Non-secret vars in `wrangler.toml`: `HABIT_ID_KINDLE`, `HABIT_ID_STRAVA`,
  `HABIT_ID_WAKATIME`, `TIMEZONE` (default `Europe/Berlin`; defines "today" for
  all sources and for Habitify target dates).
- Secrets: `HABITIFY_API_KEY`, `STRAVA_CLIENT_ID`, `STRAVA_CLIENT_SECRET`,
  `WAKATIME_API_KEY`, `ADMIN_TOKEN`.
- Local development uses `.dev.vars` (gitignored); production uses
  `wrangler secret put`. A committed `.dev.vars.example` documents every key.
- One KV namespace (`STATE`) for all mutable state: Strava tokens, Amazon
  cookies, per-source sync status.
- A source is `enabled` exactly when its required secrets/vars are present, so
  the public repo works with any subset of integrations configured.

## Idempotency & error handling

- Habitify's API appends logs, so upsert = `DELETE` today's logs for the habit,
  then `POST` the current total. Hourly reruns converge to the correct daily
  value.
- Per-source isolation via try/catch in the orchestrator; failures land in the
  status record, visible through `GET /status`.
- No retry queues or push notifications in v1 (YAGNI).

## Testing

Vitest with `@cloudflare/vitest-pool-workers`:

- Unit tests per source against mocked `fetch` using recorded real JSON shapes.
- Habitify client test proving the delete-then-post upsert.
- Orchestrator test proving one throwing source does not stop the others and
  that status records are written.

## Out of scope (v1)

- Historical backfill of past days.
- Notifications on failure.
- Any UI beyond the JSON status endpoint.
