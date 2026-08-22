# habit-sync — multi-destination redesign

Date: 2026-08-22

Supersedes the single-destination architecture in
`2026-08-04-habitify-sync-design.md`.

## Problem

The worker is reusable across *sources* (four integrations behind one
`Integration` interface) but hard-wired to exactly one *destination*. Habitify
is baked into six files:

| File | Coupling |
|---|---|
| `habitify.ts` | The whole client: closed unit vocabulary, habit CRUD, journal read, convergence-by-difference write |
| `sync.ts` | Constructs `HabitifyClient`, hard-checks `HABITIFY_API_KEY`, performs Habitify unit coercion and convergence |
| `integrations/types.ts` | `HabitValue { habitId, value, unit }` |
| `settings.ts` | `HABIT_ID_DESCRIPTOR` implicit on every integration; `deriveVariableName` special-cases `habitId` |
| `index.ts` | `/habits`, `/journal` routes; `HABITIFY_API_KEY` on `Env` |
| `state.ts` | `HabitConvergence` |

The root cause is that **sources name their destination**. `fetchToday`
returns a `habitId`, so every integration is bound to one Habitify account.
No second destination is possible without changing every source.

## Goals

- A source and a destination are both just *apps*: self-contained directories
  that declare their own config and reach the core only through one explicit
  host interface.
- The core knows nothing about habits, Habitify, Habitica, or any source. The
  only wiring is `registry.ts`.
- Adding a destination is the same size of job as adding a source, and touches
  no existing app.
- Two destinations ship, so the abstraction is verified rather than assumed.

## Non-goals

- Separate deployables. This stays one Worker, one cron, one KV namespace, one
  deploy. Isolation is enforced by the host interface, not by the network.
- Changing what any existing source measures.
- A core-level pairing table between sources and destinations.

## Naming

The project is renamed from `habitify-sync` to **`habit-sync`** — no vendor in
the name, and consistent with the sibling repos (`wakatime-sync`,
`sync-bridge`).

