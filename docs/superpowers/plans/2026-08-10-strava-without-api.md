# Strava Without The API — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the `strava` integration read today's activities from Strava's web app using a captured browser session, so the source keeps working without a paid API subscription, while the existing OAuth path stays intact.

**Architecture:** One integration, two interchangeable readers. `fetchToday` picks the web reader when a session is stored at `strava:session`, otherwise the OAuth reader, otherwise raises `AuthNeededError` naming both. Both readers return `StravaActivity[]` and a single shared function sums it to minutes, so the two paths cannot drift on the value written to Habitify.

**Tech Stack:** TypeScript 7, Cloudflare Workers, Workers KV, Vitest with `@cloudflare/vitest-pool-workers`.

Spec: `docs/superpowers/specs/2026-08-10-strava-without-api-design.md`

## Global Constraints

- Every test drives an injected `fetchFn`. No test may touch the network.
- Comments carry only non-obvious *why*. No comment restates what the code does.
- Secrets (`clientId`, `clientSecret`) stay `secret: true` — environment-only, never KV, never the config API.
- The habit value stays "minutes of moving time since local midnight", `unit: "min"`.
- `diagnostics` is never sent to Habitify; it exists only for `GET /status`.
- Conventional Commits: `type(scope): summary`, imperative, lowercase, no trailing period, no task/phase archaeology.
- After any change to `src/integrations/registry.ts` settings, `scripts/settings-manifest.json` and the README integrations block must be regenerated or CI fails.

## Deviation from the spec

The spec sketched `StravaActivity` as `{ startedAt, movingTimeSeconds }`. This plan drops `startedAt`: the API reader filters server-side via `after=`, so it never has a start time to populate, and a field that only one producer fills is dead weight on the shared contract. Each reader filters to today *before* returning, and the shared type carries only what is summed. Nothing else in the spec changes.

## File Structure

| File | Responsibility |
|---|---|
| `src/time.ts` (modify) | Add `naiveLocalMidnightEpochSeconds` beside `localMidnightEpochSeconds` |
| `src/integrations/strava/activities.ts` (create) | `StravaActivity` + `totalMovingMinutes` |
| `src/integrations/strava/api.ts` (create) | OAuth tokens, authorize/callback routes, API reader — moved from `index.ts` |
| `src/integrations/strava/web.ts` (create) | Session storage, session routes, web reader |
| `src/integrations/strava/index.ts` (modify) | Integration object: settings, reader selection, combined routes |
| `test/time.test.ts` (modify) | Boundary tests |
| `src/integrations/strava/activities.test.ts` (create) | Summing tests |
| `src/integrations/strava/web.test.ts` (create) | Web reader + session route tests |
| `src/integrations/strava/index.test.ts` (modify) | Reader selection; existing OAuth cases kept |
| `src/integrations/strava/README.md` (modify) | Both setup paths, routes, state, gotchas |

---

### Task 1: The naive local-midnight boundary

**Files:**
- Modify: `src/time.ts`
- Test: `test/time.test.ts`

**Interfaces:**
- Consumes: `todayInTimeZone`, `localMidnightEpochSeconds` (both already in `src/time.ts`)
- Produces: `naiveLocalMidnightEpochSeconds(timeZone: string, now: Date): number`

- [ ] **Step 1: Write the failing tests**

Append to `test/time.test.ts` (add `naiveLocalMidnightEpochSeconds` to the existing import from `../src/time`):

```ts
describe("naiveLocalMidnightEpochSeconds", () => {
  it("returns local midnight as a naive epoch, unshifted by the zone offset", () => {
    const now = new Date("2026-08-04T10:00:00Z");
    expect(naiveLocalMidnightEpochSeconds("Europe/Berlin", now)).toBe(Date.parse("2026-08-04T00:00:00Z") / 1000);
  });

  it("leads localMidnightEpochSeconds by the summer offset", () => {
    const now = new Date("2026-08-04T10:00:00Z");
    expect(
      naiveLocalMidnightEpochSeconds("Europe/Berlin", now) - localMidnightEpochSeconds("Europe/Berlin", now),
    ).toBe(2 * 3600);
  });

  it("leads localMidnightEpochSeconds by the winter offset", () => {
    const now = new Date("2026-01-15T10:00:00Z");
    expect(
      naiveLocalMidnightEpochSeconds("Europe/Berlin", now) - localMidnightEpochSeconds("Europe/Berlin", now),
    ).toBe(3600);
  });

  it("trails localMidnightEpochSeconds in a negative-offset zone", () => {
    const now = new Date("2026-08-04T16:00:00Z");
    expect(naiveLocalMidnightEpochSeconds("America/New_York", now)).toBe(Date.parse("2026-08-04T00:00:00Z") / 1000);
    expect(
      naiveLocalMidnightEpochSeconds("America/New_York", now) - localMidnightEpochSeconds("America/New_York", now),
    ).toBe(-4 * 3600);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/time.test.ts`
Expected: FAIL — `naiveLocalMidnightEpochSeconds is not a function` / not exported.

- [ ] **Step 3: Implement**

Append to `src/time.ts`:

