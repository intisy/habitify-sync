# habitify-sync

A Cloudflare Worker that runs on an hourly cron, reads today's totals from
connected services, and writes them into matching [Habitify](https://habitify.me)
habits. It also exposes a small authenticated HTTP API for triggering a sync
manually and checking status.

Each integration below is linked to its own README (what it logs, setup,
gotchas). The settings table under each one — including every environment
variable name and which ones are secret — is generated straight from the
registry; see [Configuration model](#configuration-model). This block is
regenerated with `npm run generate:readme-integrations` and a test fails CI
if it ever drifts from the live registry, so it never needs hand-editing.

<!-- integrations:start -->

### [strava](src/integrations/strava/README.md)

| Key | Derived variable | Type | Required | Secret | Default | Description |
|---|---|---|---|---|---|---|
| `clientId` | `STRAVA_CLIENT_ID` | string | yes | yes | — | Strava OAuth application client id, from strava.com/settings/api. |
| `clientSecret` | `STRAVA_CLIENT_SECRET` | string | yes | yes | — | Strava OAuth application client secret, from strava.com/settings/api. |
| `habitId` | `HABIT_ID_STRAVA` | string | yes | no | — | Habitify habit id this integration logs into. |

### [wakatime](src/integrations/wakatime/README.md)

| Key | Derived variable | Type | Required | Secret | Default | Description |
|---|---|---|---|---|---|---|
| `apiKey` | `WAKATIME_API_KEY` | string | yes | yes | — | WakaTime API key, from wakatime.com/settings/api-key. |
| `habitId` | `HABIT_ID_WAKATIME` | string | yes | no | — | Habitify habit id this integration logs into. |

### [kindle](src/integrations/kindle/README.md)

| Key | Derived variable | Type | Required | Secret | Default | Description |
|---|---|---|---|---|---|---|
| `wordsPerPage` | `KINDLE_WORDS_PER_PAGE` | number | no | no | `250` | Words per printed page, used only when no printed page count is available at all. |
| `pageCounts` | `KINDLE_PAGE_COUNTS` | json | no | no | — | Optional override mapping asin -> printed page count, for a book whose printed page count Amazon's own product page won't yield. |
| `positionsPerPage` | `KINDLE_POSITIONS_PER_PAGE` | number | no | no | `1800` | Whispersync positions per printed page, a last-resort fallback when a book's word count is unavailable. |
| `habitId` | `HABIT_ID_KINDLE` | string | yes | no | — | Habitify habit id this integration logs into. |

### [keybr](src/integrations/keybr/README.md)

| Key | Derived variable | Type | Required | Secret | Default | Description |
|---|---|---|---|---|---|---|
| `publicId` | `KEYBR_PUBLIC_ID` | string | yes | no | — | Public profile id from keybr.com/profile/{id}. Not a secret. |
| `habitId` | `HABIT_ID_KEYBR` | string | yes | no | — | Habitify habit id this integration logs into. |

<!-- integrations:end -->

## Forking this

This is a personal deployment, in daily use by its owner. The committed
`wrangler.toml` intentionally holds the **maintainer's own real deployment
values** — a real KV namespace id and real Habitify habit ids — rather than
placeholders. None of that is a secret: it's useless to anyone without the
maintainer's Cloudflare account and Habitify API key, so committing it costs
nothing and gives you a concrete, working example to read instead of a wall
of placeholder text.

If you fork this repo to run your own copy, replace the following before you
deploy:

| What | Replace with |
|---|---|
| The `[[kv_namespaces]]` `id` in `wrangler.toml` | Your own namespace: `npx wrangler kv namespace create STATE` |
| `TIMEZONE` in `wrangler.toml` | Your own IANA timezone (the committed default, `Europe/Berlin`, is the maintainer's) |
| The two global secrets — `HABITIFY_API_KEY`, `ADMIN_TOKEN` | Your own values, each set with `wrangler secret put <NAME>` — see [Setup](#setup) step 5 |
| Every per-integration var and secret (each `HABIT_ID_*`, `KEYBR_PUBLIC_ID`, `STRAVA_CLIENT_ID`/`STRAVA_CLIENT_SECRET`, `WAKATIME_API_KEY`, and so on) | See the settings table under each integration [above](#habitify-sync) — or the live, current values on your own deployed worker at `GET /config` |

`npm run preflight` catches most of a missed replacement — an empty or
invalid `TIMEZONE`, a wrongly-typed setting (non-numeric where a `number` is
declared, unparseable `KINDLE_PAGE_COUNTS` JSON), an integration that's
half-configured (a habit id set without its other required vars, or vice
versa) — before it becomes a rejected deploy or a silently `"disabled"`
source. It validates every integration's declared settings generically, off
a generated manifest (`scripts/settings-manifest.json`) rather than a
hand-written list — see [Configuration model](#configuration-model). It
cannot check any secret's value, since those live only in Cloudflare, never
in a file preflight can read.

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

## Configuration model

Every setting an integration accepts — a habit id, a secret, a plain var — is
declared once, in that integration's own file, as a `SettingDescriptor` (see
`src/integrations/types.ts`):

```ts
{ key: "wordsPerPage", type: "number", default: "250", description: "..." }
```

Nothing else is hand-written from there:

- **The environment variable name is derived, never written down twice.** It's
  `<INTEGRATION>_<KEY_AS_SCREAMING_SNAKE>` — `kindle`'s `wordsPerPage` becomes
  `KINDLE_WORDS_PER_PAGE`. Every integration also implicitly gets a `habitId`
  setting (no need to declare it), which reverses the pattern to
  `HABIT_ID_<INTEGRATION>` to match the vars this worker has always used.
- **Resolution** goes KV override → environment (`wrangler.toml` var or
  secret) → the descriptor's `default`, highest precedence first. Integrations
  read their own settings through a resolver (`context.settings.getString(...)`
  / `getNumber(...)` / `getJson(...)`) rather than touching `env` directly, so
  a setting can never be read under a name nobody declared.
- **Secrets are environment-only.** A setting marked `secret: true` never
  reads from KV, is never returned by the config API, and is never settable
  through it — only `wrangler secret put` (production) or `.dev.vars` (local)
  ever set one.
- **`enabled()` is derived, not authored.** An integration is enabled when
  every `required` setting (its own declarations plus the implicit `habitId`)
  resolves to a non-empty value — computed the same way for every
  integration, in one place (`src/settings.ts`).

`GET /config` is the live, always-current source of truth for what every
integration accepts and how each setting currently resolves — see
[HTTP API](#http-api) below. It's generated straight from the declarations
above, so it can never go stale the way a hand-written table would.

Each integration runs inside its own `try`/`catch`, so one integration
failing (an expired Strava token, a WakaTime outage) never blocks the
others. After every run, each integration's outcome — success, error, or
"needs re-auth" — is written to a per-integration status record in the
`STATE` KV namespace, readable via `GET /status`.

Habitify's log API only appends, so writing a value twice would double-count
it. To make hourly reruns idempotent without double-counting, every write is
a **convergence by difference**: once per run (not once per habit) the
worker reads `GET /habits/journal` for today and notes what Habitify already
holds for each habit (`progress.current`). For each value, it computes
`difference = target - current` and posts that difference — positive or
negative — instead of the total. Because logs accumulate, posting the
difference converges the habit to exactly `target`. If the difference is
effectively zero (within a small epsilon), **no request is made at all** —
a quiet hour costs zero writes. A habit that doesn't appear in today's
journal is treated as holding `0`, so its full target is posted.

This replaced an earlier "undo today's logs, then post the total" upsert.
That approach depended on `POST /habits/{habitId}/logs/undo`, which the
OpenAPI spec describes as clearing every log entry for a habit on a given
date — but on the live worker it was observed to return 200 while changing
nothing for measurable logs, silently inflating every habit's value on
every hourly sync. Convergence-by-difference doesn't call that endpoint at
all in the normal case: Habitify's log schema declares no minimum on a
log's `value`, so a negative difference is posted directly to bring an
over-counted value back down. `POST .../logs/undo` is retained only as a
best-effort **fallback** for the rare case where Habitify rejects a
negative post outright (any 4xx): the worker calls undo, then posts the
full target, and records in `GET /status` that the fallback path was used
— since undo may still do nothing, in which case the next run's difference
simply corrects it again. See
[Operational notes](#operational-notes--gotchas) for what this means for
manual edits.

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

2. `wrangler.toml` as committed in this repo holds the **maintainer's own**
   deployment values — a real KV namespace id and real Habitify habit ids,
   not placeholders (see [Forking this](#forking-this) for why that's safe
   to commit). If you're forking this repo rather than just reading it,
   create your own KV namespace and paste the returned `id` into
   `wrangler.toml` in place of the maintainer's:

   ```bash
   npx wrangler kv namespace create STATE
   ```

   The worker will not read or write state correctly until this points at a
   namespace in your own Cloudflare account.

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
   (`HABIT_ID_STRAVA`, `HABIT_ID_WAKATIME`, `HABIT_ID_KINDLE`,
   `HABIT_ID_KEYBR`). Before the first deploy, the only option is a direct
   call using your
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
   one-time Amazon cookie capture it needs instead. Leave `HABIT_ID_KEYBR`
   or `KEYBR_PUBLIC_ID` blank to leave the keybr integration disabled;
   neither is a secret, so both live in `wrangler.toml`'s `[vars]` — see
   [its README](src/integrations/keybr/README.md#setup) for where to find
   the public id.

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
- **[keybr setup](src/integrations/keybr/README.md#setup)**

## HTTP API

| Route | Auth | Purpose |
|---|---|---|
| `POST /sync` (optional `?source=strava\|wakatime\|kindle\|keybr`) | `admin` | Force a sync of all integrations, or just one |
| `GET /status` | `admin` | Last run outcome per integration |
| `GET /habits` | `admin` | List Habitify habit ids/names/units, for filling into `wrangler.toml` |
| `GET /habits?raw=1` | `admin` | Same route, untrimmed — full Habitify habit objects (scheduling, area, time-of-day, archived flag, etc.), for diagnosing what Habitify actually stores versus what the app displays |
| `POST /habits` | `admin` | Create a new Habitify habit, so one exists to log into before `wrangler.toml` is filled in |
| `GET /journal` (optional `?date=YYYY-MM-DD`) | `admin` | The day-by-day journal view Habitify's own app renders for a date, for diagnosing what Habitify actually stores versus what the app displays |
| `GET /config` | `admin` | Every integration's settings: value, source (`kv`/`env`/`default`), default, type, description — secrets redacted to `configured: true\|false` |
| `GET /config/<integration>` | `admin` | Same, for one integration |
| `PUT /config/<integration>` | `admin` | Merge KV overrides into an integration's settings — body is a JSON object of key → string value. Rejects unknown keys and secret keys, and validates `number`/`json` typed values, each with a clear error naming what's allowed |
| `DELETE /config/<integration>` (optional `?key=`) | `admin` | Clear all of an integration's KV overrides, or just one with `?key=` |
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

curl "https://<worker-url>/config/keybr" \
  -H "Authorization: Bearer $ADMIN_TOKEN"

curl -X PUT "https://<worker-url>/config/keybr" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"publicId": "your-new-id"}'

curl -X DELETE "https://<worker-url>/config/keybr?key=publicId" \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

## Adding a new integration

The `Integration` interface is the extension point
(`src/integrations/types.ts`):

```ts
export interface Integration {
  name: string;
  settings: SettingDescriptor[];
  fetchToday(context: SourceContext): Promise<HabitValue[]>;
  routes?: IntegrationRoute[];
}
```

Declaring `settings` (see [Configuration model](#configuration-model) above)
is what replaced most of this checklist: there's no `Env` field to add, no
`enabled()` to write, and nothing to register in preflight — all three are
now derived from the declaration itself. Adding or removing an integration
means adding or removing its directory plus one registry line:

- [ ] New directory `src/integrations/<name>/` with an `index.ts`
      implementing `Integration` — declare its `settings` (its own vars;
      `habitId` is implicit, never declared per integration), add a
      `routes` array only if it needs HTTP endpoints of its own (an OAuth
      authorize/callback pair, say), and declare any KV keys it owns right
      there in the same file
- [ ] One entry added to `INTEGRATIONS` in `src/integrations/registry.ts`
- [ ] Its non-secret settings' derived vars added to `wrangler.toml`'s
      `[vars]` if you want a committed default; any *secret* setting added
      to `.dev.vars.example` with a dummy value, so `npm run dev` has
      something to read locally
- [ ] Run `npm run generate` (or the two `generate:*` scripts separately)
      and commit the result, so `npm run preflight` validates the new
      settings and this README's generated integrations block (the top of
      this file, between the `<!-- integrations:start -->` /
      `<!-- integrations:end -->` markers) both pick it up — neither is
      hand-edited
- [ ] If it contributes `routes`, a row per route added to this README's
      [HTTP API](#http-api) table, and a link to its README added to
      [Connecting each service](#connecting-each-service) — skip this
      entirely if it has no routes of its own
- [ ] Colocated tests in `src/integrations/<name>/index.test.ts`
- [ ] A `README.md` in the same directory, following the six-section
      structure the existing integrations use (what it logs, configuration,
      setup, routes, stored state, gotchas)

No other file needs to change — `src/index.ts` builds its route table and
its `/config/*` routes from `INTEGRATIONS`, and it, `src/state.ts`, and
`src/sync.ts` hold no integration-specific knowledge.

## Continuous integration, monitoring, and deploy

Four pieces of automation live under `.github/`:

- **`npm run preflight`** (`scripts/preflight.mjs`) statically checks
  `wrangler.toml` before you deploy: that the `STATE` KV `id` is present and
  isn't the old placeholder, that `TIMEZONE` (if set) is a zone `Intl`
  recognizes, and — generically, off `scripts/settings-manifest.json` (see
  [Configuration model](#configuration-model)) — that every declared
  `number` setting parses as a number, every declared `json` setting parses
  as JSON, and each integration has its habit id and every other required
  var set together rather than half-configured (a habit id with no
  `KEYBR_PUBLIC_ID`, say). It cannot check secrets — those live only in
  Cloudflare, never in a file preflight can read. The manifest itself is
  generated (`npm run generate:settings-manifest`) and kept honest by
  `test/settings-manifest.test.ts`, which fails if it ever drifts from what
  `src/integrations/registry.ts` currently declares. This README's own
  generated integrations block (`npm run generate:readme-integrations`,
  checked by `test/readme-integrations.test.ts`) is kept honest the same way.
- **Check** (`.github/workflows/check.yml`) runs `npm run typecheck`,
  `npm test`, and `npm run preflight` on every push to `main` and on every
  pull request. Needs no repository secrets or variables.
- **Dependabot** (`.github/dependabot.yml`) opens a monthly npm dependency
  update PR. `wrangler`, `@cloudflare/*`, and `vitest` are grouped into a
  single PR rather than three, because that trio has broken installs here
  before with conflicting peer ranges — one PR that CI can prove installs
  and passes together beats three that each half-satisfy the others.
- **Monitor** (`.github/workflows/monitor.yml`) calls `GET /status` daily at
  07:00 UTC and fails the run (which GitHub emails to the repo owner) if any
  source reports `"error"` or `"auth_needed"` — e.g. after the Kindle cookie
  or a Strava refresh token expires. `GET /status` is otherwise a pull-only
  endpoint with no notifications of its own; this turns it into a push. It
  needs, in your fork's repository settings:
  - a repository **variable** `WORKER_URL` — your deployed worker's base URL
  - a repository **secret** `ADMIN_TOKEN` — the same value you set with
    `wrangler secret put ADMIN_TOKEN`

  If either is missing, the job logs a message and exits successfully
  instead of failing, so a fork that hasn't wired up monitoring yet doesn't
  show a false-red workflow.
- **Deploy** (`.github/workflows/deploy.yml`) runs the typecheck and test
  suite, then preflight, then `npx wrangler deploy` — but only on a manual
  `workflow_dispatch`, triggered from the Actions tab, never on push or on
  merge to `main`. This worker is somebody's daily habit tracking; a bad
  merge auto-deploying on push would silently overwrite a live, working
  worker with no human review gate in between.

  This workflow is **entirely optional**. Deploying from your own machine with
  `npm run deploy` needs no API token at all — `wrangler login` holds an OAuth
  session locally. A token exists only because a CI runner has no browser to
  complete that login with. Skip this workflow unless you specifically want to
  deploy from the Actions tab; the worker and every other workflow are
  unaffected. If you do want it, add in your fork's repository settings:
  - a repository secret `CLOUDFLARE_API_TOKEN` (Cloudflare → My Profile → API
    Tokens → **Edit Cloudflare Workers** template)
  - a repository secret `CLOUDFLARE_ACCOUNT_ID` (kept as a secret and
    supplied via the workflow's `env`, rather than committed to
    `wrangler.toml`, so the account id stays out of a public repository)

  Without the token the workflow stops at a preflight step with a message
  saying exactly this, rather than failing on an opaque Wrangler auth error.

Set repository secrets and variables under **Settings → Secrets and
variables → Actions** in your fork.

## Operational notes / gotchas

- **The worker converges its habits toward the synced value.** Every sync
  reads what Habitify already holds for today (`GET /habits/journal`) and
  posts only the difference to reach the source's true value — see
  [How it works](#how-it-works). This is a behavior change worth stating
  plainly: **a manual entry you add for today in the Habitify app is no
  longer wiped** the way it was under the old undo-then-post-total upsert;
  instead it is **corrected back toward the synced value** on the next
  hourly run, since the worker only knows the source's total and Habitify's
  current total, not which part of that total was a manual entry.

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

- **A failed journal read blocks writes for that run, on purpose.** The
  worker needs to know what Habitify currently holds before it can compute a
  safe difference to post. If `GET /habits/journal` fails, nothing is
  written for any source that run — falling back to posting the full total
  is exactly the accumulation bug convergence-by-difference replaced. Each
  affected source reports `"state": "error"` with a `lastError` naming the
  journal failure; a missed hour self-corrects the next time the journal
  read succeeds.

- **The negative-post fallback isn't atomic.** If Habitify rejects a
  negative-difference post and the fallback's `logs/undo` call succeeds but
  the following full-total POST fails, today's value is left at whatever
  undo left it (likely unchanged, since undo was observed to be a no-op for
  measurable logs) until the next hourly run repairs it.

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
npm test                              # vitest run, using @cloudflare/vitest-pool-workers with a real KV binding
npm run typecheck                     # tsc --noEmit
npm run preflight                     # validate wrangler.toml — see Continuous integration, monitoring, and deploy
npm run generate                      # regenerate both generated artifacts below after changing any integration's settings
npm run generate:settings-manifest    #   just scripts/settings-manifest.json
npm run generate:readme-integrations  #   just this README's generated integrations block
npm run dev                           # wrangler dev
npm run deploy                        # preflight, then wrangler deploy
```
