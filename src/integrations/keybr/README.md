# keybr

## What it logs

Minutes of active typing time practiced today on
[keybr.com](https://www.keybr.com), as the `min` unit, into the Habitify
habit configured by `HABIT_ID_KEYBR`. "Active typing time" is the time spent
actually typing during completed exercises — not wall-clock time at the
keyboard, and not time spent reading instructions or sitting idle between
lessons.

## Configuration

Declared in `src/integrations/keybr/index.ts` as this integration's
`settings` (see the root README's
[Configuration model](../../../README.md#configuration-model)).

| Key | Derived variable | Required | Where to get it |
|---|---|---|---|
| `publicId` | `KEYBR_PUBLIC_ID` | yes | The `{id}` segment of your `https://www.keybr.com/profile/{id}` URL |

`habitId` (`HABIT_ID_KEYBR`) is implicit on every integration — see the
[Configuration model](../../../README.md#configuration-model). `GET
/config/keybr` shows the live, current value of both.

**Neither is a secret.** `KEYBR_PUBLIC_ID` is not a credential — it's the id
embedded in your own shareable profile URL, and it never expires. There is
nothing to authenticate here at all: keybr's sync data endpoint (`GET
https://www.keybr.com/_/sync/data/{publicId}`) takes no cookie, no token, and
no headers of any kind. Both settings resolve fine from `wrangler.toml`'s
`[vars]` (never behind `wrangler secret put`), or can be overridden at
runtime via `PUT /config/keybr`.

## Setup

1. Open your keybr.com profile page and copy the id from its URL:
   `https://www.keybr.com/profile/{id}`.
2. Set that id as `KEYBR_PUBLIC_ID` in `wrangler.toml`.
3. Set `HABIT_ID_KEYBR` to the target Habitify habit's id in `wrangler.toml`.
4. Make sure that habit's unit in Habitify is set to minutes.

There is no OAuth step, no cookie capture, and no credential to expire — the
integration is enabled as soon as both vars above are present, and stays
enabled indefinitely.

## Routes

None. This integration is a plain unauthenticated-fetch `fetchToday` with no
routes of its own.

## Stored state

None. This integration keeps no KV state at all, beyond the shared
`status:keybr` key that every integration gets from the generic status
tracking in `src/state.ts` — there are no tokens or sessions to persist
because the endpoint needs none.

## Gotchas

- **Worker timezone, not browser timezone.** keybr's own "Statistics for
  Today" panel in the browser groups your practice results by your
  browser's local date. This integration instead groups by the worker's
  configured `TIMEZONE` (the same helper every other integration uses for
  "today"). The two will usually agree, but can disagree by a few hours near
  midnight if your browser's timezone and the worker's `TIMEZONE` differ —
  this is expected, and consistent with how every other integration in this
  worker resolves "today".
- **The whole practice history is fetched every sync.** keybr's sync
  endpoint always returns the user's entire history as one binary blob (no
  date filtering, no pagination) — this integration parses the whole thing
  every hour and sums only today's records. For very long-running accounts
  this means the request grows over time, but the endpoint has no smaller
  alternative to fetch instead.
- **A truncated response is tolerated, not an error.** keybr's history file
  is append-only server-side, so a request that happens to land mid-write
  can end with a partial final record. This integration parses every
  complete record it can and silently ignores an incomplete trailing one,
  reporting `truncated: true` in diagnostics rather than failing the sync.
- **No `"auth_needed"` state for this integration.** There is no credential
  to expire, so every failure surfaces as `"error"` in `GET /status`: a
  non-2xx response (a 404 specifically suggests `KEYBR_PUBLIC_ID` is
  wrong — there's nothing else that could cause it), or a malformed body
  (too short for the header, a bad signature, or an unsupported format
  version).
- **Diagnostics.** `GET /status` for this source includes `lessons`
  (completed exercises counted today), `charactersTyped`, `errors`,
  `millisecondsPracticed` (the raw total before the one-time rounding to
  minutes), and `totalRecords` (the whole history's size, useful for
  sanity-checking that the fetch returned plausible data).
