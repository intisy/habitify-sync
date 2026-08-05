# Strava

## What it logs

Minutes of activity moving time recorded today, as the `min` unit, into the
Habitify habit configured by `HABIT_ID_STRAVA`. Value is the sum of
`moving_time` across every activity Strava reports since local midnight.

## Configuration

Declared in `src/integrations/strava/index.ts` as this integration's
`settings` (see the root README's
[Configuration model](../../../README.md#configuration-model) for how a
declaration turns into an environment variable and how it resolves). Both are
required and secret, so both live only in Cloudflare, never in `wrangler.toml`
or the config API.

| Key | Derived variable | Required | Where to get it |
|---|---|---|---|
| `clientId` | `STRAVA_CLIENT_ID` | yes | Strava API application at [strava.com/settings/api](https://www.strava.com/settings/api) |
| `clientSecret` | `STRAVA_CLIENT_SECRET` | yes | Same Strava API application |

`habitId` (`HABIT_ID_STRAVA`) is implicit on every integration — see the
[Configuration model](../../../README.md#configuration-model). `GET
/config/strava` shows the live, current value (or `configured` status for the
two secrets) of every setting listed here.

## Setup

1. Create an API application at
   [strava.com/settings/api](https://www.strava.com/settings/api).
2. Set its **Authorization Callback Domain** to the worker's own domain
   (e.g. `habitify-sync.<your-subdomain>.workers.dev`, or your custom domain
   if you've mapped one). Strava allows exactly **one** Authorization
   Callback Domain per API application — see the gotcha below.
3. Set `STRAVA_CLIENT_ID` and `STRAVA_CLIENT_SECRET` as secrets, and
   `HABIT_ID_STRAVA` as a var, then deploy.
4. Open, in a browser:

   ```
   https://<worker-url>/strava/authorize?token=<ADMIN_TOKEN>
   ```

   and approve the consent screen. This is a one-time step — the resulting
   tokens are stored in the `STATE` KV namespace. You do not need to repeat
   it unless Strava revokes access (see the rotating-refresh-token gotcha
   below).

## Routes

| Route | Auth | Purpose |
|---|---|---|
| `GET /strava/authorize` | `admin-or-query-token` | Redirects to Strava's consent screen; stashes a CSRF `state` value in KV |
| `GET /strava/callback` | `public` | Strava redirects here after consent; validates the stored `state`, exchanges the code, persists tokens |

`GET /strava/callback` is `public` because Strava calls it directly and
can't attach an `Authorization` header — it authenticates the request by
checking the `state` query parameter against the value stashed in KV during
`/strava/authorize`, deleting it once used.

## Stored state

| Key | Contents |
|---|---|
| `strava:tokens` | `{ accessToken, refreshToken, expiresAt }` — current OAuth tokens |
| `strava:oauth_state` | One-time CSRF value for the in-flight OAuth handshake; expires after 600 seconds |

To clear wedged credentials and force re-authorization:

```bash
npx wrangler kv key delete --namespace-id=<id> "strava:tokens"
```

Then open `/strava/authorize` again.

## Gotchas

- **One Authorization Callback Domain per app.** Strava allows exactly one.
  Run `/strava/authorize` from the exact host you registered — a
  `*.workers.dev` host and a custom domain mapped to the same worker are
  not interchangeable. Using the wrong one produces an opaque error from
  Strava, not a helpful one from this worker.
- **Refresh tokens rotate.** Strava issues a new refresh token on every
  refresh; this integration persists the new one back to KV after every
  refresh automatically. If a refresh token is ever used from a stale copy
  (e.g. restored from an old backup), Strava will reject it.
- **`GET /status` states.** `"disabled"` means one of
  `STRAVA_CLIENT_ID`/`STRAVA_CLIENT_SECRET`/`HABIT_ID_STRAVA` isn't set.
  `"auth_needed"` means `/strava/authorize` has never been completed, or
  Strava rejected the refresh token or access token — re-run
  `/strava/authorize`. `"error"` covers other failures (e.g. an unexpected
  activities payload shape).