```ts
// The boundary for a timestamp that is ALREADY offset-shifted — naive local time rendered as an
// epoch, which is what Strava's web JSON emits as start_date_local_raw. Comparing such a value
// against localMidnightEpochSeconds above would be wrong by exactly the zone's UTC offset, which
// silently drops or admits early-morning activities rather than failing.
export function naiveLocalMidnightEpochSeconds(timeZone: string, now: Date): number {
  return Date.parse(`${todayInTimeZone(timeZone, now)}T00:00:00Z`) / 1000;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/time.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/time.ts test/time.test.ts
git commit -m "feat(time): add a naive local-midnight boundary"
```

---

### Task 2: Shared activity shape and summing

**Files:**
- Create: `src/integrations/strava/activities.ts`
- Test: `src/integrations/strava/activities.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `interface StravaActivity { movingTimeSeconds: number }`, `totalMovingMinutes(activities: readonly StravaActivity[]): number`

- [ ] **Step 1: Write the failing tests**

Create `src/integrations/strava/activities.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { totalMovingMinutes } from "./activities";

describe("totalMovingMinutes", () => {
  it("sums moving time and converts to whole minutes", () => {
    expect(totalMovingMinutes([{ movingTimeSeconds: 1800 }, { movingTimeSeconds: 900 }])).toBe(45);
  });

  it("rounds to the nearest minute rather than truncating", () => {
    expect(totalMovingMinutes([{ movingTimeSeconds: 100 }])).toBe(2);
    expect(totalMovingMinutes([{ movingTimeSeconds: 89 }])).toBe(1);
  });

  it("returns 0 for no activities", () => {
    expect(totalMovingMinutes([])).toBe(0);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/integrations/strava/activities.test.ts`
Expected: FAIL — cannot resolve `./activities`.

- [ ] **Step 3: Implement**

Create `src/integrations/strava/activities.ts`:

```ts
// What both readers produce. Only moving time is shared: each reader narrows to today in its own
// frame before returning (the API filters server-side via `after=`, the web reader filters on an
// offset-shifted local timestamp), so a start time here would be dead weight on one of them.
export interface StravaActivity {
  movingTimeSeconds: number;
}

export function totalMovingMinutes(activities: readonly StravaActivity[]): number {
  return Math.round(activities.reduce((sum, activity) => sum + activity.movingTimeSeconds, 0) / 60);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/integrations/strava/activities.test.ts`
Expected: PASS — 3 tests.

- [ ] **Step 5: Commit**

```bash
git add src/integrations/strava/activities.ts src/integrations/strava/activities.test.ts
git commit -m "feat(strava): add a shared activity shape and summing"
```

---

### Task 3: Move the OAuth path into api.ts

Behavior-preserving. `src/integrations/strava/index.test.ts` must keep passing untouched at the end of this task.

**Files:**
- Create: `src/integrations/strava/api.ts`
- Modify: `src/integrations/strava/index.ts`

**Interfaces:**
- Consumes: `StravaActivity` from `./activities`; `localMidnightEpochSeconds` from `../../time`
- Produces: `STRAVA_API_STATE_KEYS`, `interface StravaTokens`, `exchangeStravaCode`, `fetchApiActivities(context: SourceContext, clientId: string, clientSecret: string): Promise<StravaActivity[]>`, `stravaApiRoutes: IntegrationRoute[]`

- [ ] **Step 1: Create api.ts with everything moved out of index.ts**

Create `src/integrations/strava/api.ts`. Move `STRAVA_AUTHORIZE_URL`, `STRAVA_TOKEN_URL`, `STRAVA_ACTIVITIES_URL`, `StravaTokens`, `StravaTokenResponse`, `mapTokenResponse`, `requestStravaToken`, `refreshTokens`, `exchangeStravaCode`, `handleAuthorize`, and `handleCallback` **verbatim** from `index.ts`, including their existing comments. Then add at the top and bottom:

```ts
import { readJson, writeJson } from "../../state";
import { localMidnightEpochSeconds } from "../../time";
import {
  AuthNeededError,
  type Env,
  type IntegrationRoute,
  type RouteContext,
  type SourceContext,
} from "../types";
import type { StravaActivity } from "./activities";

export const STRAVA_API_STATE_KEYS = {
  tokens: "strava:tokens",
  oauthState: "strava:oauth_state",
};
```

Replace every `STRAVA_STATE_KEYS.` reference inside this file with `STRAVA_API_STATE_KEYS.`.

Add the reader, lifted from the second half of the old `fetchToday`:

```ts
export async function fetchApiActivities(
  context: SourceContext,
  clientId: string,
  clientSecret: string,
): Promise<StravaActivity[]> {
  const { env, timeZone, now, fetchFn } = context;
  let tokens = await readJson<StravaTokens>(env.STATE, STRAVA_API_STATE_KEYS.tokens);
  if (!tokens) {
    throw new AuthNeededError("Strava is not authorized yet; open /strava/authorize");
  }
  const nowEpoch = Math.floor(now.getTime() / 1000);
  if (tokens.expiresAt <= nowEpoch + 60) {
    tokens = await refreshTokens(env, clientId, clientSecret, fetchFn, tokens);
  }
  const after = localMidnightEpochSeconds(timeZone, now);
  const response = await fetchFn(`${STRAVA_ACTIVITIES_URL}?after=${after}&per_page=100`, {
    headers: { Authorization: `Bearer ${tokens.accessToken}` },
  });
  if (response.status === 401) {
    throw new AuthNeededError("Strava rejected the access token; re-run /strava/authorize");
  }
  if (!response.ok) {
    throw new Error(`Strava activities request failed with status ${response.status}`);
  }
  const activities = (await response.json()) as { moving_time: number }[];
  if (!Array.isArray(activities)) {
    throw new Error("Strava returned an unexpected payload shape");
  }
  return activities.map((activity) => ({ movingTimeSeconds: activity.moving_time }));
}

export const stravaApiRoutes: IntegrationRoute[] = [
  { method: "GET", path: "/strava/authorize", auth: "admin-or-query-token", handler: handleAuthorize },
  { method: "GET", path: "/strava/callback", auth: "public", handler: handleCallback },
];
```

- [ ] **Step 2: Reduce index.ts to re-export and delegate**

Replace the whole of `src/integrations/strava/index.ts` with:

```ts
import { totalMovingMinutes } from "./activities";
import { fetchApiActivities, stravaApiRoutes, STRAVA_API_STATE_KEYS } from "./api";
import { type HabitValue, type Integration, type SettingDescriptor, type SourceContext } from "../types";

export { exchangeStravaCode, type StravaTokens } from "./api";

const STRAVA_SETTINGS: SettingDescriptor[] = [
  {
    key: "clientId",
    type: "string",
    secret: true,
    required: true,
    description: "Strava OAuth application client id, from strava.com/settings/api.",
  },
  {
    key: "clientSecret",
    type: "string",
    secret: true,
    required: true,
    description: "Strava OAuth application client secret, from strava.com/settings/api.",
  },
];

export const STRAVA_STATE_KEYS = { ...STRAVA_API_STATE_KEYS };

export const stravaIntegration: Integration = {
  name: "strava",
  settings: STRAVA_SETTINGS,

  async fetchToday(context: SourceContext): Promise<HabitValue[]> {
    const { settings } = context;
    const clientId = await settings.getString("clientId");
    const clientSecret = await settings.getString("clientSecret");
    const habitId = await settings.getString("habitId");
    if (!clientId || !clientSecret || !habitId) {
      throw new Error("strava is enabled but a required setting resolved empty; this should be unreachable");
    }
    const activities = await fetchApiActivities(context, clientId, clientSecret);
    return [{ habitId, value: totalMovingMinutes(activities), unit: "min" }];
  },

  routes: [...stravaApiRoutes],
};
```

- [ ] **Step 3: Run the existing tests unchanged**

Run: `npx vitest run src/integrations/strava/index.test.ts && npm run typecheck`
Expected: PASS — every existing Strava test, with no test file edited. This is the proof the move was behavior-preserving.

- [ ] **Step 4: Commit**

```bash
git add src/integrations/strava/api.ts src/integrations/strava/index.ts
git commit -m "refactor(strava): split the oauth reader into api.ts"
```

---

### Task 4: The web reader and session routes

**Files:**
- Create: `src/integrations/strava/web.ts`
- Test: `src/integrations/strava/web.test.ts`

**Interfaces:**
- Consumes: `StravaActivity` from `./activities`; `naiveLocalMidnightEpochSeconds` from `../../time`
- Produces: `STRAVA_WEB_STATE_KEYS`, `interface StravaSession { cookie: string; updatedAt: string }`, `interface WebReadResult`, `readStravaSession(env: Env): Promise<StravaSession | null>`, `fetchWebActivities(context: SourceContext, session: StravaSession): Promise<WebReadResult>`, `stravaWebRoutes: IntegrationRoute[]`

- [ ] **Step 1: Write the failing tests**

Create `src/integrations/strava/web.test.ts`:

```ts
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import worker from "../../index";
import { readJson, writeJson } from "../../state";
import { SettingsResolver } from "../../settings";
import { AuthNeededError, type Env, type SourceContext } from "../types";
import { fetchWebActivities, STRAVA_WEB_STATE_KEYS, type StravaSession } from "./web";
import { stravaIntegration } from "./index";

const now = new Date("2026-08-04T10:00:00Z");
// Naive Berlin midnight: what start_date_local_raw is compared against.
const todayStart = Date.parse("2026-08-04T00:00:00Z") / 1000;
const session: StravaSession = { cookie: "_strava4_session=abc", updatedAt: "2026-08-04T00:00:00.000Z" };

function makeContext(fetchFn: typeof fetch): SourceContext {
  const testEnv: Env = { ...env, HABIT_ID_STRAVA: "habit-s" };
  const settings = new SettingsResolver(testEnv, testEnv.STATE, "strava", stravaIntegration.settings);
  return { env: testEnv, timeZone: "Europe/Berlin", today: "2026-08-04", now, fetchFn, settings };
}

function jsonFetch(body: unknown): typeof fetch {
  return (async () => Response.json(body)) as typeof fetch;
}

describe("fetchWebActivities", () => {
  it("requests the training activities page with the stored cookie and browser headers", async () => {
    const seen: { url: string; headers: Headers }[] = [];
    const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push({ url: String(input), headers: new Headers(init?.headers) });
      return Response.json({ models: [] });
    }) as typeof fetch;

    await fetchWebActivities(makeContext(fetchFn), session);

    expect(seen[0].url).toBe("https://www.strava.com/athlete/training_activities?page=1&per_page=100");
    expect(seen[0].headers.get("Cookie")).toBe("_strava4_session=abc");
    expect(seen[0].headers.get("X-Requested-With")).toBe("XMLHttpRequest");
    expect(seen[0].headers.get("Referer")).toBe("https://www.strava.com/athlete/training");
    expect(seen[0].headers.get("User-Agent")).toContain("Mozilla/5.0");
  });

  it("sums today's activities and reports which field names matched", async () => {
    const result = await fetchWebActivities(
      makeContext(
        jsonFetch({
          models: [
            { moving_time_raw: 1800, start_date_local_raw: todayStart + 3600 },
            { moving_time_raw: 900, start_date_local_raw: todayStart + 7200 },
          ],
        }),
      ),
      session,
    );

    expect(result.activities).toEqual([{ movingTimeSeconds: 1800 }, { movingTimeSeconds: 900 }]);
    expect(result.diagnostics).toEqual({
      reader: "web",
      activitiesSeen: 2,
      activitiesCounted: 2,
      fieldsMatched: { movingTime: "moving_time_raw", startedAt: "start_date_local_raw" },
    });
  });

  it("falls back to the alternate field names and records that it did", async () => {
    const result = await fetchWebActivities(
      makeContext(jsonFetch({ models: [{ moving_time: 600, start_date_local: todayStart + 60 }] })),
      session,
    );

    expect(result.activities).toEqual([{ movingTimeSeconds: 600 }]);
    expect(result.diagnostics.fieldsMatched).toEqual({ movingTime: "moving_time", startedAt: "start_date_local" });
  });

  it("skips a model with no recognizable fields rather than counting it as zero", async () => {
    const result = await fetchWebActivities(
      makeContext(
        jsonFetch({ models: [{ renamed_time: 1800, renamed_start: todayStart }, { renamed_time: 60 }] }),
      ),
      session,
    );

    expect(result.activities).toEqual([]);
    expect(result.diagnostics.activitiesSeen).toBe(2);
    expect(result.diagnostics.activitiesCounted).toBe(0);
    expect(result.diagnostics.fieldsMatched).toEqual({ movingTime: null, startedAt: null });
  });

  it("excludes activities from before local midnight", async () => {
    const result = await fetchWebActivities(
      makeContext(
        jsonFetch({
          models: [
            { moving_time_raw: 1800, start_date_local_raw: todayStart + 60 },
            { moving_time_raw: 3600, start_date_local_raw: todayStart - 60 },
          ],
        }),
      ),
      session,
    );

    expect(result.activities).toEqual([{ movingTimeSeconds: 1800 }]);
    expect(result.diagnostics.activitiesSeen).toBe(2);
    expect(result.diagnostics.activitiesCounted).toBe(1);
  });

  it("counts an activity that only the naive boundary admits", async () => {
    // 00:30 Berlin local on 2026-08-04. The true-UTC boundary (localMidnightEpochSeconds) sits two
    // hours later in this frame, so comparing against it would wrongly exclude this activity.
    const result = await fetchWebActivities(
      makeContext(jsonFetch({ models: [{ moving_time_raw: 1200, start_date_local_raw: todayStart + 1800 }] })),
      session,
    );
    expect(result.activities).toEqual([{ movingTimeSeconds: 1200 }]);
  });

  it("scans the whole page rather than stopping at the first old activity", async () => {
    const result = await fetchWebActivities(
      makeContext(
        jsonFetch({
          models: [
            { moving_time_raw: 600, start_date_local_raw: todayStart - 60 },
            { moving_time_raw: 900, start_date_local_raw: todayStart + 60 },
          ],
        }),
      ),
      session,
    );
    expect(result.activities).toEqual([{ movingTimeSeconds: 900 }]);
  });

  it("throws AuthNeededError when Strava rejects the cookie", async () => {
    for (const status of [401, 403]) {
      const fetchFn = (async () => new Response("denied", { status })) as typeof fetch;
      await expect(fetchWebActivities(makeContext(fetchFn), session)).rejects.toThrow(AuthNeededError);
    }
  });

  it("throws a plain error for another non-2xx status", async () => {
    const fetchFn = (async () => new Response("oops", { status: 500 })) as typeof fetch;
    await expect(fetchWebActivities(makeContext(fetchFn), session)).rejects.toThrow(
      "Strava training activities request failed with status 500",
    );
  });

  it("names the content type when a bot challenge returns HTML", async () => {
    const fetchFn = (async () =>
      new Response("<html>challenge</html>", { headers: { "Content-Type": "text/html" } })) as typeof fetch;
    await expect(fetchWebActivities(makeContext(fetchFn), session)).rejects.toThrow("text/html");
  });

  it("throws when models is not an array", async () => {
    await expect(fetchWebActivities(makeContext(jsonFetch({ models: "nope" })), session)).rejects.toThrow(
      "Strava returned an unexpected payload shape",
    );
  });
});

const authedEnv: Env = { ...env, ADMIN_TOKEN: "secret-token", HABITIFY_API_KEY: "habitify-key" };
const bearer = { Authorization: "Bearer secret-token" };

async function request(path: string, init?: RequestInit): Promise<Response> {
  const context = createExecutionContext();
  const response = await worker.fetch(new Request(`https://worker.example${path}`, init), authedEnv, context);
  await waitOnExecutionContext(context);
  return response;
}

describe("PUT /strava/session", () => {
  beforeEach(async () => {
    await env.STATE.delete(STRAVA_WEB_STATE_KEYS.session);
  });

  it("stores the cookie and returns 204", async () => {
    const response = await request("/strava/session", {
      method: "PUT",
      headers: { ...bearer, "Content-Type": "application/json" },
      body: JSON.stringify({ cookie: "_strava4_session=abc; strava_remember_token=xyz" }),
    });

    expect(response.status).toBe(204);
    const stored = await readJson<StravaSession>(env.STATE, STRAVA_WEB_STATE_KEYS.session);
    expect(stored?.cookie).toBe("_strava4_session=abc; strava_remember_token=xyz");
    expect(stored?.updatedAt).toBeTruthy();
  });

  it("returns 400 for a malformed JSON body", async () => {
    const response = await request("/strava/session", {
      method: "PUT",
      headers: { ...bearer, "Content-Type": "application/json" },
      body: "not json",
    });
    expect(response.status).toBe(400);
  });

  it("returns 400 when cookie is missing or empty", async () => {
    const response = await request("/strava/session", {
      method: "PUT",
      headers: { ...bearer, "Content-Type": "application/json" },
      body: JSON.stringify({ cookie: "" }),
    });
    expect(response.status).toBe(400);
  });

  it("rejects a request with no admin token", async () => {
    const response = await request("/strava/session", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cookie: "_strava4_session=abc" }),
    });
    expect(response.status).toBe(401);
  });
});

