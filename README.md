# habitify-sync

A Cloudflare Worker that runs on an hourly cron, reads today's totals from
connected services, and writes them into matching [Habitify](https://habitify.me)
habits. It also exposes a small authenticated HTTP API for triggering a sync
manually and checking status. It currently ships three integrations:

- **[Strava](src/integrations/strava/README.md)** — activity minutes
- **[WakaTime](src/integrations/wakatime/README.md)** — coding minutes
- **[Kindle](src/integrations/kindle/README.md)** — pages read, derived from Amazon's own word-count endpoint (exact using a printed page count discovered automatically from the book's Amazon product page, otherwise a words-per-page estimate)

## How it works

Each integration implements the `Integration` interface (see
`src/integrations/types.ts`), whose `fetchToday` method returns today's
value(s). `src/integrations/registry.ts` lists the active integrations;
`src/sync.ts` iterates that list once per run (hourly via cron, or on demand
via `POST /sync`).

An integration can also contribute HTTP routes (for an OAuth handshake, for
example) and its own KV state, entirely inside its own directory —
`src/index.ts` and `src/state.ts` hold no integration-specific knowledge. See
[Adding a new integration](#adding-a-new-integration) below.

Each integration runs inside its own `try`/`catch`, so one integration
failing (an expired Strava token, a WakaTime outage) never blocks the
others. After every run, each integration's outcome — success, error, or
"needs re-auth" — is written to a per-integration status record in the
`STATE` KV namespace, readable via `GET /status`.

Habitify's log API only appends, so writing a value twice would double-count
it. To make hourly reruns idempotent, every write is an upsert: undo today's
existing logs for the habit (Habitify v2 has no range-delete for logs, only
per-log delete by id with no way to list log ids, so `POST .../logs/undo` is
the primitive instead — see [Operational notes](#operational-notes--gotchas)),
then post the current total. Rerunning the same hour with the same source
data converges to the same result.

Habitify only accepts logs against its own closed set of unit symbols (see
`HABITIFY_UNIT_SYMBOLS` in `src/habitify.ts`), which doesn't include every
unit an integration might declare (Kindle declares `"pages"`, which isn't a
Habitify unit). So the worker looks up each habit's own configured unit once
per sync run and prefers it over the integration's declared unit whenever
it's present and valid — falling back to the integration's unit, and finally
to `"rep"` (the generic count unit), only when the habit has no usable unit
of its own. This means **a Habitify habit's configured unit does not need to
match the integration's semantic unit** — configure the habit however you
like (e.g. `"rep"` for Kindle pages) and the worker adapts automatically. Any
fallback is recorded per-source and visible in `GET /status`.

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

3. Each integration needs a Habitify habit to log into. Create one either in
   the Habitify app itself, or — once the worker is deployed and
   `HABITIFY_API_KEY` is set — via `POST /habits` (see
   [HTTP API](#http-api) below), which provisions it without the key ever
   leaving Cloudflare. Either way, if you give the habit a measurable goal,
   its `unit` must be one of Habitify's own unit symbols (see
   `HABITIFY_UNIT_SYMBOLS` in `src/habitify.ts`) — notably there is **no**
   `pages` unit, so a page-counting habit (e.g. for Kindle) should use `rep`
   instead. If Habitify's response body to the creation itself can't be
   parsed, the worker confirms the write by re-reading the habit list instead
   of reporting a failure, so a `POST /habits` error should still be checked
   against `GET /habits` before retrying.

   Find your Habitify habit ids and fill them into `wrangler.toml`
   (`HABIT_ID_STRAVA`, `HABIT_ID_WAKATIME`, `HABIT_ID_KINDLE`). Before the
   first deploy, the only option is a direct call using your
   `HABITIFY_API_KEY` locally (requires a paid Habitify subscription — the
   API is not available on the free plan):

   ```bash
   curl -H "X-API-Key: <HABITIFY_API_KEY>" https://api.habitify.me/v2/habits
   ```

   Once the worker is deployed (step 6) and `HABITIFY_API_KEY` is set as a
   secret (step 5), you can instead let the worker look habit ids up for
   you, so the key never has to leave Cloudflare or be handled locally:

   ```bash
   curl "https://<worker-url>/habits" -H "Authorization: Bearer $ADMIN_TOKEN"
   ```

   Either way, fill the resulting ids into `wrangler.toml` and redeploy. Each
   habit's unit in Habitify does **not** need to match what the worker logs
   — the worker discovers each habit's own configured unit automatically and
   prefers it (see [How it works](#how-it-works)). Leave `HABIT_ID_KINDLE`
   blank to leave that integration disabled — see its README for the
   one-time Amazon cookie capture it needs instead.

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

Each integration's own README documents where to get its secrets and any
one-time setup steps (OAuth consent, callback domains, and the like):

- **[Strava setup](src/integrations/strava/README.md#setup)**
- **[WakaTime setup](src/integrations/wakatime/README.md#setup)**
- **[Kindle setup](src/integrations/kindle/README.md#setup)**

## HTTP API

| Route | Auth | Purpose |
|---|---|---|
| `POST /sync` (optional `?source=strava\|wakatime\|kindle`) | `admin` | Force a sync of all integrations, or just one |
| `GET /status` | `admin` | Last run outcome per integration |
| `GET /habits` | `admin` | List Habitify habit ids/names/units, for filling into `wrangler.toml` |
| `POST /habits` | `admin` | Create a new Habitify habit, so one exists to log into before `wrangler.toml` is filled in |
| `GET /strava/authorize` | `admin-or-query-token` | Start the one-time Strava OAuth flow ([details](src/integrations/strava/README.md#routes)) |
| `GET /strava/callback` | `public` | Finishes the Strava OAuth exchange ([details](src/integrations/strava/README.md#routes)) |
| `PUT /kindle/session` | `admin` | Store the captured Kindle session ([details](src/integrations/kindle/README.md#routes)) |
| `DELETE /kindle/session` | `admin` | Clear the stored Kindle session ([details](src/integrations/kindle/README.md#routes)) |

Every route requires `Authorization: Bearer <ADMIN_TOKEN>` **except** routes
declared `public` (currently only `GET /strava/callback`, called directly by
Strava's redirect, which can't attach a header — it's instead validated
against a one-time `state` value stored in KV).

The `?token=` query-string fallback is honored only on routes declared
`admin-or-query-token` — meant for routes opened directly in a browser,
where an `Authorization` header can't be attached. It is deliberately not
honored on plain `admin` routes: query strings leak into access logs, proxy
logs, and browser history.

Examples:

```bash
curl -X POST "https://<worker-url>/sync" \
  -H "Authorization: Bearer $ADMIN_TOKEN"

curl -X POST "https://<worker-url>/sync?source=wakatime" \
  -H "Authorization: Bearer $ADMIN_TOKEN"

curl "https://<worker-url>/status" \
  -H "Authorization: Bearer $ADMIN_TOKEN"

curl -X POST "https://<worker-url>/habits" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name": "Read", "goal": {"periodicity": "daily", "value": 10, "unit": "rep"}}'
```

## Adding a new integration

The `Integration` interface is the extension point
(`src/integrations/types.ts`):

```ts
export interface Integration {
  name: string;
  enabled(env: Env): boolean;
  fetchToday(context: SourceContext): Promise<HabitValue[]>;
  routes?: IntegrationRoute[];
}
```

Adding or removing an integration means adding or removing its directory
plus one registry line — the same recipe whether it's a plain key-based
integration or one with its own OAuth routes and KV state:

- [ ] New directory `src/integrations/<name>/` with an `index.ts`
      implementing `Integration` (add a `routes` array only if it needs
      HTTP endpoints of its own — an OAuth authorize/callback pair, say —
      and declare any KV keys it owns right there in the same file)
- [ ] One entry added to `INTEGRATIONS` in `src/integrations/registry.ts`
- [ ] Its secret/config keys added to `Env` in `src/integrations/types.ts`
- [ ] Those keys added to `.dev.vars.example` (with dummy values)
- [ ] A `HABIT_ID_<NAME>` var added to `wrangler.toml`
- [ ] Colocated tests in `src/integrations/<name>/index.test.ts`
- [ ] A `README.md` in the same directory, following the six-section
      structure the existing integrations use (what it logs, configuration,
      setup, routes, stored state, gotchas)

No other file needs to change — `src/index.ts` builds its route table from
`INTEGRATIONS` plus its own core routes, and it, `src/state.ts`, and
`src/sync.ts` hold no integration-specific knowledge.

## Operational notes / gotchas

- **The worker owns its habits.** Every sync undoes today's existing logs
  for a habit (`POST /habits/{habitId}/logs/undo`) before posting the new
  total. Any manual entry you add for today in the Habitify app will be
  wiped on the next hourly run.

- **Habitify API v2.** The worker talks to `https://api.habitify.me/v2`
  using an `X-API-Key` header (the retired v1 API used
  `Authorization: <key>` with no `/v2` prefix and no `X-API-Key` header —
  requests against it now fail with 401). API access requires a paid
  Habitify subscription; it is not available on the free plan.

- **Habit units are resolved automatically, not hardcoded.** Habitify only
  accepts a closed set of unit symbols, and an integration's own semantic
  unit (Kindle's `"pages"`) may not be one of them. Once per sync run the
  worker looks up every habit's own configured unit and prefers it over the
  integration's declared unit; falling back to the integration's unit (if
  valid) or `"rep"` only when the habit has no usable unit of its own. Any
  fallback is recorded in that source's `GET /status` entry under
  `unitFallbacks`.

- **Timezone.** `TIMEZONE` (default `Europe/Berlin`) defines what "today"
  means for the worker — it's used both to pick the day boundary for Strava
  activities and as the target date when writing to Habitify. See each
  integration's README for how it handles (or doesn't handle) its own
  timezone — WakaTime in particular resolves `start`/`end` using its own
  account timezone, independent of this var.

- **`GET /status` is the only failure signal.** There are no notifications
  of any kind. An integration that needs re-authorization (e.g. Strava
  refused a refresh token) reports `"state": "auth_needed"`. Other failures
  report `"state": "error"` with a `lastError` message. An integration whose
  required secrets aren't set reports `"state": "disabled"`.

- **The upsert isn't atomic.** If the undo of today's logs succeeds but
  the following POST fails, today's value is left empty in Habitify until
  the next hourly run repairs it.

- **Resetting wedged credentials.** There is no HTTP route to clear stored
  tokens. Each integration's README documents its own KV keys and the
  `wrangler kv key delete` command to clear them (see, e.g.,
  [Strava's stored state](src/integrations/strava/README.md#stored-state)).

- **Missing `HABITIFY_API_KEY`.** Every integration reports
  `"state": "error"` with the message `"HABITIFY_API_KEY is not configured"`
  rather than failing silently or retrying forever.

- **Dev-only npm advisories.** `npm audit` reports high-severity advisories
  in the `wrangler`/Miniflare dev toolchain (devDependencies only). The
  worker itself ships with zero runtime dependencies — nothing from those
  packages is included in what's deployed.

## Development

```bash
npm test         # vitest run, using @cloudflare/vitest-pool-workers with a real KV binding
npm run typecheck # tsc --noEmit
npm run dev       # wrangler dev
npm run deploy    # wrangler deploy
```
