# Kindle

> **Verified live against a real Amazon account.** Every endpoint, header, and
> response shape documented below was confirmed by exercising it against a
> working account — see
> [the design doc](../../../docs/superpowers/specs/2026-08-04-kindle-integration.md)
> for what remains unverified (running inside a deployed Worker).

## What it logs

Pages read today, as the `pages` unit, into the Habitify habit configured by
`HABIT_ID_KINDLE`. The value is the sum, across every book in the library, of
`max(0, pagesSinceBaseline)`, where the baseline is each book's Whispersync
*position* (not a derived page number) at the first sync of the current local
day.

Pages are derived from **Amazon's own word count** for each book (the
`renderer/wordCount` endpoint), not from a positions-per-page guess. For each
book whose position advanced past its baseline, the integration asks Amazon
for the number of words read between the baseline and current position, then
converts that to pages in one of two ways, in preference order:

1. **Exact**, when you've configured that book's real printed page count in
   `KINDLE_PAGE_COUNTS` — see [Configuration](#configuration). Pages are
   `(wordsRead / totalWordsInBook) * printedPageCount`, both word counts
   coming from Amazon.
2. **Estimated**, otherwise — `wordsRead / KINDLE_WORDS_PER_PAGE` (default
   `250`, the standard publishing-industry words-per-page convention).

If Amazon's word count can't be fetched for a book (network failure, non-2xx,
or the book is missing the `contentVersion`/`karamelToken` startReading
provides), that book alone falls back to the old positions-per-page estimate
— see [Gotchas](#gotchas). It never fails the sync.

## Configuration

| Key | Kind | Where to get it |
|---|---|---|
| `HABIT_ID_KINDLE` | Var (`wrangler.toml`) | `curl -H "Authorization: <HABITIFY_API_KEY>" https://api.habitify.me/habits` |
| `KINDLE_WORDS_PER_PAGE` | Var (`wrangler.toml`), optional | No external source — words per printed page when no exact print length is configured, default `250` (a standard publishing convention). |
| `KINDLE_PAGE_COUNTS` | Var (`wrangler.toml`), optional | A JSON object mapping asin to printed page count, e.g. `{"B009ZUZ9FW":272,"B013UWFM52":304}`. Find a book's printed page count on its Amazon product page, under the "Print length" line in the product details (only shown for books with a real print edition). Configuring a book here makes its page count *exact* instead of estimated. |
| `KINDLE_POSITIONS_PER_PAGE` | Var (`wrangler.toml`), optional | No external source — an estimate of Whispersync position units per printed page, default `1800`. Only used as a last-resort fallback when a book's word count is unavailable. See [Gotchas](#gotchas) for how that default was chosen. |

Example `wrangler.toml` snippet:

```toml
[vars]
HABIT_ID_KINDLE = "abc123"
KINDLE_WORDS_PER_PAGE = "250"
KINDLE_PAGE_COUNTS = "{\"B009ZUZ9FW\":272,\"B013UWFM52\":304}"
```

Without any entries in `KINDLE_PAGE_COUNTS`, every book uses the
words-per-page estimate — a good approximation, but not exact, since it
doesn't account for a specific edition's actual typesetting.

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
| `kindle:totalWords:<asin>:<contentVersion>` | A single number — that book's whole-book word count at that revision, cached so it's fetched once per book per revision rather than every sync (only written for books with a `KINDLE_PAGE_COUNTS` entry) |

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
- **Exact when you configure a print length, otherwise an estimate.** If the
  book has an entry in `KINDLE_PAGE_COUNTS`, pages are
  `(wordsRead / totalWordsInBook) * printedPageCount` — exact against the
  real print edition, and not marked as an estimate. `totalWordsInBook` is
  fetched once per book per revision and cached in KV (see
  [Stored state](#stored-state)). Without a configured print length, pages
  are `wordsRead / KINDLE_WORDS_PER_PAGE` (default `250`, the standard
  publishing-industry convention) — a good approximation, not exact, since it
  doesn't account for a specific edition's actual typesetting.
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
- **This endpoint contract is unofficial.** It's confirmed against a live
  account, not documented by Amazon, and may change without notice.
- **`GET /status` states.** `"disabled"` means `HABIT_ID_KINDLE` isn't set.
  `"auth_needed"` means no session has been captured yet, the cookie lacks
  `session-id`, or `getDeviceToken` rejected the stored cookie — redo the
  capture. `"error"` means the library was reachable but every book failed
  individually (a single book failing does not fail the sync). `"ok"` with
  value `0` on the first sync of a day is expected — that sync only
  establishes the baseline.