describe("DELETE /strava/session", () => {
  it("clears the stored session", async () => {
    await writeJson(env.STATE, STRAVA_WEB_STATE_KEYS.session, session);
    const response = await request("/strava/session", { method: "DELETE", headers: bearer });
    expect(response.status).toBe(204);
    expect(await readJson<StravaSession>(env.STATE, STRAVA_WEB_STATE_KEYS.session)).toBeNull();
  });

  it("rejects a request with no admin token", async () => {
    const response = await request("/strava/session", { method: "DELETE" });
    expect(response.status).toBe(401);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/integrations/strava/web.test.ts`
Expected: FAIL — cannot resolve `./web`.

- [ ] **Step 3: Implement web.ts**

Create `src/integrations/strava/web.ts`:

```ts
import { readJson, writeJson } from "../../state";
import { naiveLocalMidnightEpochSeconds } from "../../time";
import {
  AuthNeededError,
  type Env,
  type IntegrationRoute,
  type RouteContext,
  type SourceContext,
} from "../types";
import type { StravaActivity } from "./activities";

const TRAINING_ACTIVITIES_URL = "https://www.strava.com/athlete/training_activities";

// One page is roughly two months of activity for a heavy user and the response is newest-first, so
// a single day is covered with an enormous margin and pagination would only add failure modes.
const TRAINING_ACTIVITIES_PER_PAGE = 100;

export const STRAVA_WEB_STATE_KEYS = {
  session: "strava:session",
};

export interface StravaSession {
  cookie: string;
  updatedAt: string;
}

// Strava's web JSON is undocumented and unversioned, so each field is read through an ordered list
// of names it has been observed under, most current first.
const MOVING_TIME_FIELDS = ["moving_time_raw", "moving_time"] as const;
const STARTED_AT_FIELDS = ["start_date_local_raw", "start_date_local"] as const;

export interface WebReadResult {
  activities: StravaActivity[];
  diagnostics: {
    reader: "web";
    activitiesSeen: number;
    activitiesCounted: number;
    fieldsMatched: { movingTime: string | null; startedAt: string | null };
  };
}

function readNumericField(
  model: Record<string, unknown>,
  names: readonly string[],
): { value: number; field: string } | null {
  for (const name of names) {
    const raw = model[name];
    const value = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
    if (Number.isFinite(value)) {
      return { value, field: name };
    }
  }
  return null;
}

function webHeaders(cookie: string): HeadersInit {
  return {
    Cookie: cookie,
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    Accept: "text/javascript, application/json, text/plain, */*",
    "X-Requested-With": "XMLHttpRequest",
    Referer: "https://www.strava.com/athlete/training",
  };
}

export async function readStravaSession(env: Env): Promise<StravaSession | null> {
  return readJson<StravaSession>(env.STATE, STRAVA_WEB_STATE_KEYS.session);
}

export async function fetchWebActivities(context: SourceContext, session: StravaSession): Promise<WebReadResult> {
  const { timeZone, now, fetchFn } = context;
  const response = await fetchFn(`${TRAINING_ACTIVITIES_URL}?page=1&per_page=${TRAINING_ACTIVITIES_PER_PAGE}`, {
    headers: webHeaders(session.cookie),
  });
  if (response.status === 401 || response.status === 403) {
    throw new AuthNeededError("Strava rejected the stored web session; redo the PUT /strava/session capture");
  }
  if (!response.ok) {
    throw new Error(`Strava training activities request failed with status ${response.status}`);
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    // A bot challenge answers 200 with HTML. Naming the content type here is what tells an operator
    // "you were challenged" rather than leaving an opaque JSON parse error.
    throw new Error(
      `Strava training activities returned non-JSON (content-type: ${response.headers.get("Content-Type") ?? "none"})`,
    );
  }
  const models = (body as { models?: unknown } | null)?.models;
  if (!Array.isArray(models)) {
    throw new Error("Strava returned an unexpected payload shape");
  }

  const since = naiveLocalMidnightEpochSeconds(timeZone, now);
  const activities: StravaActivity[] = [];
  const fieldsMatched: WebReadResult["diagnostics"]["fieldsMatched"] = { movingTime: null, startedAt: null };

  for (const model of models) {
    if (!model || typeof model !== "object") continue;
    const record = model as Record<string, unknown>;
    const movingTime = readNumericField(record, MOVING_TIME_FIELDS);
    const startedAt = readNumericField(record, STARTED_AT_FIELDS);
    // Skipped, never counted as zero: an unparseable model means the payload shape moved, and a
    // zero-minute activity would disguise that as a plausibly quiet day.
    if (!movingTime || !startedAt) continue;
    fieldsMatched.movingTime ??= movingTime.field;
    fieldsMatched.startedAt ??= startedAt.field;
    if (startedAt.value < since) continue;
    activities.push({ movingTimeSeconds: movingTime.value });
  }

  return {
    activities,
    diagnostics: { reader: "web", activitiesSeen: models.length, activitiesCounted: activities.length, fieldsMatched },
  };
}

async function handlePutSession(request: Request, context: RouteContext): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "malformed JSON body" }, { status: 400 });
  }
  const candidate = body as Record<string, unknown> | null;
  const cookie = candidate !== null && typeof candidate === "object" ? candidate.cookie : undefined;
  if (typeof cookie !== "string" || cookie.length === 0) {
    return Response.json({ error: "expected { cookie } as a non-empty string" }, { status: 400 });
  }
  const session: StravaSession = { cookie, updatedAt: new Date().toISOString() };
  await writeJson(context.env.STATE, STRAVA_WEB_STATE_KEYS.session, session);
  return new Response(null, { status: 204 });
}

