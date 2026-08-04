# Kindle integration — Design

**Date:** 2026-08-04 (word-count mechanism added same day, after the initial
Whispersync-position verification pass; dynamic page-count discovery added
same day again, after live-verifying the product-page endpoint)
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
- **Printed page counts are now discovered automatically, not hand-configured.**
  The exact `print-pages` tier's printed-page-count input used to require an
  operator to maintain `KINDLE_PAGE_COUNTS` (asin → page count) by hand for
  every book. Verified live: the printed page count is present, unauthenticated,
  on the book's own public Amazon product page — see "Amazon exposes printed
  page counts on the public product page" below. `KINDLE_PAGE_COUNTS` is kept,
  but demoted to an optional override for when that discovery fails.

## Metric definition

Habitify receives **pages read today**, unit `pages`, into `HABIT_ID_KINDLE`.

Per book, the integration tracks its Whispersync *position* (not a derived
page number) as the day's baseline. Only books whose position advanced past
their baseline contribute, so finishing and reopening a book cannot subtract
from the total, and a book that hasn't moved costs no extra requests (no
`wordCount` call is made for it at all).

### Amazon exposes real word counts per position range

Verified live against a real account:

```
GET https://read.amazon.com/renderer/wordCount
    ?asin=<asin>
    &revision=<contentVersion from startReading>
    &contentType=FullBook
    &startPosition=<int>
    &endPosition=<int>        (optional)
```

Headers: the same cookie and `x-amzn-sessionid` as every other call, plus
`x-amz-rendering-token: <karamelToken.token from startReading>`. Response:
`{"wordCount": <integer>}`.

`startPosition` is required — omitting it is a 400 naming `startPosition` in
the validation error. Omitting `endPosition` returns the word count from
`startPosition` through the end of the book, so `startPosition=0` with no
`endPosition` is the whole book's word count.

Measured for `B009ZUZ9FW` (contentVersion `e2e02ac4`, position `238526`):

| Call | Result |
|---|---|
| `startPosition=0` (whole book) | 98651 |
| `startPosition=238526`, no `endPosition` (words remaining) | 55560 |
| `startPosition=0&endPosition=238526` (words in that range) | 43090 |

`43090 + 55560 = 98650 ≈ 98651` — the range semantics are additive and
consistent (off by one, likely a rounding or boundary-word artifact,
immaterial to the metric).

`startReading` supplies both inputs `wordCount` needs: `contentVersion` (used
as `revision`) and `karamelToken`. `karamelToken`'s shape is only partly
confirmed — observed as a plain object with a `.token` string field — so it's
handled defensively as either that shape or a bare string, never assumed.

### Amazon exposes printed page counts on the public product page

Verified live with a plain `curl` — no authentication, no cookies:

```
GET https://www.amazon.com/dp/<asin>
    (browser User-Agent, Accept-Language: en-US,en;q=0.9, --compressed)
```

Returns `200` (roughly 340 KB of HTML) containing the printed page count in
the product's detail bullets. Observed markup fragments:

```
Print length: 279 pages" href="javascript:void(0)" role="button" class="a-popover-trigger a-
Print length: 305 pages" href="javascript:void(0)" ...
```

Verified values: `B009ZUZ9FW` → 279 pages, `B013UWFM52` → 305 pages. German
locale pages label the same field `Seitenzahl der Print-Ausgabe` instead of
`Print length`; some pages also carry a `"numberOfPages"` JSON/attribute
value, accepted as a third, lower-priority pattern. All three patterns strip
thousands separators (e.g. `1,024 pages` → `1024`) and reject a value that
isn't a positive integer or that exceeds a sane bound (100000), treating
either as "not found" rather than trusting a mis-parse.

This request is made **deliberately without the captured Amazon session
cookie** — it's a public page that doesn't need it, so sending it would (a)
needlessly expose that session to a request that has no reason to see it and
(b) make the response session-dependent, defeating the point of caching it
per asin. Only a browser `User-Agent` and `Accept-Language` are sent.

### Preference order, most exact first

For each book whose position advanced past its baseline, `wordsRead =
wordCount(startPosition=baseline, endPosition=current)`. That integer feeds
one of three tiers, in order:

1. **`print-pages` (exact)** — when a printed page count is available for
   the book, from either source, in order:
   - **`KINDLE_PAGE_COUNTS`** (asin → printed page count), an optional,
     operator-supplied **override**, checked first and requiring no lookup
     when present.
   - Otherwise, the **dynamic lookup** above, cached in KV keyed by asin only
     (`kindle:pageCount:<asin>`, see "Credentials and state" below) — fetched
     once per book, ever, then reused every sync. A failed lookup (blocked,
     non-2xx, or unparseable) is cached as a negative marker with a
     **24-hour TTL**, so a book Amazon won't serve the page for is retried at
     most once a day rather than on every hourly sync, and falls through to
     tier 2 for every sync in between.

   Either way: `pages = (wordsRead / totalWordsInBook) * printedPageCount`,
   where `totalWordsInBook = wordCount(startPosition=0)` (whole book), cached
   in KV per asin+contentVersion so it's fetched once per book per revision,
   not every sync — and only once a page count is actually available. Not
   marked as an estimate. Diagnostics record which of `override` / `lookup` /
   `none` supplied the page count.
2. **`words-per-page` (estimated)** — when no page count is available from
   either source: `pages = wordsRead / KINDLE_WORDS_PER_PAGE` (var, default
   `250`, the standard publishing-industry words-per-page convention).
3. **`positions-fallback` (estimated, last resort)** — when `wordCount`
   itself fails for that book (non-2xx, unparseable body, or no
   `contentVersion`/usable `karamelToken` to call it with):
   `positionDelta / KINDLE_POSITIONS_PER_PAGE`, the original mechanism from
   the first verification pass (default `1800`, see "What changed" above).
   A `wordCount` failure degrades only that book, never the whole sync. The
   page-count lookup is never attempted on this path — it's only worth its
   cost for a book whose `wordCount` call actually succeeded.

Per-book page contributions are summed as floats across every book, and
rounded once at the end — not rounded per book, which would compound error
across books with fractional per-book contributions.

**No book in the account exposed `pageNumberUrl`** (nor `fragmentMapUrl` or
`manifestUrl`) during either verification pass, so the printed-page-map tier
from the original draft was dead in practice; it's been replaced by the
page-count tier above, now driven primarily by the dynamic product-page
lookup, with `KINDLE_PAGE_COUNTS` kept only as a manual rescue.

A book's own progress fraction — `(position - startPosition) / (endPosition -
startPosition)`, clamped to `[0, 1]` — is computed separately from
`metadataUrl` purely for `GET /status` diagnostics; it has no part in the
pages metric. Diagnostics per book now also include `wordsRead`, `derivation`
(`"print-pages"` | `"words-per-page"` | `"positions-fallback"`), `pages`
contributed, and `pageCountSource` (`"override"` | `"lookup"` | `"none"`) —
where that book's page count came from, if it had one at all. The top-level
`estimated` flag stays `true` unless every counted book this sync used
`print-pages`.

## Credentials and state

Two pieces of user-supplied state, both in KV, both replaceable over HTTP
without a redeploy:

| KV key | Contents |
|---|---|
| `kindle:session` | `{ cookie, updatedAt }` |
| `kindle:positions` | `{ date, positions: { [asin]: number }, estimated: boolean }` |
| `kindle:totalWords:<asin>:<contentVersion>` | A single number — that book's whole-book word count at that revision. Keyed by asin AND contentVersion, so a new revision is simply a different key rather than something to compare and invalidate. Written only once a page count is available (override or dynamic lookup). Note: the previous revision's key is never deleted when a new one is written, so a content revision leaves one orphaned key behind — harmless, but relevant to manual KV cleanup. |
| `kindle:pageCount:<asin>` | `{ pages: number \| null }` — the book's discovered printed page count, cached forever on success (`pages` is the count), or `{ pages: null }` on a failed lookup, cached with an `expirationTtl` of one day (86400 seconds) so the lookup retries at most once daily rather than every sync. Keyed by asin ONLY (unlike totalWords) since a printed page count is a property of the print edition, not a content revision. Never consulted or written for a book with a `KINDLE_PAGE_COUNTS` override — the override short-circuits before the cache or the request. |

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
   `lastPageReadData` (position), `contentVersion`, `karamelToken`, and
   opportunistically `metadataUrl`. `lastPageReadData: null` or `position: -1`
   → skip silently. A book that fails outright (non-2xx or thrown error) is
   skipped, not fatal, unless every book in the library fails.
5. Merge this sync's positions into the day's baseline: a book with no
   existing baseline (new day, or first sighting today) records its current
   position as its own baseline and contributes 0; an existing baseline is
   never advanced except by writing the merged result back at the end.
6. For each book with an existing baseline whose position advanced past it
   (delta > 0 — otherwise skipped, no request spent): call `wordCount` with
   `startPosition=baseline&endPosition=current` for `wordsRead`. Only once
   that call succeeds, resolve a page count (override, else cached or freshly
   discovered from the product page — see "Amazon exposes printed page
   counts" above) and derive that book's pages per the preference order above
   (`print-pages` → `words-per-page` → `positions-fallback`), summing every
   book's contribution as a float.
7. Round the summed total once. Write back `kindle:positions` (every sync,
   so a fresh mid-day baseline persists) and return the rounded pages.

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
  book tested — in practice, printed-page maps are unavailable through
  Amazon's own API, which is why the exact tier is now driven by the
  product-page lookup below, with `KINDLE_PAGE_COUNTS` kept only as a manual
  override.
- `GET https://www.amazon.com/dp/<asin>`, unauthenticated (no cookies), with
  a browser User-Agent and `Accept-Language: en-US,en;q=0.9`, returns 200
  (~340 KB HTML) containing the printed page count in the detail bullets —
  confirmed for `B009ZUZ9FW` (279 pages) and `B013UWFM52` (305 pages), both
  against the literal `Print length: N pages` markup.