The Cloudflare Worker is renamed too, which is a live migration with an
ordered set of steps; see [Migration](#migration).

## Architecture

```
src/
  core/
    types.ts       Source, Destination, Measurement, AppHost, AppRoute
    host.ts        Builds the AppHost handed to one app
    settings.ts    SettingsResolver — no habitId, no special cases
    state.ts       ScopedState, status records, KV helpers
    router.ts      Route table assembly + auth (extracted from index.ts)
    sync.ts        The loop
    time.ts
  apps/
    strava/        source
    wakatime/      source
    kindle/        source
    keybr/         source
    habitify/      destination
    habitica/      destination
  registry.ts      SOURCES + DESTINATIONS — the only wiring in the codebase
  index.ts         Worker entry: fetch + scheduled
```

`src/integrations/` becomes `src/apps/`, because sources and destinations are
now the same kind of thing and there is no reason to separate them by folder.

### The host API

This is the "endpoints in the main application" an app is allowed to use. An
app receives an `AppHost` and has access to nothing else — notably **not
`Env`**, so no app can read another app's variables, the admin token, or the
raw KV binding.

```ts
export interface AppHost {
  /** Scoped to this app: getString("apiKey") resolves HABITICA_API_KEY, and
      throws for a key this app never declared. */
  readonly settings: SettingsResolver;
  /** Scoped to this app: every key is transparently prefixed "<app>:". */
  readonly state: ScopedState;
  readonly timeZone: string;
  /** Local date, YYYY-MM-DD. */
  readonly today: string;
  readonly now: Date;
  readonly fetchFn: typeof fetch;
}

export interface ScopedState {
  get<T>(key: string): Promise<T | null>;
  put(key: string, value: unknown, options?: { expirationTtlSeconds?: number }): Promise<void>;
  delete(key: string): Promise<void>;
}
```

`ScopedState` replaces every hand-written `*_STATE_KEYS` object. Apps stop
composing raw KV keys, so two apps cannot collide and neither can read the
other's state — by construction rather than by convention.

### Source

```ts
export interface Measurement {
  /** Set only when a source emits more than one series; the single-series
      case omits it. Destinations key their targets on the source name plus
      this. */
  metric?: string;
  value: number;
  /** The semantic unit the source thinks in ("min", "pages"). Free-form:
      mapping it onto a destination's own vocabulary is that destination's job. */
  unit: string;
  /** Surfaced by GET /status. Never sent to any destination. */
  diagnostics?: Record<string, unknown>;
}

export interface Source {
  name: string;
  settings: SettingDescriptor[];
  fetchToday(host: AppHost): Promise<Measurement[]>;
  routes?: AppRoute[];
}
```

`Measurement` carries no destination identity. That single deletion is what
makes the rest possible.

### Destination

```ts
export interface Destination {
  name: string;
  settings: SettingDescriptor[];
  /** Which source names this destination has a configured target for. The
      core holds no pairing table: a destination returning [] is simply
      inactive, and enabling "strava -> habitica" means adding a target to
      habitica's own config and nothing else. */
  targetedSources(host: AppHost): Promise<string[]>;
  /** Write one source's measurements. Throwing AuthNeededError records
      auth_needed; any other throw records error. */
  write(host: AppHost, sourceName: string, measurements: Measurement[]): Promise<WriteReport>;
  routes?: AppRoute[];
}

export interface WriteReport {
  /** Whatever this destination wants GET /status to show. Its own shape. */
  diagnostics?: Record<string, unknown>;
}
```

`targetedSources` is what lets the core skip a source nothing consumes — no
Strava request at all when no destination targets it.

## Configuration model

Two deletions from `settings.ts`, and nothing added:

1. `HABIT_ID_DESCRIPTOR`, and `settingsForIntegration`'s implicit append of
   it, are removed. An app declares every setting it has.
2. `deriveVariableName` loses its `habitId` branch and becomes unconditional
   `<APP>_<KEY_AS_SCREAMING_SNAKE>`.

A destination's source-to-target mapping is therefore **module-private**, and
each destination may choose its own representation. Both shipped destinations
choose a single `json` setting, which needs no core extension and which
preflight already validates generically as parseable JSON:

```toml
HABITIFY_TARGETS = '{"strava":"-OzG0...","kindle":"-OzDy...","keybr":"-OzGm..."}'
HABITICA_TARGETS = '{"strava":"a1b2c3d4-..."}'
```

`targetedSources` is `Object.keys` of that map. This is the concrete reason
none of the core-level mapping schemes were right: the question was never the
core's to answer.

Every existing `HABIT_ID_*` variable disappears; see
[Migration](#migration).

## Sync loop

```
1. enabledDestinations = destinations whose required settings all resolve
2. wanted = union of targetedSources() across enabledDestinations
3. for each source in wanted that is itself enabled:
       measurements[source] = await source.fetchToday(host)   -> source status
4. for each enabled destination:
       for each source it targets that read successfully:
           await destination.write(host, source, measurements[source])
                                                              -> dest status
```

Each source is read **once per run** regardless of how many destinations
consume it. A source that fails to read is skipped for every destination, and
a destination's write failure is isolated to that destination.

Both loops keep the existing per-app `try`/`catch` discipline: one app failing
never blocks another.

## Status model

Read failures and write failures are different problems with different fixes,
so they are recorded separately:

| KV key | Meaning |
|---|---|
| `status:source:<source>` | Could this source be read? |
| `status:dest:<dest>:<source>` | Could this destination be written for that source? |

```jsonc
// GET /status
{
  "sources":      { "strava": { "state": "ok", ... } },
  "destinations": { "habitify": { "strava": { "state": "ok", ... } },
                    "habitica": { "strava": { "state": "auth_needed", ... } } }
}
```

`monitor.yml` must be updated to walk both maps; it currently walks a flat
object and would silently see zero failures against the new shape. The
existing "name the unhealthy sources" annotation gains the destination name,
so an alert says which half broke.

Old flat `status:<name>` keys are orphaned, not migrated. `GET /status` already
surfaces keys that outlive their app, so they stay visible until deleted.

## Destination: habitify

Everything Habitify-specific moves out of the core into `apps/habitify/`,
unchanged in behavior:

- The closed unit vocabulary and `isHabitifyUnitSymbol`, plus the
  habit-unit-wins-over-source-unit resolution and the `"rep"` last resort.
- Convergence-by-difference, including the negative-post undo fallback. This
  is a workaround for Habitify's accumulating log API and belongs to Habitify
  alone.
- The once-per-run `listHabits` and journal reads, which stay once per run —
  now memoized on the destination for the duration of its own write pass
  rather than hoisted into the global loop.
- `/habits`, `/journal`, and habit creation become destination-contributed
  routes at `/habitify/habits` and `/habitify/journal`, exactly as sources
  already contribute routes.

`HABITIFY_API_KEY` already matches the derived-name rule and is unchanged.

## Destination: habitica

Chosen because its semantics differ from Habitify in exactly the places the
new interface abstracts, which is what makes it a real test rather than a
second copy:

- **No unit vocabulary at all.** Habitica habits are counters; `unit` is
  ignored entirely. This proves unit handling belongs to the destination.
- **Scoring, not setting.** There is no "set today's total". Writing N means
  `POST /api/v3/tasks/:taskId/score/up` N times, which proves the write
  strategy belongs to the destination.

Settings: `HABITICA_USER_ID` and `HABITICA_API_TOKEN` (both secret),
`HABITICA_TARGETS` (json), `HABITICA_MAX_SCORES_PER_RUN` (number, default 100).

**The required `x-client` header.** Since late July 2025 Habitica rejects any
authenticated request that omits `x-client`, formatted `<UserID>-<appname>`. It
is sent on every request, built from `HABITICA_USER_ID` and the literal app
name. Omitting it is a hard rejection, not a degradation, so it is covered by
its own test.

**Convergence without a verified counter field.** Habitica's per-task
day-counter field could not be confirmed against a live account, so
convergence deliberately does not depend on it. Instead the destination
records what it has already posted today in its own scoped state:

```ts
// habitica's own state, key "postedToday"
{ date: "2026-08-22", posted: { "strava": 30 } }
```

Each run scores up `target - alreadyPosted` times (never negative), then
updates the record; a new local day resets the baseline. This keeps
convergence correct using only writes whose semantics are documented, and it
is a second, independent demonstration that a destination owns its own state.

**Score-count cap.** A target of N means N HTTP requests, so a runaway or
misconfigured source could flood a rate-limited API. Scores per source per run
are capped (default 100); hitting the cap is reported in
`WriteReport.diagnostics` rather than silently truncating. A 429 raises a plain
error, so the run reports it and the next hourly run resumes from the recorded
baseline.

## Isolation, and how it is enforced

Three mechanisms, in decreasing strictness:

1. **The interface.** An app receives only `AppHost`. `Env`, the raw
   `KVNamespace`, and `ADMIN_TOKEN` are unreachable from app code.
2. **Scoped resolvers.** `settings` throws for an undeclared key; `state`
   prefixes every key. Neither can be pointed at another app.
3. **A test.** `test/isolation.test.ts` reads every file under `src/apps/` and
   fails on an import that escapes its own app directory, other than
   `../../core/types`. This is what keeps the boundary from eroding, since
   nothing else would notice a stray relative import.

## Migration

Config, in `wrangler.toml`:

| Remove | Add |
|---|---|
| `HABIT_ID_STRAVA`, `HABIT_ID_WAKATIME`, `HABIT_ID_KINDLE`, `HABIT_ID_KEYBR` | one `HABITIFY_TARGETS` json map carrying the same ids |

Secrets are unchanged for Habitify (`HABITIFY_API_KEY`, `ADMIN_TOKEN`); two new
ones for Habitica, and only if it is configured at all.

Worker rename, in order — this is a live deployment and the steps are not
interchangeable:

1. Deploy under the new name (`name = "habit-sync"`). KV state carries over
   because the namespace is referenced by id, not by worker.
2. Re-put both existing secrets on the new worker: `wrangler secret put`
   writes per-worker, so the new worker starts with none.
3. Update the `WORKER_URL` repository variable to the new
   `habit-sync.<subdomain>.workers.dev`.
4. Verify `GET /status`, then one `POST /sync`, against the new URL.
5. **Delete the old worker.** Until it is deleted its hourly cron keeps
   running, and both workers write to the same habits, double-counting every
   value.

Step 5 is the one with a real failure mode, so it is called out separately in
the README rather than buried in a list.

## Testing

The existing 276 tests are the safety net for a refactor this size, so they are
migrated rather than rewritten: each source's tests keep their assertions and
change only how the context is built (`AppHost` instead of `SourceContext`),
and the Habitify tests move to `apps/habitify/` intact. Every
behavior-preserving move must pass its old assertions unchanged.

New tests:

- **Host** — `settings` throws for an undeclared key; `state` prefixes reads,
  writes, and deletes; two apps using the same logical key do not collide.
- **Sync loop** — a source nothing targets is never fetched; a source is
  fetched once and reused for two destinations; a source read failure skips
  both destinations and records only source status; one destination's write
  failure leaves the other's status `ok`.
- **Status** — both maps populate; a destination failure does not mark the
  source unhealthy.
- **habitica** — target resolution from the json map; N scores for a target of
  N; the posted-today baseline suppressing re-posting on a second run the same
  day; a new local day resetting it; the cap reporting rather than truncating
  silently; `x-client` present on every request; 401 raising `AuthNeededError`
  and 429 raising a plain error.
- **Isolation** — the cross-app import check described above.

## Risks

- **Size.** This restructures every file in `src/`. Sequenced so each phase
  ends green, with behavior-preserving moves proven by their original
  assertions.
- **Live deployment.** The double-write window during the worker rename is the
  sharpest edge. Mitigated by ordering and an explicit README step.
- **Unverified Habitica API.** The endpoint and auth headers are documented,
  but nothing here is confirmed against a live account. Convergence
  deliberately avoids the one field that could not be confirmed, and
  `WriteReport.diagnostics` reports what was actually posted.
- **monitor.yml.** If the status shape changes without the workflow being
  updated in the same change, monitoring silently passes forever. It gets its
  own task.

## Phasing

Each phase ends with a green suite and is independently committable.

1. **Core extraction** — `src/core/`, `AppHost`, `ScopedState`; no behavior
   change, Habitify still called directly by `sync.ts`.
2. **Config model** — remove the implicit `habitId` and the
   `deriveVariableName` special case; sources stop returning habit ids.
3. **Destination interface** — introduce `Destination`, move Habitify behind
   it, rewrite the sync loop, split the status model, update `monitor.yml`.
4. **Habitica** — the second destination, proving the interface.
5. **Rename and docs** — `habit-sync` everywhere, regenerate artifacts, the
   migration runbook.
