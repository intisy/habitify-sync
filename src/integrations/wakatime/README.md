# WakaTime

## What it logs

Minutes of coding activity for today, as the `min` unit, into the Habitify
habit configured by `HABIT_ID_WAKATIME`.

## Configuration

| Key | Kind | Where to get it |
|---|---|---|
| `WAKATIME_API_KEY` | Secret | [wakatime.com/settings/api-key](https://wakatime.com/settings/api-key) |
| `HABIT_ID_WAKATIME` | Var (`wrangler.toml`) | `curl -H "X-API-Key: <HABITIFY_API_KEY>" https://api.habitify.me/v2/habits`, or `GET /habits` on the deployed worker |

## Setup

1. Copy your API key from
   [wakatime.com/settings/api-key](https://wakatime.com/settings/api-key) and
   set it as the `WAKATIME_API_KEY` secret (`wrangler secret put` in
   production, `.dev.vars` locally).
2. Set `HABIT_ID_WAKATIME` to the target Habitify habit's id in
   `wrangler.toml`.
3. Make sure that habit's unit in Habitify is set to minutes.

There is no OAuth step — the integration is enabled as soon as both keys
above are present.

## Routes

None. This integration is a plain key-based `fetchToday` with no routes of
its own.

## Stored state

None beyond the shared `status:wakatime` key that every integration gets
from the generic status tracking in `src/state.ts`.

## Gotchas

- **Account timezone, not worker timezone.** The `start`/`end` query dates
  sent to WakaTime's summaries endpoint are resolved by WakaTime using
  whatever timezone is set on your WakaTime account — independent of this
  worker's `TIMEZONE` var. If the two don't match, values will be off near
  midnight in either zone. Set your WakaTime account timezone to match the
  worker's `TIMEZONE`.
- **The "still computing" response.** WakaTime can return HTTP 200 with a
  `data` field that isn't an array while a summary is still being computed
  (a 202-style state delivered with a 200 status). This integration checks
  the shape explicitly and throws `"WakaTime returned an unexpected payload
  shape"` rather than a cryptic `TypeError` — surfaced via `GET /status` as
  `"state": "error"` with that message.
- **`GET /status` states.** `"disabled"` means `WAKATIME_API_KEY` or
  `HABIT_ID_WAKATIME` isn't set. `"error"` means the summaries request
  failed or returned an unexpected shape. There is no `"auth_needed"` state
  for this integration — an invalid API key surfaces as a non-ok response,
  reported as `"error"`.