async function handleDeleteSession(_request: Request, context: RouteContext): Promise<Response> {
  await context.env.STATE.delete(STRAVA_WEB_STATE_KEYS.session);
  return new Response(null, { status: 204 });
}

export const stravaWebRoutes: IntegrationRoute[] = [
  { method: "PUT", path: "/strava/session", auth: "admin", handler: handlePutSession },
  { method: "DELETE", path: "/strava/session", auth: "admin", handler: handleDeleteSession },
];
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run src/integrations/strava/web.test.ts`
Expected: the `fetchWebActivities` block PASSES. The route blocks still FAIL with 404, because `stravaWebRoutes` is not wired into the integration until Task 5. That is expected — do not fix it here.

- [ ] **Step 5: Commit**

```bash
git add src/integrations/strava/web.ts src/integrations/strava/web.test.ts
git commit -m "feat(strava): read activities from the web session"
```

---

### Task 5: Reader selection

**Files:**
- Modify: `src/integrations/strava/index.ts`
- Test: `src/integrations/strava/index.test.ts`

**Interfaces:**
- Consumes: `totalMovingMinutes`, `fetchApiActivities`, `stravaApiRoutes`, `STRAVA_API_STATE_KEYS`, `fetchWebActivities`, `readStravaSession`, `stravaWebRoutes`, `STRAVA_WEB_STATE_KEYS`
- Produces: `STRAVA_STATE_KEYS` (now `{ tokens, oauthState, session }`), the updated `stravaIntegration`

- [ ] **Step 1: Update the two existing tests that this task intentionally breaks**

In `src/integrations/strava/index.test.ts`:

Replace the `"is disabled without client credentials and habit id"` test with:

```ts
  it("is enabled by habit id alone, since either auth path can supply the rest", async () => {
    const noHabitId: Env = { ...stravaEnv(), HABIT_ID_STRAVA: undefined };
    expect(
      await new SettingsResolver(noHabitId, noHabitId.STATE, "strava", stravaIntegration.settings).isEnabled(),
    ).toBe(false);

    const habitIdOnly: Env = { ...env, HABIT_ID_STRAVA: "habit-s" };
    expect(
      await new SettingsResolver(habitIdOnly, habitIdOnly.STATE, "strava", stravaIntegration.settings).isEnabled(),
    ).toBe(true);
  });
