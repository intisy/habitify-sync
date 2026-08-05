# Kindle

> **Verified live against a real Amazon account.** Every endpoint, header, and
> response shape documented below was confirmed by exercising it against a
> working account — see
> [the design doc](../../../docs/superpowers/specs/2026-08-04-kindle-integration.md)
> for what remains unverified (running inside a deployed Worker).

## What it logs

Pages read today into the Habitify habit configured by `HABIT_ID_KINDLE`.
This integration declares its value's semantic unit as `"pages"` — the
honest description of what's being counted — but `"pages"` is **not** one of
Habitify's own accepted unit symbols, so it is never sent to Habitify
verbatim. Instead, `src/sync.ts` resolves the actual unit sent once per sync
run: it's logged against whatever unit the `HABIT_ID_KINDLE` habit is
*itself* configured with in Habitify (any valid Habitify unit — `"rep"` is a
sensible choice for a count like pages); if that habit has no configured
unit, the log falls back to `"rep"`. Either way, `GET /status` on this
integration reports `unit: "pages"` for diagnostic purposes, and the
top-level source status notes if a unit fallback happened. See the root
[README's "How it works"](../../../README.md#how-it-works) for the general
mechanism.

The value is the sum, across every book in the library, of
`max(0, pagesSinceBaseline)`, where the baseline is each book's Whispersync
*position* (not a derived page number) at the first sync of the current local
day.

Pages are derived from **Amazon's own word count** for each book (the
`renderer/wordCount` endpoint), not from a positions-per-page guess. For each
book whose position advanced past its baseline, the integration asks Amazon
for the number of words read between the baseline and current position, then
converts that to pages in one of three ways, in preference order:

