# Kindle integration — Design

**Date:** 2026-08-04
**Status:** Verified live against a real Amazon account
**Supersedes:** the earlier draft of this document, which predates
verification and got several details wrong (see "What changed" below).

## What changed since the last draft

The integration was reworked after live verification against a real
account, on the `kindle-verified` branch. The corrections:

- **The critical missing header was `x-amzn-sessionid`.** Both
  `getDeviceToken` and `startReading` return 403
  `"The given request is not an ADP session request"` without it, and 200
  with it. Its value is the `session-id` cookie's value, promoted to a
  request header — Amazon's own JavaScript does this for the session, and
  the cookie header alone (no matter how complete) is not sufficient.
- **The device serial/type pair is a constant, not a per-user capture.**
  `A2CTZ977SKFQZY` is used as both `serialNumber` and `deviceType` in
  `getDeviceToken` — it identifies the Kindle Cloud Reader itself, not the
  account or a physical device. The earlier draft assumed these had to be
  captured from the user's own browser session; they don't, and the user no
  longer supplies them at all.
- **`pageNumberUrl` (and `fragmentMapUrl`/`manifestUrl`) were absent on every
  book tested.** The earlier draft treated a printed-page map as the
  authoritative, commonly-available tier. In practice it's opportunistic at
  best — kept as a best-effort path, but never assumed.
- **`metadataUrl` returns JSONP, not JSON** — a bare function-call wrapper
  like `loadMetadata({...});` that must be unwrapped before parsing. The
  parsed body's `startPosition`/`endPosition` are real and verified across
  three books (Deep Work `3/456177`, The C Programming Language `3/563246`,
  the ESV Bible `3/6960680`), giving progress fractions of ~1.8%, ~42%, and
  ~75% respectively when computed as
  `(position - startPosition) / (endPosition - startPosition)`.
- **`percentageRead`, from the library endpoint, is useless.** It returns `0`
  for every book regardless of actual progress — verified live. It plays no
  part in any metric now.
- **Personal documents return `lastPageReadData: null`.** This was
  previously assumed but unconfirmed; it's now verified, explaining why
  Send-to-Kindle documents (e.g. manga) can't be tracked through this path.
  A book with `position: -1` (never opened) is the same kind of "nothing to
  track" case.
- **Stored session state dropped the device pair.** `kindle:session` is now
  `{ cookie, updatedAt }` only.

## Metric definition

Habitify receives **pages read today**, unit `pages`, into `HABIT_ID_KINDLE`.

Per book, the integration tracks its Whispersync *position* (not a derived
page number) as the day's baseline. Pages read today = sum over books of
`max(0, pagesSinceBaseline)`, where `pagesSinceBaseline` is derived from the
position delta since the baseline, not from subtracting two independently
rounded per-sync page numbers:

1. **`pageNumberUrl` map** (opportunistic best-effort; absent on every book
   verified so far) — when present and parseable, both the baseline and
   current position are looked up in the same map, and the page-index
   difference is used directly. Not marked as an estimate.
2. **Position estimate** — `positionDelta / POSITIONS_PER_PAGE` (var,
   default `1800`; grounded in three verified books, working out to roughly
   1500, 2070, and 5600 positions per page respectively — prose vs. dense
   reference material). This is the practical default for every book tested
   so far, and is marked `estimated: true`.