- `metadataUrl` returns JSONP wrapping `startPosition`/`endPosition`,
  confirmed against three books.
- `percentageRead` is always `0`, regardless of actual progress.
- `renderer/wordCount` (asin `B009ZUZ9FW`, contentVersion `e2e02ac4`):
  `startPosition=0` → 98651 (whole book); `startPosition=238526`, no
  `endPosition` → 55560 (words remaining); `startPosition=0&endPosition=238526`
  → 43090 (words in that range). `43090 + 55560 = 98650 ≈ 98651`, confirming
  the range semantics. Omitting `startPosition` → 400 naming `startPosition`.
- `startReading` supplies `contentVersion` and `karamelToken` alongside
  `lastPageReadData`; `karamelToken` was observed as `{ token: "…" }`.

**Not yet verified:**

- This integration has never run inside a deployed Cloudflare Worker — only
  against the live Amazon API from outside that runtime. Cloudflare's
  outbound TLS fingerprint may differ from a desktop browser's in a way that
  changes how Amazon's edge treats the request (rate limiting, bot
  detection, or an outright block). The first real deploy is the first real
  test of that variable.
- Long-term cookie lifetime and how often `session-id` actually needs
  re-capture in practice — only observed over a short verification window.
- Whether `karamelToken` is ever supplied as a bare string rather than
  `{ token: "…" }` — only the object shape has been observed live; the bare
  string is handled defensively but unexercised against a real positive case.
- `wordCount`'s behavior for a book with no `contentVersion` at all (e.g. a
  personal document, which is already excluded upstream by
  `lastPageReadData: null`) — not directly exercised, since no such case
  reaches this code path in practice.
- If a book ever does expose a real `pageNumberUrl` map in the future, nothing
  in this integration will pick it up automatically — that tier was removed
  outright (see above), not merely deprioritized. The operator would need to
  add that book to `KINDLE_PAGE_COUNTS` to get an exact page count for it.
- Whether Amazon serves the product-page request the same way from inside a
  deployed Cloudflare Worker as it did from a plain live `curl` outside that
  runtime — verified only from outside the Worker, same caveat as above.
  A Worker-specific block or bot challenge would make every book's dynamic
  lookup fail (falling through to `words-per-page`, never failing the sync),
  but it's untested until the first real deploy. If it does turn out to be
  blocked in practice, `KINDLE_PAGE_COUNTS` remains available as a full
  per-book rescue.
- Long-term behavior of the negative-cache retry cadence (one lookup attempt
  per day per book) against a real, possibly-blocking Amazon edge — only
  reasoned about, not observed over any real multi-day window.

## Out of scope

- Reading minutes (no endpoint exposes them).
- Personal documents. `startReading` returns `lastPageReadData: null` for
  them, verified live, so their progress stays unreachable through this
  path.
- Any flow requiring the account password, 2FA, or ADP RSA request signing.