```

In the `"refreshes an expired token..."` test, the returned value now carries a reader diagnostic. Change:

```ts
    expect(values).toEqual([{ habitId: "habit-s", value: 45, unit: "min" }]);
```

to:

```ts
    expect(values).toEqual([{ habitId: "habit-s", value: 45, unit: "min", diagnostics: { reader: "api" } }]);
```

Add a `beforeEach` cleanup of the session key so the OAuth tests are not hijacked by a leftover session — extend the existing `beforeEach` in the `stravaIntegration.fetchToday` describe block:

```ts
  beforeEach(async () => {
    await env.STATE.delete(STRAVA_STATE_KEYS.tokens);
    await env.STATE.delete(STRAVA_STATE_KEYS.session);
  });
```

- [ ] **Step 2: Add the reader-selection tests**

Append inside the `stravaIntegration.fetchToday` describe block, and add `writeJson` plus `STRAVA_WEB_STATE_KEYS` imports as needed:

```ts
  it("prefers the web session over stored OAuth tokens", async () => {
    await writeJson(env.STATE, STRAVA_STATE_KEYS.tokens, {
      accessToken: "access",
      refreshToken: "refresh",
      expiresAt: 9999999999,
    } satisfies StravaTokens);
    await writeJson(env.STATE, STRAVA_STATE_KEYS.session, {
      cookie: "_strava4_session=abc",
      updatedAt: "2026-08-04T00:00:00.000Z",
    });

    const urls: string[] = [];
    const fetchFn = (async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return Response.json({
        models: [{ moving_time_raw: 1800, start_date_local_raw: Date.parse("2026-08-04T06:00:00Z") / 1000 }],
      });
    }) as typeof fetch;

    const values = await stravaIntegration.fetchToday(makeContext(stravaEnv(), fetchFn));

    expect(urls[0]).toContain("/athlete/training_activities");
    expect(urls.some((url) => url.includes("/api/v3/"))).toBe(false);
    expect(values[0].value).toBe(30);
    expect(values[0].diagnostics).toMatchObject({ reader: "web", activitiesCounted: 1 });
  });

  it("throws AuthNeededError naming both paths when neither is configured", async () => {
    const bare: Env = { ...env, HABIT_ID_STRAVA: "habit-s" };
    const fetchFn = (async () => new Response("{}")) as typeof fetch;
    const promise = stravaIntegration.fetchToday(makeContext(bare, fetchFn));
    await expect(promise).rejects.toThrow(AuthNeededError);
    await expect(promise).rejects.toThrow(/\/strava\/session/);
    await expect(promise).rejects.toThrow(/\/strava\/authorize/);
  });
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run src/integrations/strava/index.test.ts`
Expected: FAIL — the enablement test fails (credentials still `required`), the web-preference test hits the API, and the diagnostics assertion fails.

- [ ] **Step 4: Implement reader selection**

Replace `src/integrations/strava/index.ts` with:

```ts
import { totalMovingMinutes } from "./activities";
import { fetchApiActivities, stravaApiRoutes, STRAVA_API_STATE_KEYS } from "./api";
import { fetchWebActivities, readStravaSession, stravaWebRoutes, STRAVA_WEB_STATE_KEYS } from "./web";
import {
  AuthNeededError,
  type HabitValue,
  type Integration,
  type SettingDescriptor,
  type SourceContext,
} from "../types";

