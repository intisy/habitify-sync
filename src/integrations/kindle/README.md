# Kindle

> **Unverified against a live account.** The endpoint shapes below come from
> two independent reverse-engineering sources, not from Amazon documentation,
> and the account used to develop this integration never obtained a
> successful `startReading` response (see the design doc's ["Verification
> gate"](../../../docs/superpowers/specs/2026-08-04-kindle-integration.md#verification-gate)).
> The first real `PUT /kindle/session` capture against a working account is
> also effectively the first real test of this code end to end.

## What it logs

Pages read today, as the `pages` unit, into the Habitify habit configured by
`HABIT_ID_KINDLE`. The value is the sum, across every book in the library,
of `max(0, currentPage - baselinePage)`, where the baseline is each book's
page position at the first sync of the current local day.

The derived page number may be an **estimate** rather than a real printed
page — see [Gotchas](#gotchas) for when that happens and how to tell.

## Configuration

| Key | Kind | Where to get it |
|---|---|---|
| `HABIT_ID_KINDLE` | Var (`wrangler.toml`) | `curl -H "Authorization: <HABITIFY_API_KEY>" https://api.habitify.me/habits` |
| `KINDLE_POSITIONS_PER_PAGE` | Var (`wrangler.toml`), optional | No external source — an estimate of Whispersync position units per printed page, default `1400`. Only used by the least-precise page-derivation tier. |

No secret is configured for this integration. Unlike Strava or WakaTime,
its credentials (an Amazon session cookie and device identifiers) are not
known at deploy time and can expire — they are captured once manually and
stored in the `STATE` KV namespace via the routes below, not as a
`wrangler secret`.

## Setup

This is a one-time manual capture from a browser, using Firefox's DevTools
(Chrome's Network panel works the same way with different menu labels).

1. Log in at `https://www.amazon.com`, then open
   `https://read.amazon.com/kindle-library` in the same browser session.
2. Open DevTools (F12) → the **Network** tab → filter by **XHR** → reload
   the page.
3. Find the request to `service/web/register/getDeviceToken` in the request
   list and copy its full URL. The `serialNumber` and `deviceType` query
   parameters on that URL are the two device values you need.
4. Pick any request to `read.amazon.com` in the same list and copy its full
   `Cookie` request header value (not just one cookie — the entire header).
5. `PUT` those three values to `/kindle/session`:

   ```bash
   curl -X PUT "https://<worker-url>/kindle/session" \
     -H "Authorization: Bearer $ADMIN_TOKEN" \
     -H "Content-Type: application/json" \
     -d '{
       "cookie": "<full Cookie header value>",
       "deviceSerialNumber": "<serialNumber value>",
       "deviceType": "<deviceType value>"
     }'
   ```

   A 204 response means it was stored. A 400 means one of the three fields
   was missing or empty.

The device session token itself (used as `x-adp-session-token`) is fetched
fresh from `getDeviceToken` on every sync using the serial/type pair above —
it is short-lived and deliberately not cached, so it is not part of this
capture.

## Routes

| Route | Auth | Purpose |
|---|---|---|
| `PUT /kindle/session` | `admin` | Stores `{ cookie, deviceSerialNumber, deviceType }`; 400 on a malformed or incomplete body, 204 on success |
| `DELETE /kindle/session` | `admin` | Clears the stored session |

## Stored state

| Key | Contents |
|---|---|
| `kindle:session` | `{ cookie, deviceSerialNumber, deviceType, updatedAt }` — the captured credentials |
| `kindle:positions` | `{ date, pages: { [asin]: number }, estimated }` — today's baseline page per book |

To force a fresh baseline, delete `kindle:positions` directly:

```bash
npx wrangler kv key delete --namespace-id=<id> "kindle:positions"
```

To clear a rejected or stale session, either call `DELETE /kindle/session`
or delete the key directly, then redo the [Setup](#setup) capture.

## Gotchas

- **This integration is unverified end to end.** `getDeviceToken` and the
  library search endpoint are corroborated by two reverse-engineering
  sources and the library search endpoint is confirmed working with
  cookies alone, but `startReading` — the only source of actual reading
  position — has never returned a successful response against the
  development account. Treat the first live capture as the first real test.
- **The device session token field name is a guess.** `getDeviceToken`'s
  response is expected to carry the token as `deviceSessionToken`; this
  integration also accepts `deviceToken` or `token` as fallbacks in case
  the real field name differs. If none of the three is present, or the
  session is otherwise rejected, `getDeviceToken` returning a 4xx status
  is treated as a stale capture, surfaced as `"auth_needed"`.
- **Personal documents are not covered.** The library endpoint only
  accepts `libraryType=BOOKS`; Send-to-Kindle documents (PDOCs) are outside
  its results, so their reading progress cannot be tracked through this
  integration.
- **Derived pages can be an estimate.** In order of precision: (1) a real
  printed-page lookup, when the book exposes a `pageNumberUrl` map with a
  recognizable shape; (2) a page estimated from Amazon's own
  `percentageRead` combined with the book's position range from
  `metadataUrl`; (3) a rough `position / KINDLE_POSITIONS_PER_PAGE`
  estimate, when neither of the above is available or parses. Tiers 2 and 3
  set `estimated: true` in `kindle:positions`; only tier 1 does not. The
  `pageNumberUrl` and `metadataUrl` schemas are themselves not confirmed by
  either reverse-engineering source, so both are parsed defensively and
  fall through to the next tier on any failure.
- **The device session token expires.** It is fetched fresh on every sync
  and never cached, but the underlying browser session cookie is
  longer-lived and will still eventually expire or be revoked — when it is,
  redo the capture in [Setup](#setup).
- **`GET /status` states.** `"disabled"` means `HABIT_ID_KINDLE` isn't set.
  `"auth_needed"` means no session has been captured yet, or
  `getDeviceToken` rejected the stored cookie/device pair — redo the
  capture. `"error"` means the library was reachable but every book failed
  individually (a single book failing does not fail the sync). `"ok"` with
  value `0` on the first sync of a day is expected — that sync only
  establishes the baseline.
