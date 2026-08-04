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

The page count is almost always an **estimate**, derived from how far the
position moved rather than from a real page map — see [Gotchas](#gotchas).

## Configuration

| Key | Kind | Where to get it |
|---|---|---|
| `HABIT_ID_KINDLE` | Var (`wrangler.toml`) | `curl -H "Authorization: <HABITIFY_API_KEY>" https://api.habitify.me/habits` |
| `KINDLE_POSITIONS_PER_PAGE` | Var (`wrangler.toml`), optional | No external source — an estimate of Whispersync position units per printed page, default `1800`. See [Gotchas](#gotchas) for how that default was chosen. |

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

To force a fresh baseline, delete `kindle:positions` directly:

```bash
npx wrangler kv key delete --namespace-id=<id> "kindle:positions"
```

To clear a rejected or expired session, either call `DELETE /kindle/session`
or delete the key directly, then redo the [Setup](#setup) capture.

## Gotchas

- **The value is an estimate.** Amazon exposes no real page map in practice —
  every book tested returned no usable `pageNumberUrl` (it, along with
  `fragmentMapUrl` and `manifestUrl`, was absent on every response). So pages
  are derived from the Whispersync position delta since the day's baseline:
  `pagesSinceBaseline = positionDelta / KINDLE_POSITIONS_PER_PAGE`. The
  default, `1800`, is grounded in three verified books — Deep Work worked out
  to roughly 1500 positions per printed page, The C Programming Language to
  roughly 2070, and the dense, small-print ESV Bible to roughly 5600. `1800`
  splits the difference for normal prose; dense reference books will
  over-count pages. If a book *does* expose a usable `pageNumberUrl` map, it's
  used instead for that book's delta, and that book's contribution is not
  marked as an estimate — but treat this as opportunistic, not the norm.
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
