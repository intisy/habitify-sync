# Strava without the API — design

Date: 2026-08-10

## Problem

Strava paywalled Standard-tier API access: new developers from 1 June 2026,
existing developers from 30 June 2026, at roughly $11.99/month. The `strava`
integration reads `GET /api/v3/athlete/activities` through an OAuth
application, so an unsubscribed deployment loses the source entirely.

This adds a second way to read the same activities — Strava's own web app,
authenticated by a captured browser session — and keeps the OAuth path working
for anyone who does subscribe.

## Scope

In scope: a second activity reader inside the existing `strava` integration,
its session-capture routes, and the file split that keeps both readers legible.

Out of scope: changing what the habit measures (still minutes of moving time
since local midnight), changing any other integration, and automating Strava
login from credentials.

## Approach

### Reader selection

One integration, two interchangeable readers behind a shared shape. Selection
is automatic and ordered, with no new setting to flip:

1. A web session stored at `strava:session` → **web reader**.
2. Otherwise `clientId` + `clientSecret` configured and `strava:tokens`
   present → **api reader** (existing behavior, unchanged).
3. Otherwise `AuthNeededError` naming both paths.

A captured session is always a deliberate act, so it takes precedence: that is
what makes migrating off the API a single `PUT`, with no configuration change
and no window where both paths are live.

### Shared activity shape

Both readers return the same normalized list, and neither sums anything:

```ts
interface StravaActivity {
  startedAt: number;         // epoch seconds, in the reader's own frame (see below)
  movingTimeSeconds: number;
}
```

Summing to minutes happens once, in `activities.ts`, so the two paths cannot
drift on the value actually written to Habitify.

### Web reader

`GET https://www.strava.com/athlete/training_activities?page=1&per_page=100`,
sending the captured `Cookie`, a browser `User-Agent`,
`Referer: https://www.strava.com/athlete/training`,
`X-Requested-With: XMLHttpRequest`, and
`Accept: text/javascript, application/json`.

The response is `{ models: [...] }`, newest activity first. One page of 100 is
far more than a single day needs, so there is no pagination. Every model on the
page is filtered against the day boundary rather than stopping at the first old
one — an activity added or edited out of order would otherwise truncate the
scan and silently undercount.

A 401 or 403 raises `AuthNeededError` (pointing at `PUT /strava/session`), not
a generic error, so `GET /status` reports `auth_needed` and `monitor.yml`
surfaces an expired cookie the same way it already surfaces an expired Kindle
cookie.

### The day boundary differs between readers

This is the one place the two readers legitimately diverge, and getting it
wrong is silent.

- The **api reader** passes `after=localMidnightEpochSeconds(timeZone, now)`
  and Strava filters server-side against each activity's true UTC start. This
  is correct and unchanged.
- The **web reader** filters client-side on `start_date_local_raw`, which is
  *naive local time rendered as an epoch* — already shifted by the athlete's
  UTC offset. Comparing it against `localMidnightEpochSeconds` would be wrong
  by exactly that offset, silently dropping or admitting early-morning
  activities.

So `time.ts` gains a sibling helper:

```ts
export function naiveLocalMidnightEpochSeconds(timeZone: string, now: Date): number {
  return Date.parse(`${todayInTimeZone(timeZone, now)}T00:00:00Z`) / 1000;
}
```

This is `localMidnightEpochSeconds` without the offset correction. It lives in
`time.ts` beside its sibling, not inside the web reader, so the two boundaries
are read and reviewed together.

Known limitation, documented as a gotcha rather than solved: `start_date_local_raw`
is local to *the activity's* timezone, not to the worker's `TIMEZONE`. An
activity recorded in a different timezone can land on the adjacent day near
midnight. Accepted — it affects only travel days, and correcting it would
require per-activity timezone data the payload is not guaranteed to carry.

### Defensive parsing and diagnostics

Strava's web JSON is undocumented and unversioned, so field names are read with
fallbacks: `moving_time_raw ?? moving_time`, and
`start_date_local_raw ?? start_date_local`. A model where neither resolves to a
finite number is **skipped**, never counted as zero — counting it as zero would
turn a parse failure into a plausible-looking low number.

Because a Strava-side rename and a genuine rest day both produce 0 minutes,
the returned `HabitValue.diagnostics` distinguishes them:

```ts
{
  reader: "web",
  activitiesSeen: number,      // models[] length
  activitiesCounted: number,   // parsed and within today
  fieldsMatched: { movingTime: string | null; startedAt: string | null },
}
```