export { exchangeStravaCode, type StravaTokens } from "./api";
export { type StravaSession } from "./web";

// Neither credential is `required`: a deployment authenticating by captured web session configures
// no OAuth application at all, so requiring them would hold that deployment permanently "disabled".
// habitId alone therefore enables the integration, exactly as it does for kindle.
const STRAVA_SETTINGS: SettingDescriptor[] = [
  {
    key: "clientId",
    type: "string",
    secret: true,
    description: "Strava OAuth application client id, from strava.com/settings/api. Not needed when using a web session.",
  },
  {
    key: "clientSecret",
    type: "string",
    secret: true,
    description:
      "Strava OAuth application client secret, from strava.com/settings/api. Not needed when using a web session.",
  },
];

export const STRAVA_STATE_KEYS = { ...STRAVA_API_STATE_KEYS, ...STRAVA_WEB_STATE_KEYS };

export const stravaIntegration: Integration = {
  name: "strava",
  settings: STRAVA_SETTINGS,

  async fetchToday(context: SourceContext): Promise<HabitValue[]> {
    const { env, settings } = context;
    // Guaranteed present: fetchToday only runs once SettingsResolver.isEnabled() has confirmed
    // every required setting resolved non-empty (habitId is strava's only required setting).
    const habitId = await settings.getString("habitId");
    if (!habitId) {
      throw new Error("strava is enabled but habitId resolved empty; this should be unreachable");
    }

    // A captured session wins: capturing one is always a deliberate act, so it is what an operator
    // migrating off the paywalled API expects to take effect without touching any other setting.
    const session = await readStravaSession(env);
    if (session) {
      const { activities, diagnostics } = await fetchWebActivities(context, session);
      return [{ habitId, value: totalMovingMinutes(activities), unit: "min", diagnostics }];
    }

    const clientId = await settings.getString("clientId");
    const clientSecret = await settings.getString("clientSecret");
    if (!clientId || !clientSecret) {
      throw new AuthNeededError(
        "Strava has neither a web session nor API credentials; capture one with PUT /strava/session, or set STRAVA_CLIENT_ID and STRAVA_CLIENT_SECRET then open /strava/authorize",
      );
    }
    const activities = await fetchApiActivities(context, clientId, clientSecret);
    return [{ habitId, value: totalMovingMinutes(activities), unit: "min", diagnostics: { reader: "api" } }];
  },

  routes: [...stravaApiRoutes, ...stravaWebRoutes],
};
```

- [ ] **Step 5: Run the full suite**

Run: `npx vitest run src/integrations/strava/ && npm run typecheck`
Expected: PASS — including the Task 4 route tests, which now resolve.

- [ ] **Step 6: Commit**

```bash
git add src/integrations/strava/index.ts src/integrations/strava/index.test.ts
git commit -m "feat(strava): prefer a captured web session over the oauth api"
```

---

### Task 6: Regenerate artifacts and document both paths

**Files:**
- Modify: `src/integrations/strava/README.md`
- Regenerate: `scripts/settings-manifest.json`, the root `README.md` integrations block

**Interfaces:**
- Consumes: the finished integration from Task 5
- Produces: nothing consumed by later tasks

- [ ] **Step 1: Regenerate both artifacts**

Run: `npm run generate`

This rewrites `scripts/settings-manifest.json` (both credentials now `"required": false`) and the root README integrations block.

- [ ] **Step 2: Rewrite the Strava README**

In `src/integrations/strava/README.md`:

- Change the **What it logs** paragraph to note the value is the sum of moving time across activities since local midnight, read either from the API or from a captured web session.
- Change the settings table's `Required` column to `no` for both `clientId` and `clientSecret`, noting each is needed only for the API path.
- Add a **Setup** section for the web-session path ahead of the existing OAuth one, since it is now the default recommendation:

```markdown
## Setup — web session (no API subscription)

