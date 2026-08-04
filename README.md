# habitify-sync

A Cloudflare Worker that runs on an hourly cron, reads today's totals from
connected services, and writes them into matching [Habitify](https://habitify.me)
habits. It also exposes a small authenticated HTTP API for triggering a sync
manually and checking status. It currently ships two integrations:

- **[Strava](src/integrations/strava/README.md)** — activity minutes
- **[WakaTime](src/integrations/wakatime/README.md)** — coding minutes
- **[Kindle](src/integrations/kindle/README.md)** — pages read, unverified against a live account

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
   (`HABIT_ID_STRAVA`, `HABIT_ID_WAKATIME`, `HABIT_ID_KINDLE`):

   ```bash
   curl -H "Authorization: <HABITIFY_API_KEY>" https://api.habitify.me/habits
   ```

   Make sure each habit's unit in Habitify matches what the worker logs:
   minutes for Strava and WakaTime, pages for Kindle. Leave `HABIT_ID_KINDLE`
   blank to leave that integration disabled — see its README for why it
   ships unverified.

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

- **The worker owns its habits.** Every sync deletes today's existing logs
  for a habit before posting the new total. Any manual entry you add for
  today in the Habitify app will be wiped on the next hourly run.

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

- **The upsert isn't atomic.** If the DELETE of today's logs succeeds but
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