A book's own progress fraction — `(position - startPosition) / (endPosition -
startPosition)`, clamped to `[0, 1]` — is computed separately from
`metadataUrl` purely for `GET /status` diagnostics; it has no part in the
pages metric.

Only books whose position advanced past their baseline contribute, so
finishing and reopening a book cannot subtract from the total.

## Credentials and state

Two pieces of user-supplied state, both in KV, both replaceable over HTTP
without a redeploy:

| KV key | Contents |
|---|---|
| `kindle:session` | `{ cookie, updatedAt }` |
| `kindle:positions` | `{ date, positions: { [asin]: number }, estimated: boolean }` |

`kindle:session` holds only the Amazon `Cookie` header string — no device
identifiers, since the device pair is now a hardcoded constant
(`A2CTZ977SKFQZY`). The integration is `enabled` when `HABIT_ID_KINDLE` is
set; it reports `auth_needed` (not `error`) whenever the session is absent,
the cookie has no `session-id`, or `getDeviceToken` rejects it, so
`GET /status` tells the operator to re-capture.

An ADP session token is fetched per sync from `getDeviceToken` and used as
the `x-adp-session-token` header on `startReading`. It is short-lived and
deliberately not cached.

## Routes

| Route | Purpose |
|---|---|
| `PUT /kindle/session` | Store `{ cookie }` (admin auth). A body still carrying the old `deviceSerialNumber`/`deviceType` fields is accepted for backward compatibility and ignored. |
| `DELETE /kindle/session` | Clear the stored session (admin auth) |

Both are contributed by the integration through the `Integration.routes`
seam, so no generic file changes.

## Sync flow

1. Read `kindle:session`; absent → `AuthNeededError`. Extract `session-id`
   from the cookie; absent → `AuthNeededError`.
2. `GET /service/web/register/getDeviceToken?serialNumber=A2CTZ977SKFQZY&deviceType=A2CTZ977SKFQZY`
   with the cookie and `x-amzn-sessionid` → `deviceSessionToken`. A 4xx, or a
   200 with no usable token field, means `AuthNeededError`.
3. `GET /kindle-library/search?query=&libraryType=BOOKS&sortType=recency&querySize=50`
   with the same headers → the book list. A 401/403 here means `AuthNeededError`
   too — the cookie can still be rejected at this step even though
   `getDeviceToken` just succeeded.
4. For each book, `GET /service/mobile/reader/startReading?asin=…&clientVersion=20000100`
   with the cookie, `x-amzn-sessionid`, and `x-adp-session-token` →
   `lastPageReadData` (position) plus, opportunistically, `pageNumberUrl` and
   `metadataUrl`. `lastPageReadData: null` or `position: -1` → skip silently.
   A book that fails outright (non-2xx or thrown error) is skipped, not
   fatal, unless every book in the library fails.
5. Merge this sync's positions into the day's baseline: a book with no
   existing baseline (new day, or first sighting today) records its current
   position as its own baseline and contributes 0; an existing baseline is
   never advanced except by writing the merged result back at the end.
6. For books with an existing baseline, derive `pagesSinceBaseline` per the
   rules above and sum them.
7. Write back `kindle:positions` (every sync, so a fresh mid-day baseline
   persists) and return the summed pages.

## Failure modes

| Situation | `GET /status` |
|---|---|
| No session captured | `auth_needed` |
| Cookie lacks `session-id` | `auth_needed` |
| `getDeviceToken` rejects the cookie, or returns no usable token | `auth_needed` |
| Library search (`/kindle-library/search`) rejects the cookie with 401/403 — the cookie can go stale between the two calls even though `getDeviceToken` just succeeded | `auth_needed` |
| A personal document, or a never-opened book | skipped silently — not an error, not counted |
| One book's `startReading` fails | that book is skipped; the sync still succeeds |
| Every book's `startReading` fails | `error`, naming the last failure |
| First sync of a day | `ok`, value `0` (baseline established) |

## Verification gate

**Verified live**, against a real Amazon account:

- `x-amzn-sessionid` is required on `getDeviceToken` and `startReading`, and
  its absence is what caused every prior 403.
- The device pair is the constant `A2CTZ977SKFQZY`, not a per-account value.
- `getDeviceToken` returns `deviceSessionToken` (confirmed, ~1481 characters).
- `startReading` returns 200 with the documented field set, including
  `lastPageReadData` (or `null` for a personal document).
- `pageNumberUrl`, `fragmentMapUrl`, and `manifestUrl` were absent on every
  book tested.
- `metadataUrl` returns JSONP wrapping `startPosition`/`endPosition`,
  confirmed against three books.
- `percentageRead` is always `0`, regardless of actual progress.

**Not yet verified:**

- This integration has never run inside a deployed Cloudflare Worker — only
  against the live Amazon API from outside that runtime. Cloudflare's
  outbound TLS fingerprint may differ from a desktop browser's in a way that
  changes how Amazon's edge treats the request (rate limiting, bot
  detection, or an outright block). The first real deploy is the first real
  test of that variable.
- Long-term cookie lifetime and how often `session-id` actually needs
  re-capture in practice — only observed over a short verification window.
- Whether any book in a larger library ever does expose `pageNumberUrl`; the
  opportunistic tier remains implemented but unexercised against a real
  positive case.

## Out of scope

- Reading minutes (no endpoint exposes them).
- Personal documents. `startReading` returns `lastPageReadData: null` for
  them, verified live, so their progress stays unreachable through this
  path.
- Any flow requiring the account password, 2FA, or ADP RSA request signing.