Strava's Developer Program requires a paid subscription for Standard-tier API
access as of June 2026. This path needs no API application at all; it reads
the same activities through Strava's own web app.

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

4. Set `HABIT_ID_STRAVA` and deploy.

The cookie includes `strava_remember_token`, a long-lived JWT, so re-capture
is rare. When it does expire, `GET /status` reports `auth_needed` and
`monitor.yml` emails the failure — repeat step 3.
```

- Add the two new routes to the routes table:

```markdown
| `PUT /strava/session` | `admin` | Stores the captured browser cookie |
| `DELETE /strava/session` | `admin` | Clears the stored session |
```

- Add `strava:session` to the stored-state table with contents `{ cookie, updatedAt }`.
- Add these gotchas:

```markdown
- **A captured session wins over OAuth.** If `strava:session` exists it is
  used, even when valid API tokens are also stored. To go back to the API,
  `DELETE /strava/session` first.
- **The web JSON is undocumented.** Strava can rename fields in
  `/athlete/training_activities` without notice. `GET /status` carries
  `activitiesSeen` and `activitiesCounted`: seeing activities but counting
  none is the signature of a rename, as distinct from a genuine rest day,
  which reports both as 0.
- **Travel days.** The web reader filters on `start_date_local_raw`, which is
  local to where the activity was recorded, not to `TIMEZONE`. An activity
  recorded in another timezone can land on the adjacent day near midnight.
