# habitify-sync

A Cloudflare Worker that runs on an hourly cron, reads today's totals from
connected services, and writes them into matching [Habitify](https://habitify.me)
habits. It also exposes a small authenticated HTTP API for triggering a sync
manually and checking status. It currently ships two sources: **Strava**
(activity minutes) and **WakaTime** (coding minutes).

## How it works

Each integration implements a small `Source` interface (see below) with a
`fetchToday` method that returns today's value(s). `src/sources/registry.ts`
lists the active sources; `src/sync.ts` iterates that list once per run
(hourly via cron, or on demand via `POST /sync`).

Each source runs inside its own `try`/`catch`, so one source failing (an
expired Strava token, a WakaTime outage) never blocks the others. After every
run, each source's outcome — success, error, or "needs re-auth" — is written
to a per-source status record in the `STATE` KV namespace, readable via
`GET /status`.

Habitify's log API only appends, so writing a value twice would double-count
it. To make hourly reruns idempotent, every write is an upsert: delete
today's existing logs for the habit, then post the current total. Rerunning
the same hour with the same source data converges to the same result.

## Setup

1. Clone the repo and install dependencies:

   ```bash
   git clone <repo-url>
   cd habitify-sync
   npm install
   ```

2. Create the KV namespace used for tokens and sync status, and paste the
   returned `id` into `wrangler.toml`:

   ```bash
   npx wrangler kv namespace create STATE
   ```

   The `id` committed in `wrangler.toml` (`0000000000000000000000000000000000000000`)
   is a placeholder. **It must be replaced with the real namespace id before
   the first deploy** — the worker will not read or write state correctly
   otherwise.

3. Find your Habitify habit ids and fill them into `wrangler.toml`
   (`HABIT_ID_STRAVA`, `HABIT_ID_WAKATIME`):

   ```bash
   curl -H "Authorization: <HABITIFY_API_KEY>" https://api.habitify.me/habits
   ```

   Make sure each habit's unit in Habitify is set to minutes — the worker
   always logs Strava and WakaTime values as minutes (`unit_type: "min"`).

4. Local development: copy `.dev.vars.example` to `.dev.vars` (already
   gitignored) and fill in real values, then:

   ```bash
   npm run dev
   ```

5. Production secrets — set each of these with `wrangler secret put`:

   ```bash
   npx wrangler secret put HABITIFY_API_KEY
   npx wrangler secret put STRAVA_CLIENT_ID
   npx wrangler secret put STRAVA_CLIENT_SECRET
   npx wrangler secret put WAKATIME_API_KEY
   npx wrangler secret put ADMIN_TOKEN
   ```

   `ADMIN_TOKEN` should be a long random string, not a memorable password —
   it's the bearer token for the entire HTTP API. Generate one with:

   ```bash
   openssl rand -hex 32
   ```

6. Deploy:

   ```bash
   npm run deploy
   ```

## Connecting each service

**WakaTime** — grab your API key from
[wakatime.com/settings/api-key](https://wakatime.com/settings/api-key) and
set it as `WAKATIME_API_KEY`.

**Strava** — create an API application at
[strava.com/settings/api](https://www.strava.com/settings/api). Set its
**Authorization Callback Domain** to the worker's own domain (e.g.
`habitify-sync.<your-subdomain>.workers.dev`, or your custom domain if you've
mapped one). Then, once `STRAVA_CLIENT_ID`/`STRAVA_CLIENT_SECRET` are set and
the worker is deployed, open:

```
https://<worker-url>/strava/authorize?token=<ADMIN_TOKEN>
```

in a browser and approve the consent screen. This is a one-time step — the
resulting refresh token is stored in the `STATE` KV namespace. Strava rotates
the refresh token every time it's used, so the worker automatically persists
the new one back to KV after every refresh; you never need to repeat this
step unless Strava revokes access.

## HTTP API

| Route | Auth | Purpose |
|---|---|---|
| `POST /sync` (optional `?source=strava\|wakatime`) | Bearer token | Force a sync of all sources, or just one |
| `GET /status` | Bearer token | Last run outcome per source |
| `GET /strava/authorize` | Bearer token **or** `?token=` query param | Start the one-time Strava OAuth flow |
| `GET /strava/callback` | None (validated by OAuth `state` param) | Finishes the OAuth exchange; Strava redirects here |

Every route requires `Authorization: Bearer <ADMIN_TOKEN>` **except**
`GET /strava/callback`, which is called directly by Strava's redirect (it
can't attach a header) and is instead validated against a one-time `state`
value stored in KV during `/strava/authorize`.

The `?token=` query-string fallback works **only** on `GET /strava/authorize`,
because that route is meant to be opened directly in a browser, where an
`Authorization` header can't be attached. It is deliberately not honored
anywhere else — query strings leak into access logs, proxy logs, and browser
history, so every other route requires the header.

Examples:

```bash
curl -X POST "https://<worker-url>/sync" \
  -H "Authorization: Bearer $ADMIN_TOKEN"

curl -X POST "https://<worker-url>/sync?source=wakatime" \
  -H "Authorization: Bearer $ADMIN_TOKEN"

curl "https://<worker-url>/status" \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

## Adding a new integration

The `Source` interface is the extension point (`src/sources/types.ts`):

```ts
export interface Source {
  name: string;
  enabled(env: Env): boolean;
  fetchToday(context: SourceContext): Promise<HabitValue[]>;
}
```

There are two recipes, and they are not the same size.

**Simple key-based source** (an API-key integration like WakaTime):

- [ ] New file in `src/sources/` implementing `Source`
- [ ] One entry added to `SOURCES` in `src/sources/registry.ts`
- [ ] Its secret/config keys added to `Env` in `src/sources/types.ts`
- [ ] Those keys added to `.dev.vars.example` (with dummy values)
- [ ] A `HABIT_ID_<SOURCE>` var added to `wrangler.toml`
- [ ] A test modeled on `test/sources/wakatime.test.ts`

**OAuth source** (like Strava) — everything above, plus:

- [ ] An authorize route in `src/index.ts` (redirects to the provider's
      consent screen, stashes a CSRF `state` value in KV)
- [ ] A callback route in `src/index.ts` (validates `state`, exchanges the
      code, persists tokens)
- [ ] Token storage and shape added to `src/state.ts`

Strava's implementation touches all of those files (`src/index.ts`,
`src/state.ts`, `src/sources/types.ts`, `src/sources/strava.ts`,
`src/sources/registry.ts`, `wrangler.toml`, `.dev.vars.example`), so an OAuth
integration is **not** a one-file change — budget for it accordingly.

## Operational notes / gotchas

- **The worker owns its habits.** Every sync deletes today's existing logs
  for a habit before posting the new total. Any manual entry you add for
  today in the Habitify app will be wiped on the next hourly run.

- **Timezone.** `TIMEZONE` (default `Europe/Berlin`) defines what "today"
  means for the worker — it's used both to pick the day boundary for Strava
  activities and as the target date when writing to Habitify. WakaTime,
  however, resolves its own `start`/`end` query dates using whatever
  timezone is set on your WakaTime account, independent of the worker's
  `TIMEZONE`. If the two don't match, values will be off near midnight in
  either zone. Set your WakaTime account timezone to match `TIMEZONE`.

- **Strava callback domain.** Strava allows exactly one Authorization
  Callback Domain per API application. Run `/strava/authorize` from the
  exact host you registered — a `*.workers.dev` host and a custom domain
  mapped to the same worker are not interchangeable. Using the wrong one
  produces an opaque error from Strava, not a helpful one from this worker.

- **`GET /status` is the only failure signal.** There are no notifications
  of any kind. A source that needs re-authorization (e.g. Strava refused a
  refresh token) reports `"state": "auth_needed"`. Other failures report
  `"state": "error"` with a `lastError` message. A source whose required
  secrets aren't set reports `"state": "disabled"`.

- **The upsert isn't atomic.** If the DELETE of today's logs succeeds but
  the following POST fails, today's value is left empty in Habitify until
  the next hourly run repairs it.

- **Resetting wedged credentials.** There is no HTTP route to clear stored
  tokens. If Strava auth gets stuck, delete the stored tokens directly and
  re-run the authorize flow:

  ```bash
  npx wrangler kv key delete --namespace-id=<id> "strava:tokens"
  ```

  Then open `/strava/authorize` again.

- **Missing `HABITIFY_API_KEY`.** Every source reports `"state": "error"`
  with the message `"HABITIFY_API_KEY is not configured"` rather than
  failing silently or retrying forever.

- **Dev-only npm advisories.** `npm audit` reports high-severity advisories
  in the `wrangler`/Miniflare dev toolchain (devDependencies only). The
  worker itself ships with zero runtime dependencies — nothing from those
  packages is included in what's deployed.

## Kindle

Planned, not implemented. Amazon exposes no page-count data reachable with
session cookies for this use case: the reading-insights endpoint returns
only streaks, `percentageRead` is always `0`, and the endpoints that carry
actual reading position and page data return 403. See the design doc's
["Kindle — Not implemented"](docs/superpowers/specs/2026-08-04-habitify-sync-design.md#kindle--not-implemented)
section for the full probe results.

## Development

```bash
npm test         # vitest run, using @cloudflare/vitest-pool-workers with a real KV binding
npm run typecheck # tsc --noEmit
npm run dev       # wrangler dev
npm run deploy    # wrangler deploy
```