1. **Exact**, using that book's real printed page count — normally
   **discovered automatically** from the book's own Amazon product page (see
   [How the page count is discovered](#how-the-page-count-is-discovered)
   below), or from the `KINDLE_PAGE_COUNTS` override if you've configured one
   — see [Configuration](#configuration). Pages are
   `(wordsRead / totalWordsInBook) * printedPageCount`, both word counts
   coming from Amazon.
2. **Estimated**, when no printed page count is available at all —
   `wordsRead / KINDLE_WORDS_PER_PAGE` (default `250`, the standard
   publishing-industry words-per-page convention).
3. **Positions fallback**, last resort — see [Gotchas](#gotchas).

If Amazon's word count can't be fetched for a book (network failure, non-2xx,
or the book is missing the `contentVersion`/`karamelToken` startReading
provides), that book alone falls back to the old positions-per-page estimate
— see [Gotchas](#gotchas). It never fails the sync.

### How the page count is discovered

No configuration is needed for a book's printed page count to be exact. The
integration fetches the book's public Amazon product page,
`https://www.amazon.com/dp/<asin>` — the same page anyone can view in a
browser, logged out — and parses the printed page count out of its detail
bullets (the "Print length" line, or "Seitenzahl der Print-Ausgabe" on German
locale pages). This request is deliberately **unauthenticated**: it's sent
with only a browser `User-Agent` and `Accept-Language`, and no `Cookie` at
all — the captured Amazon session is never sent to it, since the page doesn't
need it and sending it would be a needless exposure of that session.

A discovered page count is cached in KV **forever, keyed by asin only** (see
[Stored state](#stored-state)) — a printed page count is a property of the
print edition and never changes, so once found it's never fetched again. If
the product page can't be fetched or parsed (Amazon blocks the request, a
non-2xx response, or the page simply has no recognizable page-count text),
that failure is cached too, but only for a day — the book falls back to the
words-per-page estimate for that sync, and the lookup is retried on the first
sync after the negative cache entry expires, rather than on every hourly
sync. Either way, a single book's lookup failure never fails the sync, and
never affects any other book.

`KINDLE_PAGE_COUNTS` still exists (see [Configuration](#configuration)) but
is now only a manual **override** — a way to rescue a specific book for which
the automatic discovery fails, e.g. because Amazon starts blocking the
Worker's product-page requests. It requires no day-to-day maintenance and,
for most books, no entries at all.

## Configuration

| Key | Kind | Where to get it |
|---|---|---|
| `HABIT_ID_KINDLE` | Var (`wrangler.toml`) | `curl -H "X-API-Key: <HABITIFY_API_KEY>" https://api.habitify.me/v2/habits` |
| `KINDLE_WORDS_PER_PAGE` | Var (`wrangler.toml`), optional | No external source — words per printed page when no printed page count is available at all (neither discovered nor overridden), default `250` (a standard publishing convention). |
| `KINDLE_PAGE_COUNTS` | Var (`wrangler.toml`), optional, **override only** | Normally left empty — printed page counts are discovered automatically (see [How the page count is discovered](#how-the-page-count-is-discovered)). Only fill this in to rescue a book for which that discovery fails: a JSON object mapping asin to printed page count, e.g. `{"B009ZUZ9FW":272,"B013UWFM52":304}`, found on the book's Amazon product page under "Print length". An entry here always wins over the discovered value for that book. |
| `KINDLE_POSITIONS_PER_PAGE` | Var (`wrangler.toml`), optional | No external source — an estimate of Whispersync position units per printed page, default `1800`. Only used as a last-resort fallback when a book's word count is unavailable. See [Gotchas](#gotchas) for how that default was chosen. |

Example `wrangler.toml` snippet:

```toml
[vars]
HABIT_ID_KINDLE = "abc123"
KINDLE_WORDS_PER_PAGE = "250"
# Leave empty in normal operation — only fill in an entry to override a book whose page count
# Amazon's product page won't yield to the Worker's request.
KINDLE_PAGE_COUNTS = ""
```

Without any entries in `KINDLE_PAGE_COUNTS`, every book still gets an exact
page count whenever its product-page lookup succeeds; only a book whose
lookup fails (and has no override) falls back to the words-per-page estimate
— a good approximation, but not exact, since it doesn't account for a
specific edition's actual typesetting.

No secret is configured for this integration. Unlike Strava or WakaTime, its
credential (an Amazon session cookie) is not known at deploy time and can
expire — it's captured once manually and stored in the `STATE` KV namespace
via the routes below, not as a `wrangler secret`.

## Setup

This is a one-time manual capture from a browser. Unlike earlier drafts of
this integration, **no device serial number or device type needs to be
captured** — verified live, the Kindle Cloud Reader's device pair is a fixed
constant baked into the integration, not a per-user value.

1. Sign in at `https://www.amazon.com`, then open
   `https://read.amazon.com/kindle-library` in the same browser session.
2. Open DevTools (F12) → the **Network** tab → filter by **XHR** → reload
   the page.
3. Click any request to `read.amazon.com` in the list and copy its full
   `Cookie` request header value — the entire header, not just one cookie.
   It must contain a `session-id=` cookie; without one, the integration
   cannot authenticate and will report `auth_needed`.
4. `PUT` it to `/kindle/session`:

   ```bash
   curl -X PUT "https://<worker-url>/kindle/session" \
     -H "Authorization: Bearer $ADMIN_TOKEN" \
     -H "Content-Type: application/json" \
     -d '{ "cookie": "<full Cookie header value>" }'
   ```

   A 204 response means it was stored. A 400 means `cookie` was missing,
   empty, or the body wasn't valid JSON.

The ADP session token used as `x-adp-session-token` is fetched fresh from
`getDeviceToken` on every sync — it's short-lived and deliberately not
cached, so it isn't part of this capture.

## Routes

| Route | Auth | Purpose |
|---|---|---|
| `PUT /kindle/session` | `admin` | Stores `{ cookie }`; 400 on a malformed or empty body, 204 on success. A body still carrying the old `deviceSerialNumber`/`deviceType` fields is accepted — they're ignored. |
| `DELETE /kindle/session` | `admin` | Clears the stored session |

## Stored state

| Key | Contents |
|---|---|
| `kindle:session` | `{ cookie, updatedAt }` — the captured credential |
| `kindle:positions` | `{ date, positions: { [asin]: number }, estimated }` — today's baseline Whispersync position per book |
| `kindle:totalWords:<asin>:<contentVersion>` | A single number — that book's whole-book word count at that revision, cached so it's fetched once per book per revision rather than every sync (only written once a printed page count is available, from either the override or the discovered value). The old key from a previous revision is never deleted when a new one is written, so a content revision leaves one orphaned key behind — harmless, but worth knowing if you're doing manual KV cleanup. |
| `kindle:pageCount:<asin>` | `{ pages }` — the book's discovered printed page count, or `{ pages: null }` for a cached lookup failure. Keyed by asin only (not contentVersion): a printed page count doesn't change when Amazon reflows the book. A successful lookup is cached forever; a failed one expires after a day so it's retried at most once daily rather than every sync. Never written for a book covered by a `KINDLE_PAGE_COUNTS` override, since the override always wins before the lookup (or its cache) is ever consulted. |

To force a fresh baseline, delete `kindle:positions` directly:

```bash
npx wrangler kv key delete --namespace-id=<id> "kindle:positions"
```

To clear a rejected or expired session, either call `DELETE /kindle/session`
or delete the key directly, then redo the [Setup](#setup) capture.

## Gotchas

- **Pages are derived from Amazon's own word count, not a positions guess.**
  For each book that advanced past its baseline, the integration calls
  `GET https://read.amazon.com/renderer/wordCount?asin=…&revision=…
  &contentType=FullBook&startPosition=…&endPosition=…` (the same cookie and
  `x-amzn-sessionid`, plus an `x-amz-rendering-token` header) to get the exact
  number of words read since the baseline. `revision` is `startReading`'s
  `contentVersion`; the rendering token comes from `startReading`'s
  `karamelToken`, which may be a bare string or `{ token: "…" }` — both are
  handled. `startPosition` is required; omitting it is a 400. Omitting
  `endPosition` returns the word count from `startPosition` through the end
  of the book — so `startPosition=0` with no `endPosition` is the whole
  book's word count, used as the denominator for the exact derivation below.
- **Exact whenever a printed page count is known, otherwise an estimate.**
  A printed page count comes from, in order: the `KINDLE_PAGE_COUNTS`
  override for that asin, if present; otherwise the book's Amazon product
  page, fetched and parsed automatically (see
  [How the page count is discovered](#how-the-page-count-is-discovered)) and
  cached in KV forever once found. Either way, pages are
  `(wordsRead / totalWordsInBook) * printedPageCount` — exact against the
  real print edition, and not marked as an estimate. `totalWordsInBook` is
  fetched once per book per revision and cached in KV (see
  [Stored state](#stored-state)), and only once a page count is available at
  all, from either source. Only a book with no page count from either source
  — no override, and a failed or not-yet-attempted discovery — uses
  `wordsRead / KINDLE_WORDS_PER_PAGE` (default `250`, the standard
  publishing-industry convention) instead — a good approximation, not exact,
  since it doesn't account for a specific edition's actual typesetting. A
  book's `GET /status` diagnostics report which of `"override"`, `"lookup"`,
  or `"none"` supplied its page count.
- **The product-page lookup only runs for a book that actually contributed
  this sync** — its position advanced past its baseline AND its `wordCount`
  call succeeded. A book that's stalled, brand new today, or whose
  `wordCount` call itself failed never triggers a product-page request at
  all, matching the same "no wasted requests" principle as `wordCount`
  itself.
- **The positions-per-page estimate is now only a last-resort fallback**,
  used when a book's word count can't be fetched at all — no `contentVersion`
  or usable rendering token, a non-2xx response, or an unparseable body. In
  that case pages fall back to
  `positionDelta / KINDLE_POSITIONS_PER_PAGE`, and that book's contribution is
  marked as estimated. The default, `1800`, is grounded in three verified
  books — Deep Work worked out to roughly 1500 positions per printed page,
  The C Programming Language to roughly 2070, and the dense, small-print ESV
  Bible to roughly 5600. `1800` splits the difference for normal prose;
  dense reference books will over-count pages. A word-count failure degrades
  only that book, never the whole sync.
- **Amazon's own `percentageRead` is useless.** The library endpoint returns
  it as `0` for every book, even one 75% read — verified live. It is never
  read by this integration. Instead, each book's progress fraction is
  computed as `(position - startPosition) / (endPosition - startPosition)`
  from `metadataUrl`'s `startPosition`/`endPosition`, and included per-book
  in `GET /status` for diagnostic purposes (it plays no part in the pages
  metric itself).
- **`metadataUrl` returns JSONP, not JSON.** Its body looks like
  `someCallback({...});` — the callback name isn't fixed, so it's stripped
  generically (leading identifier + `(`, trailing `)` with an optional `;`)
  before parsing. It's fetched with no cookies and no extra headers, since
  it's a presigned, cross-origin URL.
- **Personal documents are not tracked.** A Send-to-Kindle document (e.g. a
  manga file) returns `lastPageReadData: null` from `startReading` —
  verified live — so it's silently skipped: not counted, not an error. A
  book with `position: -1` (never opened) is skipped the same way.
- **The critical header is `x-amzn-sessionid`.** Without it, both
  `getDeviceToken` and `startReading` return 403
  `"The given request is not an ADP session request"`, even with an
  otherwise-valid cookie — verified live. Its value is the `session-id`
  cookie's value, promoted to a request header. If the stored cookie has no
  `session-id`, the integration reports `auth_needed` rather than guessing.
- **Cookies expire.** When Amazon rejects the stored cookie (or it's simply
  gone stale), `GET /status` reports `"auth_needed"` — redo the
  [Setup](#setup) capture with a fresh `Cookie` header.
- **The page-count lookup is hardcoded to Amazon's `.com` marketplace.** It
  always requests `https://www.amazon.com/dp/<asin>` with
  `Accept-Language: en-US`, regardless of which Amazon marketplace the
  account actually belongs to. A Kindle account tied to a non-`.com`
  marketplace (`amazon.de`, `amazon.co.uk`, and so on) may have ASINs that
  simply don't resolve at `amazon.com` — the request 404s or serves an
  unrelated product. Every such book silently degrades to the
  words-per-page estimate rather than the exact printed-page-count
  derivation. This is safe and self-healing (it never fails the sync, and
  the negative cache retries daily in case the ASIN starts resolving), but
  for an account on a non-`.com` marketplace it means pages may never
  become "exact" for some or all books.
- **This endpoint contract is unofficial.** It's confirmed against a live
  account, not documented by Amazon, and may change without notice.
- **`GET /status` states.** `"disabled"` means `HABIT_ID_KINDLE` isn't set.
  `"auth_needed"` means no session has been captured yet, the cookie lacks
  `session-id`, or `getDeviceToken` rejected the stored cookie — redo the
  capture. `"error"` means the library was reachable but every book failed
  individually (a single book failing does not fail the sync). `"ok"` with
  value `0` on the first sync of a day is expected — that sync only
  establishes the baseline.