`fieldsMatched` records which name each field actually resolved from on the
first parseable model (e.g. `"moving_time_raw"`), so a fallback quietly taking
over is visible before the primary name disappears entirely.

`activitiesSeen > 0` with `activitiesCounted === 0` is the parse-failure
signature, visible in `GET /status`. Diagnostics are never sent to Habitify.

The api reader carries `{ reader: "api" }` for symmetry, so `GET /status`
always answers "which path produced this number".

### Routes

Mirroring Kindle's session capture exactly, since that pattern is already
proven in this repo and already documented for operators:

| Route | Auth | Purpose |
|---|---|---|
| `PUT /strava/session` | `admin` | Body `{ cookie }`; stores `{ cookie, updatedAt }` at `strava:session` |
| `DELETE /strava/session` | `admin` | Clears the stored session |

Routes register automatically from the integration's `routes` array — no
change to `src/index.ts`.

### File split

`src/integrations/strava/index.ts` is ~200 lines; a second reader would push it
past 350 with two unrelated auth models interleaved. Split by responsibility:

| File | Contains |
|---|---|
| `index.ts` | The `Integration` object: settings, reader selection, route list |
| `api.ts` | OAuth token exchange/refresh, authorize/callback handlers, api reader (moved verbatim) |
| `web.ts` | Session capture handlers, web reader |
| `activities.ts` | `StravaActivity`, summing to minutes |

Tests split to match: `api.test.ts`, `web.test.ts`, `activities.test.ts`, with
`index.test.ts` keeping reader-selection and integration-level cases.

## Settings changes

`clientId` and `clientSecret` stop being `required`, since a web-session
deployment configures neither. They remain `secret`, so they stay
environment-only and never touch KV or the config API.

Consequence: `habitId` alone enables the integration, so a deployment with
`HABIT_ID_STRAVA` set but no credentials moves from `disabled` to
`auth_needed`, which `monitor.yml` treats as a failure. This matches Kindle
exactly — Kindle also requires only `habitId` and reports `auth_needed` until
its cookie is captured — so it is accepted for consistency rather than
special-cased.

This deployment is unaffected either way: `wrangler.toml` currently has
`HABIT_ID_STRAVA = ""`, so `strava` stays `disabled` until a habit id is set.

## Generated artifacts

Both are CI-enforced and must be regenerated in the same change:

- `scripts/settings-manifest.json` via `npm run generate:settings-manifest`
  (`test/settings-manifest.test.ts` fails on drift)
- the root README integrations block via
  `npm run generate:readme-integrations` (`test/readme-integrations.test.ts`
  fails on drift)

`src/integrations/strava/README.md` is hand-written and needs the new setup
path, routes, stored state, and gotchas.

## Testing

Every test drives an injected `fetchFn`; no test touches the network.

- **activities.ts** — summing, rounding, empty input.
- **Boundary** — `naiveLocalMidnightEpochSeconds` against a positive-offset
  zone (`Europe/Berlin`, both DST states) and a negative-offset zone, plus the
  regression that specifically distinguishes it from
  `localMidnightEpochSeconds`: an activity in the offset gap must be counted by
  one and not the other.
- **Web reader** — happy path; `moving_time` / `start_date_local` fallback
  names; a model with neither field skipped rather than zeroed; yesterday's
  activities excluded; 401/403 raising `AuthNeededError`; non-2xx raising a
  plain error; a non-array `models` raising rather than silently returning 0.
- **Reader selection** — session present picks web even when tokens exist;
  no session with tokens picks api; neither raises `AuthNeededError` naming
  both.
- **Routes** — `PUT` stores the cookie; `PUT` rejects a missing or non-string
  cookie with 400; `DELETE` clears; both reject without the admin token.
- **Regression** — the existing api-path tests keep passing unchanged after
  the move to `api.ts`.

## Risks

- **Unverified field names.** The exact `models[]` field names cannot be
  confirmed without a live logged-in session. Mitigated by the fallback names,
  the skip-don't-zero rule, and the diagnostics; confirmed on first real sync.
- **Undocumented endpoint.** Strava can change or gate
  `/athlete/training_activities` at any time, with no deprecation notice. The
  OAuth path remaining intact is the fallback.
- **Bot protection.** If Strava fronts the endpoint with a challenge, the
  reader gets HTML instead of JSON. Treated as an error with the status code
  and content type in the message, not a silent 0.
- **Terms of service.** This reads the operator's own account data for personal
  use. Strava's terms restrict automated access; the operator accepts that
  trade-off in choosing this path.
