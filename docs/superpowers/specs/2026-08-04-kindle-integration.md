# Kindle integration — Design

**Date:** 2026-08-04
**Status:** Approved — implementation proceeds ahead of live verification
**Supersedes:** the "Kindle — Not implemented" section of
`2026-08-04-habitify-sync-design.md`

## What changed since Kindle was dropped

The earlier conclusion — "no page data reachable" — was correct about the
endpoints tried, but wrong about the reason `startReading` failed. Research
plus re-probing established:

- `read.amazon.com` and its APIs respond for this account (the earlier
  "Website Temporarily Unavailable" was incidental; `/`, `/notebook`, and
  `/kindle-library` all return 200 now).
- `GET /service/web/reader/getFileUrl` returns a *validation* error, not an
  auth error, proving the browser session is accepted by the reader service
  family.
- `startReading` returns 403 `"not an ADP session request"` because it needs
  an **ADP session token**, which the Cloud Reader obtains from
  `/service/web/register/getDeviceToken` using a `serialNumber`/`deviceType`
  pair that Amazon's own JavaScript mints for the session. The earlier 403 on
  that endpoint came from passing invented values.
- `startReading` is the only surface that returns reading position
  (`lastPageReadData.position`) together with `pageNumberUrl` — a
  position→printed-page map — and `metadataUrl`
  (`startPosition`/`endPosition`).

So pages-read is reachable, gated on one credential the user must capture
once from their browser.

## Metric definition

Habitify receives **pages read today**, unit `pages`, into `HABIT_ID_KINDLE`.

Per book, the integration tracks a page number derived from the Whispersync
position. Pages read today = sum over books of
`max(0, currentPage - baselinePage)`, where the baseline is the position
snapshot taken at the first sync of the current local day.

Page derivation, in order of preference:

1. **`pageNumberUrl` map** — when the book exposes one, positions map to real
   printed page numbers. This is the authoritative case.
2. **Percentage of a known page count** — when `metadataUrl` gives
   `startPosition`/`endPosition` and the book has a page count, page =
   `percentage × pageCount`.
3. **Position estimate** — page = `position / POSITIONS_PER_PAGE`
   (var, default `1400`, roughly one printed page of prose). Values derived
   this way are estimates; the status record marks them as such.

Only books whose position advanced are counted, so finishing and reopening
books cannot subtract.

## Credentials and state

Two pieces of user-supplied state, both in KV, both replaceable over HTTP
without a redeploy:

| KV key | Contents |
|---|---|
| `kindle:session` | `{ cookie, deviceSerialNumber, deviceType, updatedAt }` |
| `kindle:positions` | `{ date, pages: { [asin]: number }, estimated: boolean }` |

`kindle:session` holds the Amazon `Cookie` header string plus the captured
device pair. The integration is `enabled` when `HABIT_ID_KINDLE` is set; it
reports `auth_needed` (not `error`) whenever the session is absent, expired,
or rejected, so `GET /status` tells the operator to re-capture.

An ADP session token is fetched per sync from `getDeviceToken` and used as the
`x-adp-session-token` header. It is short-lived and deliberately not cached.

## Routes

| Route | Purpose |
|---|---|
| `PUT /kindle/session` | Store `{ cookie, deviceSerialNumber, deviceType }` (admin auth) |
| `DELETE /kindle/session` | Clear the stored session (admin auth) |

Both are contributed by the integration through the `Integration.routes` seam,
so no generic file changes.

## Sync flow

1. Read `kindle:session`; absent → `AuthNeededError`.
2. `GET /service/web/register/getDeviceToken?serialNumber=…&deviceType=…` with
   the cookie → `deviceSessionToken`. A 4xx here means the capture is stale →
   `AuthNeededError`.
3. `GET /kindle-library/search?query=&libraryType=BOOKS&sortType=recency&querySize=50`
   with the cookie → the book list.
4. For each book, `GET /service/mobile/reader/startReading?asin=…&clientVersion=20000100`
   with the cookie and `x-adp-session-token` → position and the page-mapping
   URLs. A book that fails individually is skipped, not fatal.
5. Derive each book's current page per the rules above.
6. Compare against `kindle:positions`. If its `date` is not today, today's
   baseline becomes the *current* readings and today's total is 0 — a fresh
   baseline cannot retroactively invent progress.
7. Write back the snapshot and return the summed pages.

## Failure modes

| Situation | `GET /status` |
|---|---|
| No session captured | `auth_needed` — "capture the Kindle session" |
| Cookie or device pair rejected | `auth_needed` — re-capture |
| Library reachable but every book fails | `error` naming the last failure |
| First sync of a day | `ok`, value `0` (baseline established) |

## Verification gate

The endpoint shapes are confirmed from two independent reverse-engineering
sources, but this account's `startReading` has never returned 200. The
integration therefore ships behind its `enabled()` check with unit tests
against the documented payload shapes, and the live contract is confirmed
only once a real capture exists. If `startReading` proves to need a
TLS-fingerprint the Workers runtime cannot produce, that is a hard blocker
recorded here rather than worked around.

## Out of scope

- Reading minutes (no endpoint exposes them).
- Personal documents. The account's active reading is a PDOC, and
  `libraryType` accepts only `BOOKS`, so PDOC progress stays unreachable
  through this path; the streak endpoint remains the only PDOC signal.
- Any flow requiring the account password, 2FA, or ADP RSA request signing.