- **`GET /status` states.** `"disabled"` now means only that
  `HABIT_ID_STRAVA` is unset. `"auth_needed"` means neither auth path is
  usable: no session captured and no completed `/strava/authorize`, or a
  rejected cookie or token.
```

- [ ] **Step 3: Verify everything green**

Run: `npm run typecheck && npm test && npm run preflight`
Expected: PASS — including `test/settings-manifest.test.ts` and `test/readme-integrations.test.ts`, which fail on any drift between the generated artifacts and the registry.

- [ ] **Step 4: Commit**

```bash
git add src/integrations/strava/README.md README.md scripts/settings-manifest.json
git commit -m "docs(strava): document the web session path"
```

---

## Self-Review

**Spec coverage.** Reader selection → Task 5. Shared activity shape → Task 2. Web reader endpoint, headers, single page, whole-page scan → Task 4. Day-boundary helper and its regression test → Tasks 1 and 4. Defensive field names, skip-don't-zero, diagnostics → Task 4. Session routes → Task 4 (implementation) and Task 5 (wiring). File split → Tasks 3–5. Settings change and its `disabled`→`auth_needed` consequence → Task 5, documented in Task 6. Generated artifacts → Task 6. Every testing bullet in the spec maps to a named test above.

**Deviation.** `StravaActivity.startedAt` dropped — recorded under "Deviation from the spec" above.

**Type consistency.** `STRAVA_API_STATE_KEYS` (api.ts), `STRAVA_WEB_STATE_KEYS` (web.ts), and the merged `STRAVA_STATE_KEYS` (index.ts) are used under those exact names throughout. `fetchWebActivities` takes `(context, session)` and returns `WebReadResult` in both Task 4's tests and Task 5's caller. `fetchApiActivities(context, clientId, clientSecret)` matches between Tasks 3 and 5. `totalMovingMinutes` takes `readonly StravaActivity[]` in Tasks 2, 3, and 5.

**Known intentional red state.** Task 4's route tests fail until Task 5 wires `stravaWebRoutes` in. This is called out in Task 4 Step 4 so an implementer does not "fix" it early.
