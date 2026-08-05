# Per-integration settings — Design

**Date:** 2026-08-05
**Status:** Approved

## Problem

Every integration's settings live in one flat `[vars]` list in `wrangler.toml`,
namespaced only by prefix convention. Nothing in the code declares what an
integration accepts, so:

- Changing any setting requires an edit plus a deploy.
- The only way to learn an integration's knobs is to read its source or README.
- `scripts/preflight.mjs` hand-maintains a list of integrations and their
  config, which will silently rot as integrations are added.
- Each integration hand-writes an `enabled()` that re-checks its own vars.

At four integrations this is untidy. At twenty it is unmaintainable: four
places to update per addition, none of them enforced.

## Goal

One declaration per setting, in the integration that owns it. Everything else —
resolution, validation, the HTTP config surface, preflight, and `enabled()` —
derives from those declarations. Adding an integration must not require editing
any central list except the registry.

## Setting declarations

`Integration` gains a `settings` array:

```ts
export interface SettingDescriptor {
  /** Integration-local camelCase name, e.g. "wordsPerPage". */
  key: string;
  type: "string" | "number" | "json";
  /** Required settings gate enabled(); every integration implicitly requires habitId. */
  required?: boolean;
  /** Lives only in Cloudflare secrets: never returned by GET /config, never settable via PUT. */
  secret?: boolean;
  default?: string;
  /** One line, shown by GET /config. */
  description: string;
}
```

### Environment variable names are derived, never written twice

The variable name for a setting is
`<INTEGRATION_NAME_UPPER>_<KEY_AS_SCREAMING_SNAKE>`, plus one universal
special case: every integration implicitly has a `habitId` setting read from
`HABIT_ID_<INTEGRATION_NAME_UPPER>`.

This rule reproduces every existing variable name exactly, so there is no
migration and no rename:

| Integration | key | derived variable |
|---|---|---|
| kindle | `wordsPerPage` | `KINDLE_WORDS_PER_PAGE` |
| kindle | `pageCounts` | `KINDLE_PAGE_COUNTS` |
| kindle | `positionsPerPage` | `KINDLE_POSITIONS_PER_PAGE` |
| keybr | `publicId` | `KEYBR_PUBLIC_ID` |
| wakatime | `apiKey` (secret) | `WAKATIME_API_KEY` |
| strava | `clientId` (secret) | `STRAVA_CLIENT_ID` |
| strava | `clientSecret` (secret) | `STRAVA_CLIENT_SECRET` |
| any | `habitId` | `HABIT_ID_<NAME>` |

`TIMEZONE`, `HABITIFY_API_KEY`, and `ADMIN_TOKEN` stay global and are not
integration settings.

## Resolution

Precedence, highest first:

1. **KV override** — `config:<integration>`, a JSON object of key → string.
2. **Environment** — the derived variable from `wrangler.toml` or a secret.
3. **`default`** from the descriptor.

Secrets are environment-only: never read from KV, never returned, never
settable over HTTP. `GET /config` reports them as `configured: true|false`.

Integrations read settings through an integration-scoped resolver on
`SourceContext` (and `RouteContext`) rather than touching `env` directly, so a
setting cannot be read under a name nobody declared.

## Derived `enabled()`

`enabled()` is removed from every integration and computed generically: an
integration is enabled when every `required` setting resolves to a non-empty
value. `habitId` is implicitly required. This makes the rule uniform and
impossible to get subtly wrong per integration.

## HTTP surface

| Route | Purpose |
|---|---|
| `GET /config` | Every integration's settings: value, source (`kv`/`env`/`default`), default, type, description; secrets redacted |
| `GET /config/<integration>` | One integration's settings |
| `PUT /config/<integration>` | Merge overrides into KV; validates types; rejects unknown keys and secrets |
| `DELETE /config/<integration>` | Clear all overrides, or one with `?key=` |

All admin-authed. `PUT` validates against the declared `type` — a `number`
must parse finite, a `json` must parse — so a bad value is rejected at the API
rather than degrading silently at sync time.

## Discoverability at scale

- `GET /config` is generated from declarations, so it can never go stale.
- `scripts/preflight.mjs` imports the registry instead of hand-listing
  integrations, and validates every declared setting: required-but-missing,
  wrong type, and unparseable `json`.
- Adding an integration touches exactly two shared things: the registry array
  and, if it has non-secret vars worth committing, `wrangler.toml`.
- `Env` keeps only the global keys plus an index signature for derived
  variables, so it stops growing per integration.

## Constraints

- No behavior change to what any integration logs.
- Existing variable names and their current values keep working untouched.
- Secrets never become readable through the API.
- No new runtime dependencies.
