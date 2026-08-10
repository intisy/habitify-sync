# Strava

## What it logs

Minutes of activity moving time recorded today, as the `min` unit, into the
Habitify habit configured by `HABIT_ID_STRAVA`. Value is the sum of moving
time across every activity since local midnight.

There are two ways to read those activities, and the integration picks one
automatically:

| Reader | Auth | When it's used |
|---|---|---|
| **web** | A captured browser cookie in `strava:session` | Whenever a session is stored |
| **api** | OAuth 2.0 against Strava's v3 API | Only when no session is stored |

Strava's Developer Program has required a paid subscription for Standard-tier
API access since June 2026, so the **web** path is the one that works without
paying. `GET /status` reports which reader produced each value under
`diagnostics.reader`.

## Configuration

Declared in `src/integrations/strava/index.ts` as this integration's
`settings` (see the root README's
[Configuration model](../../../README.md#configuration-model) for how a
declaration turns into an environment variable and how it resolves). Both
credentials are secret, so both live only in Cloudflare, never in
`wrangler.toml` or the config API.

| Key | Derived variable | Required | Where to get it |
|---|---|---|---|
| `clientId` | `STRAVA_CLIENT_ID` | no — API path only | Strava API application at [strava.com/settings/api](https://www.strava.com/settings/api) |
| `clientSecret` | `STRAVA_CLIENT_SECRET` | no — API path only | Same Strava API application |

`habitId` (`HABIT_ID_STRAVA`) is implicit on every integration — see the
[Configuration model](../../../README.md#configuration-model) — and is the
only required setting, since either auth path supplies the rest. `GET
/config/strava` shows the live, current value (or `configured` status for the
two secrets) of every setting listed here.

## Setup — web session (no API subscription)

1. Log in to [strava.com](https://www.strava.com) in a browser.
2. Open DevTools → Network, load
   [strava.com/athlete/training](https://www.strava.com/athlete/training), and
   copy the full `Cookie` request header from any request to `www.strava.com`.
3. Store it:

   ```bash
   curl -X PUT https://<worker-url>/strava/session \
     -H "Authorization: Bearer $ADMIN_TOKEN" \
     -H "Content-Type: application/json" \
     -d '{"cookie":"<the full Cookie header>"}'
   ```

4. Set `HABIT_ID_STRAVA` as a var and deploy.

The cookie includes `strava_remember_token`, a long-lived JWT, so re-capture
is rare. When it does expire, `GET /status` reports `auth_needed` and
`monitor.yml` emails the failure — repeat step 3.

## Setup — OAuth API (requires a Strava subscription)

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
| `PUT /strava/session` | `admin` | Stores the captured browser cookie |
| `DELETE /strava/session` | `admin` | Clears the stored session, falling back to the API path |
| `GET /strava/authorize` | `admin-or-query-token` | Redirects to Strava's consent screen; stashes a CSRF `state` value in KV |
| `GET /strava/callback` | `public` | Strava redirects here after consent; validates the stored `state`, exchanges the code, persists tokens |

`GET /strava/callback` is `public` because Strava calls it directly and
can't attach an `Authorization` header — it authenticates the request by
checking the `state` query parameter against the value stashed in KV during
`/strava/authorize`, deleting it once used.

## Stored state

| Key | Contents |
|---|---|
| `strava:session` | `{ cookie, updatedAt }` — the captured browser session |
| `strava:tokens` | `{ accessToken, refreshToken, expiresAt }` — current OAuth tokens |
| `strava:oauth_state` | One-time CSRF value for the in-flight OAuth handshake; expires after 600 seconds |

To clear wedged credentials and force re-authorization:

```bash
npx wrangler kv key delete --namespace-id=<id> "strava:tokens"
```

Then open `/strava/authorize` again.

## Gotchas

- **A captured session wins over OAuth.** If `strava:session` exists it is
  used, even when valid API tokens are also stored. To go back to the API,
  `DELETE /strava/session` first.
- **The web JSON is undocumented.** Strava can rename fields in
  `/athlete/training_activities` without notice. This is why `GET /status`
  carries `activitiesSeen` and `activitiesCounted`: seeing activities but
  counting none is the signature of a rename, as distinct from a genuine rest
  day, which reports both as 0. `fieldsMatched` names which field each value
  was actually read from, so a fallback quietly taking over is visible before
  the primary name disappears entirely.
- **Travel days.** The web reader filters on `start_date_local_raw`, which is
  local to where the activity was recorded, not to `TIMEZONE`. An activity
  recorded in another timezone can land on the adjacent day near midnight.
- **One Authorization Callback Domain per app.** Strava allows exactly one.
  Run `/strava/authorize` from the exact host you registered — a
  `*.workers.dev` host and a custom domain mapped to the same worker are
  not interchangeable. Using the wrong one produces an opaque error from
  Strava, not a helpful one from this worker.
- **Refresh tokens rotate.** Strava issues a new refresh token on every
  refresh; this integration persists the new one back to KV after every
  refresh automatically. If a refresh token is ever used from a stale copy
  (e.g. restored from an old backup), Strava will reject it.
- **`GET /status` states.** `"disabled"` means `HABIT_ID_STRAVA` isn't set —
  it no longer depends on the two secrets. `"auth_needed"` means neither auth
  path is usable: no session captured and no completed `/strava/authorize`,
  or a cookie or token Strava has since rejected. `"error"` covers other
  failures (e.g. an unexpected activities payload shape, or a bot challenge
  answering with HTML).
