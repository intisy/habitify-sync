# habitify-sync Implementation Plan

*This is a historical planning artifact and does not reflect the final implementation — Kindle and the Amazon-cookies route were dropped (see the design doc's ["Kindle — Not implemented"](../specs/2026-08-04-habitify-sync-design.md#kindle--not-implemented) section); see the [README](../../../README.md) for current behavior.*

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Cloudflare Worker that syncs Kindle pages read, Strava activity minutes, and WakaTime coding minutes into Habitify habits hourly, with a connector interface that makes new integrations one-file additions.

**Architecture:** Single Worker with a `scheduled` (hourly cron) and `fetch` (admin HTTP API) handler. Each service implements the `Source` interface in `src/sources/`; `sync.ts` iterates a registry, isolates failures per source, upserts values through a shared Habitify client, and records per-source status in one KV namespace.

**Tech Stack:** TypeScript (strict), Cloudflare Workers, Wrangler, Vitest with `@cloudflare/vitest-pool-workers`. Zero runtime dependencies.

## Global Constraints

- Repo root: `F:\Documents\GitHub\web\habitify-sync` (already a git repo with the spec committed). Public GitHub repo named `habitify-sync`.
- TypeScript strict mode; no runtime npm dependencies — Workers built-ins only (`fetch`, `crypto`, `btoa`, `Intl`).
- Meaningful variable names, no abbreviations. Comments only on non-obvious logic.
- Commit messages describe the change plainly — no task/phase references like "(Task 3)".
- Secrets NEVER in committed files: `.dev.vars` is gitignored; production secrets via `wrangler secret put`. `.dev.vars.example` documents every key with dummy values.
- Secrets: `HABITIFY_API_KEY`, `STRAVA_CLIENT_ID`, `STRAVA_CLIENT_SECRET`, `WAKATIME_API_KEY`, `ADMIN_TOKEN`. Non-secret vars (in `wrangler.toml`): `TIMEZONE` (default `Europe/Berlin`), `HABIT_ID_KINDLE`, `HABIT_ID_STRAVA`, `HABIT_ID_WAKATIME`.
- Run all commands from the repo root. Tests: `npm test`. Typecheck: `npm run typecheck`.
- TDD everywhere: write the failing test, see it fail, implement, see it pass, commit.

---

### Task 1: Project scaffold

**Files:**
- Create: `package.json`, `tsconfig.json`, `wrangler.toml`, `vitest.config.ts`, `.gitignore`, `.dev.vars.example`, `test/env.d.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: a repo where `npm test` and `npm run typecheck` pass; the `STATE` KV binding and all vars exist for later tasks.

- [ ] **Step 1: Write config files**

`package.json`:

```json
{
  "name": "habitify-sync",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "wrangler dev",
    "deploy": "wrangler deploy",
    "test": "vitest run --passWithNoTests",
    "typecheck": "tsc --noEmit"
  },
  "devDependencies": {
    "@cloudflare/vitest-pool-workers": "^0.8.0",
    "@cloudflare/workers-types": "^4.20260101.0",
    "typescript": "^5.6.0",
    "vitest": "^3.0.0",
    "wrangler": "^4.0.0"
  }
}
```

`tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2022"],
    "types": ["@cloudflare/workers-types", "@cloudflare/vitest-pool-workers"],
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true
  },
  "include": ["src/**/*.ts", "test/**/*.ts"]
}
```

`wrangler.toml` (the KV `id` is a placeholder overwritten in Task 10 when the real namespace is created; tests do not validate it):

```toml
name = "habitify-sync"
main = "src/index.ts"
compatibility_date = "2026-01-01"

[triggers]
crons = ["0 * * * *"]

[vars]
TIMEZONE = "Europe/Berlin"
HABIT_ID_KINDLE = ""
HABIT_ID_STRAVA = ""
HABIT_ID_WAKATIME = ""

[[kv_namespaces]]
binding = "STATE"
id = "0000000000000000000000000000000000000000"
```

`vitest.config.ts`:

```ts
import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: { wrangler: { configPath: "./wrangler.toml" } },
    },
  },
});
```

`.gitignore`:

```
node_modules/
.dev.vars
.wrangler/
dist/
```

`.dev.vars.example`:

```
HABITIFY_API_KEY=your-habitify-api-key
STRAVA_CLIENT_ID=12345
STRAVA_CLIENT_SECRET=your-strava-client-secret
WAKATIME_API_KEY=waka_00000000-0000-0000-0000-000000000000
ADMIN_TOKEN=choose-a-long-random-string
```

`test/env.d.ts`:

```ts
import type { Env } from "../src/sources/types";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}
```

- [ ] **Step 2: Install and verify**

Run: `npm install`, then `npm test` and `npm run typecheck`.
Expected: `npm test` passes with "no tests found" (allowed by `--passWithNoTests`). Typecheck fails right now because `test/env.d.ts` imports `src/sources/types` which does not exist yet — create a minimal `src/sources/types.ts` in this task containing only the `Env` interface below (Task 2 onward extends this file):

```ts
export interface Env {
  STATE: KVNamespace;
  HABITIFY_API_KEY: string;
  ADMIN_TOKEN: string;
  TIMEZONE?: string;
  HABIT_ID_KINDLE?: string;
  HABIT_ID_STRAVA?: string;
  HABIT_ID_WAKATIME?: string;
  STRAVA_CLIENT_ID?: string;
  STRAVA_CLIENT_SECRET?: string;
  WAKATIME_API_KEY?: string;
}
```

Re-run both commands. Expected: both pass.

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json tsconfig.json wrangler.toml vitest.config.ts .gitignore .dev.vars.example test/env.d.ts src/sources/types.ts
git commit -m "Scaffold Cloudflare Worker project with Vitest workers pool"
```

---

### Task 2: Time helpers

**Files:**
- Create: `src/time.ts`
- Test: `test/time.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `todayInTimeZone(timeZone: string, now: Date): string` — `YYYY-MM-DD`
  - `timeZoneOffsetMinutes(timeZone: string, at: Date): number`
  - `localMidnightEpochSeconds(timeZone: string, now: Date): number`
  - `isoDayRange(timeZone: string, now: Date): { start: string; end: string }` — ISO8601 with offset, e.g. `2026-08-04T00:00:00+02:00`

- [ ] **Step 1: Write the failing tests**

`test/time.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { isoDayRange, localMidnightEpochSeconds, todayInTimeZone } from "../src/time";

describe("todayInTimeZone", () => {
  it("returns the local date for Europe/Berlin", () => {
    expect(todayInTimeZone("Europe/Berlin", new Date("2026-08-04T10:00:00Z"))).toBe("2026-08-04");
  });

  it("rolls to the next day when local time crosses midnight before UTC", () => {
    expect(todayInTimeZone("Europe/Berlin", new Date("2026-08-04T23:30:00Z"))).toBe("2026-08-05");
  });
});

describe("localMidnightEpochSeconds", () => {
  it("returns 22:00 UTC of the previous day during Berlin summer time", () => {
    const epoch = localMidnightEpochSeconds("Europe/Berlin", new Date("2026-08-04T10:00:00Z"));
    expect(epoch).toBe(Date.parse("2026-08-03T22:00:00Z") / 1000);
  });

  it("returns 23:00 UTC of the previous day during Berlin winter time", () => {
    const epoch = localMidnightEpochSeconds("Europe/Berlin", new Date("2026-01-15T10:00:00Z"));
    expect(epoch).toBe(Date.parse("2026-01-14T23:00:00Z") / 1000);
  });
});

describe("isoDayRange", () => {
  it("returns start and end of day with the local offset", () => {
    const range = isoDayRange("Europe/Berlin", new Date("2026-08-04T10:00:00Z"));
    expect(range.start).toBe("2026-08-04T00:00:00+02:00");
    expect(range.end).toBe("2026-08-04T23:59:59+02:00");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/time.test.ts`
Expected: FAIL — cannot resolve `../src/time`.

- [ ] **Step 3: Implement `src/time.ts`**

```ts
export function todayInTimeZone(timeZone: string, now: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

export function timeZoneOffsetMinutes(timeZone: string, at: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(at);
  const part = (type: string) => Number(parts.find((candidate) => candidate.type === type)!.value);
  const asUtc = Date.UTC(
    part("year"),
    part("month") - 1,
    part("day"),
    part("hour") % 24,
    part("minute"),
    part("second"),
  );
  return Math.round((asUtc - at.getTime()) / 60000);
}

export function localMidnightEpochSeconds(timeZone: string, now: Date): number {
  const today = todayInTimeZone(timeZone, now);
  const utcMidnightMs = Date.parse(`${today}T00:00:00Z`);
  // Offset sampled at noon local date avoids ambiguity on DST switch days.
  const offsetMinutes = timeZoneOffsetMinutes(timeZone, new Date(utcMidnightMs + 12 * 3600 * 1000));
  return utcMidnightMs / 1000 - offsetMinutes * 60;
}

function offsetSuffix(offsetMinutes: number): string {
  const sign = offsetMinutes < 0 ? "-" : "+";
  const absolute = Math.abs(offsetMinutes);
  const hours = String(Math.floor(absolute / 60)).padStart(2, "0");
  const minutes = String(absolute % 60).padStart(2, "0");
  return `${sign}${hours}:${minutes}`;
}

export function isoDayRange(timeZone: string, now: Date): { start: string; end: string } {
  const today = todayInTimeZone(timeZone, now);
  const noonUtc = new Date(Date.parse(`${today}T12:00:00Z`));
  const suffix = offsetSuffix(timeZoneOffsetMinutes(timeZone, noonUtc));
  return {
    start: `${today}T00:00:00${suffix}`,
    end: `${today}T23:59:59${suffix}`,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/time.test.ts` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/time.ts test/time.test.ts
git commit -m "Add timezone-aware day helpers"
```

---

### Task 3: Source interface and Habitify client

**Files:**
- Modify: `src/sources/types.ts` (extend — keep the `Env` interface from Task 1)
- Create: `src/habitify.ts`
- Test: `test/habitify.test.ts`

**Interfaces:**
- Consumes: `isoDayRange` from `src/time.ts`.
- Produces:
  - Types in `src/sources/types.ts`: `HabitValue { habitId: string; value: number; unit: string }`, `SourceContext { env: Env; timeZone: string; today: string; now: Date; fetchFn: typeof fetch }`, `Source { name: string; enabled(env: Env): boolean; fetchToday(context: SourceContext): Promise<HabitValue[]> }`, `class AuthNeededError extends Error`.
  - `class HabitifyClient { constructor(apiKey: string, fetchFn?: typeof fetch, baseUrl?: string); upsertTodayLog(habit: HabitValue, timeZone: string, now: Date): Promise<void> }`.

- [ ] **Step 1: Extend `src/sources/types.ts`**

Append below the existing `Env` interface:

```ts
export interface HabitValue {
  habitId: string;
  value: number;
  unit: string;
}

export interface SourceContext {
  env: Env;
  timeZone: string;
  today: string;
  now: Date;
  fetchFn: typeof fetch;
}

export interface Source {
  name: string;
  enabled(env: Env): boolean;
  fetchToday(context: SourceContext): Promise<HabitValue[]>;
}

export class AuthNeededError extends Error {}
```

- [ ] **Step 2: Write the failing tests**

`test/habitify.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { HabitifyClient } from "../src/habitify";

interface RecordedRequest {
  method: string;
  url: string;
  body: string | undefined;
  authorization: string | null;
}

function recordingFetch(recorded: RecordedRequest[], status = 200): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    recorded.push({
      method: init?.method ?? "GET",
      url: String(input),
      body: init?.body === undefined ? undefined : String(init.body),
      authorization: new Headers(init?.headers).get("Authorization"),
    });
    return new Response(status === 200 ? "{}" : "error", { status });
  }) as typeof fetch;
}

describe("HabitifyClient.upsertTodayLog", () => {
  const now = new Date("2026-08-04T10:00:00Z");

  it("deletes today's logs then posts the new value", async () => {
    const recorded: RecordedRequest[] = [];
    const client = new HabitifyClient("api-key", recordingFetch(recorded), "https://habitify.example");
    await client.upsertTodayLog({ habitId: "habit-1", value: 42, unit: "min" }, "Europe/Berlin", now);

    expect(recorded).toHaveLength(2);
    expect(recorded[0].method).toBe("DELETE");
    expect(recorded[0].url).toBe(
      "https://habitify.example/logs/habit-1?from=2026-08-04T00%3A00%3A00%2B02%3A00&to=2026-08-04T23%3A59%3A59%2B02%3A00",
    );
    expect(recorded[0].authorization).toBe("api-key");
    expect(recorded[1].method).toBe("POST");
    expect(recorded[1].url).toBe("https://habitify.example/logs/habit-1");
    expect(JSON.parse(recorded[1].body!)).toEqual({
      unit_type: "min",
      value: 42,
      target_date: "2026-08-04T00:00:00+02:00",
    });
  });

  it("throws on a non-ok response", async () => {
    const client = new HabitifyClient("api-key", recordingFetch([], 401), "https://habitify.example");
    await expect(
      client.upsertTodayLog({ habitId: "habit-1", value: 1, unit: "min" }, "Europe/Berlin", now),
    ).rejects.toThrow("Habitify DELETE");
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run test/habitify.test.ts` — Expected: FAIL, cannot resolve `../src/habitify`.

- [ ] **Step 4: Implement `src/habitify.ts`**

```ts
import type { HabitValue } from "./sources/types";
import { isoDayRange } from "./time";

const HABITIFY_BASE_URL = "https://api.habitify.me";

export class HabitifyClient {
  constructor(
    private readonly apiKey: string,
    private readonly fetchFn: typeof fetch = fetch,
    private readonly baseUrl: string = HABITIFY_BASE_URL,
  ) {}

  private async request(method: string, path: string, body?: unknown): Promise<void> {
    const response = await this.fetchFn(`${this.baseUrl}${path}`, {
      method,
      headers: { Authorization: this.apiKey, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) {
      throw new Error(`Habitify ${method} ${path} failed with status ${response.status}: ${await response.text()}`);
    }
  }

  // Habitify appends logs, so an idempotent write is delete-today-then-post.
  async upsertTodayLog(habit: HabitValue, timeZone: string, now: Date): Promise<void> {
    const { start, end } = isoDayRange(timeZone, now);
    const range = `?from=${encodeURIComponent(start)}&to=${encodeURIComponent(end)}`;
    await this.request("DELETE", `/logs/${habit.habitId}${range}`);
    await this.request("POST", `/logs/${habit.habitId}`, {
      unit_type: habit.unit,
      value: habit.value,
      target_date: start,
    });
  }
}
```

- [ ] **Step 5: Run tests and typecheck**

Run: `npx vitest run test/habitify.test.ts && npm run typecheck` — Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/sources/types.ts src/habitify.ts test/habitify.test.ts
git commit -m "Add source interface and Habitify upsert client"
```

---

### Task 4: KV state helpers

**Files:**
- Create: `src/state.ts`
- Test: `test/state.test.ts`

**Interfaces:**
- Consumes: `Env` from `src/sources/types.ts` (KV binding `STATE`).
- Produces:
  - `STATE_KEYS = { stravaTokens: "strava:tokens", stravaOauthState: "strava:oauth_state", amazonCookies: "kindle:amazon_cookies", sourceStatus: (sourceName: string) => \`status:\${sourceName}\` }`
  - `interface StravaTokens { accessToken: string; refreshToken: string; expiresAt: number }`
  - `interface AmazonCookies { cookie: string; updatedAt: string }`
  - `interface SourceStatus { state: "ok" | "error" | "auth_needed" | "disabled"; lastSuccessAt?: string; lastErrorAt?: string; lastError?: string; values?: HabitValue[] }`
  - `readJson<T>(kv: KVNamespace, key: string): Promise<T | null>`
  - `writeJson(kv: KVNamespace, key: string, value: unknown, ttlSeconds?: number): Promise<void>`

- [ ] **Step 1: Write the failing tests**

`test/state.test.ts`:

```ts
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { readJson, STATE_KEYS, writeJson } from "../src/state";

describe("state helpers", () => {
  it("round-trips JSON values through KV", async () => {
    await writeJson(env.STATE, STATE_KEYS.stravaTokens, { accessToken: "a", refreshToken: "r", expiresAt: 1 });
    const tokens = await readJson<{ accessToken: string }>(env.STATE, STATE_KEYS.stravaTokens);
    expect(tokens?.accessToken).toBe("a");
  });

  it("returns null for a missing key", async () => {
    expect(await readJson(env.STATE, "missing-key")).toBeNull();
  });

  it("builds per-source status keys", () => {
    expect(STATE_KEYS.sourceStatus("strava")).toBe("status:strava");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/state.test.ts` — Expected: FAIL, cannot resolve `../src/state`.

- [ ] **Step 3: Implement `src/state.ts`**

```ts
import type { HabitValue } from "./sources/types";

export const STATE_KEYS = {
  stravaTokens: "strava:tokens",
  stravaOauthState: "strava:oauth_state",
  amazonCookies: "kindle:amazon_cookies",
  sourceStatus: (sourceName: string) => `status:${sourceName}`,
};

export interface StravaTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

export interface AmazonCookies {
  cookie: string;
  updatedAt: string;
}

export interface SourceStatus {
  state: "ok" | "error" | "auth_needed" | "disabled";
  lastSuccessAt?: string;
  lastErrorAt?: string;
  lastError?: string;
  values?: HabitValue[];
}

export async function readJson<T>(kv: KVNamespace, key: string): Promise<T | null> {
  const raw = await kv.get(key);
  return raw === null ? null : (JSON.parse(raw) as T);
}

export async function writeJson(kv: KVNamespace, key: string, value: unknown, ttlSeconds?: number): Promise<void> {
  await kv.put(key, JSON.stringify(value), ttlSeconds === undefined ? undefined : { expirationTtl: ttlSeconds });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/state.test.ts` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/state.ts test/state.test.ts
git commit -m "Add KV state helpers and status types"
```

---

### Task 5: WakaTime source

**Files:**
- Create: `src/sources/wakatime.ts`
- Test: `test/sources/wakatime.test.ts`

**Interfaces:**
- Consumes: `Source`, `SourceContext`, `HabitValue`, `Env` from `src/sources/types.ts`.
- Produces: `wakatimeSource: Source` (name `"wakatime"`).

- [ ] **Step 1: Write the failing tests**

`test/sources/wakatime.test.ts`:

```ts
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { wakatimeSource } from "../../src/sources/wakatime";
import type { Env, SourceContext } from "../../src/sources/types";

function makeContext(testEnv: Env, fetchFn: typeof fetch): SourceContext {
  return { env: testEnv, timeZone: "Europe/Berlin", today: "2026-08-04", now: new Date("2026-08-04T10:00:00Z"), fetchFn };
}

describe("wakatimeSource", () => {
  it("is disabled without an API key and habit id", () => {
    expect(wakatimeSource.enabled({ ...env, WAKATIME_API_KEY: undefined })).toBe(false);
    expect(wakatimeSource.enabled({ ...env, WAKATIME_API_KEY: "key", HABIT_ID_WAKATIME: "" })).toBe(false);
    expect(wakatimeSource.enabled({ ...env, WAKATIME_API_KEY: "key", HABIT_ID_WAKATIME: "habit-w" })).toBe(true);
  });

  it("sums today's grand total into minutes", async () => {
    const requested: string[] = [];
    const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requested.push(String(input));
      expect(new Headers(init?.headers).get("Authorization")).toBe(`Basic ${btoa("waka-key")}`);
      return Response.json({ data: [{ grand_total: { total_seconds: 5430 } }] });
    }) as typeof fetch;

    const testEnv: Env = { ...env, WAKATIME_API_KEY: "waka-key", HABIT_ID_WAKATIME: "habit-w" };
    const values = await wakatimeSource.fetchToday(makeContext(testEnv, fetchFn));

    expect(requested[0]).toBe("https://wakatime.com/api/v1/users/current/summaries?start=2026-08-04&end=2026-08-04");
    expect(values).toEqual([{ habitId: "habit-w", value: 91, unit: "min" }]);
  });

  it("throws on a non-ok response", async () => {
    const fetchFn = (async () => new Response("nope", { status: 500 })) as typeof fetch;
    const testEnv: Env = { ...env, WAKATIME_API_KEY: "waka-key", HABIT_ID_WAKATIME: "habit-w" };
    await expect(wakatimeSource.fetchToday(makeContext(testEnv, fetchFn))).rejects.toThrow("WakaTime");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/sources/wakatime.test.ts` — Expected: FAIL, cannot resolve module.

- [ ] **Step 3: Implement `src/sources/wakatime.ts`**

```ts
import type { Env, HabitValue, Source, SourceContext } from "./types";

interface WakatimeSummaries {
  data: { grand_total: { total_seconds: number } }[];
}

export const wakatimeSource: Source = {
  name: "wakatime",

  enabled(env: Env): boolean {
    return Boolean(env.WAKATIME_API_KEY && env.HABIT_ID_WAKATIME);
  },

  async fetchToday(context: SourceContext): Promise<HabitValue[]> {
    const { env, today, fetchFn } = context;
    const url = `https://wakatime.com/api/v1/users/current/summaries?start=${today}&end=${today}`;
    const response = await fetchFn(url, {
      headers: { Authorization: `Basic ${btoa(env.WAKATIME_API_KEY!)}` },
    });
    if (!response.ok) {
      throw new Error(`WakaTime summaries request failed with status ${response.status}`);
    }
    const summaries = (await response.json()) as WakatimeSummaries;
    const totalSeconds = summaries.data.reduce((sum, day) => sum + day.grand_total.total_seconds, 0);
    return [{ habitId: env.HABIT_ID_WAKATIME!, value: Math.round(totalSeconds / 60), unit: "min" }];
  },
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/sources/wakatime.test.ts` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/sources/wakatime.ts test/sources/wakatime.test.ts
git commit -m "Add WakaTime source logging coding minutes"
```

---

### Task 6: Strava source

**Files:**
- Create: `src/sources/strava.ts`
- Test: `test/sources/strava.test.ts`

**Interfaces:**
- Consumes: `Source`, `SourceContext`, `AuthNeededError` from `types.ts`; `readJson`, `writeJson`, `STATE_KEYS`, `StravaTokens` from `src/state.ts`; `localMidnightEpochSeconds` from `src/time.ts`.
- Produces:
  - `stravaSource: Source` (name `"strava"`).
  - `STRAVA_TOKEN_URL = "https://www.strava.com/oauth/token"` (exported; Task 8's OAuth callback reuses it).

- [ ] **Step 1: Write the failing tests**

`test/sources/strava.test.ts`:

```ts
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { stravaSource } from "../../src/sources/strava";
import { readJson, STATE_KEYS, writeJson, type StravaTokens } from "../../src/state";
import { AuthNeededError, type Env, type SourceContext } from "../../src/sources/types";

const now = new Date("2026-08-04T10:00:00Z");
const berlinMidnightEpoch = Date.parse("2026-08-03T22:00:00Z") / 1000;

function makeContext(testEnv: Env, fetchFn: typeof fetch): SourceContext {
  return { env: testEnv, timeZone: "Europe/Berlin", today: "2026-08-04", now, fetchFn };
}

function stravaEnv(): Env {
  return { ...env, STRAVA_CLIENT_ID: "client-id", STRAVA_CLIENT_SECRET: "client-secret", HABIT_ID_STRAVA: "habit-s" };
}

describe("stravaSource", () => {
  beforeEach(async () => {
    await env.STATE.delete(STATE_KEYS.stravaTokens);
  });

  it("is disabled without client credentials and habit id", () => {
    expect(stravaSource.enabled({ ...env, STRAVA_CLIENT_ID: undefined })).toBe(false);
    expect(stravaSource.enabled(stravaEnv())).toBe(true);
  });

  it("throws AuthNeededError when no tokens are stored", async () => {
    const fetchFn = (async () => new Response("{}")) as typeof fetch;
    await expect(stravaSource.fetchToday(makeContext(stravaEnv(), fetchFn))).rejects.toThrow(AuthNeededError);
  });

  it("refreshes an expired token, persists the rotated refresh token, and sums today's moving time", async () => {
    const expired: StravaTokens = { accessToken: "old-access", refreshToken: "old-refresh", expiresAt: 1000 };
    await writeJson(env.STATE, STATE_KEYS.stravaTokens, expired);

    const requests: { url: string; body?: string }[] = [];
    const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, body: init?.body === undefined ? undefined : String(init.body) });
      if (url === "https://www.strava.com/oauth/token") {
        return Response.json({ access_token: "new-access", refresh_token: "new-refresh", expires_at: 9999999999 });
      }
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer new-access");
      return Response.json([{ moving_time: 1800 }, { moving_time: 900 }]);
    }) as typeof fetch;

    const values = await stravaSource.fetchToday(makeContext(stravaEnv(), fetchFn));

    expect(JSON.parse(requests[0].body!)).toMatchObject({ grant_type: "refresh_token", refresh_token: "old-refresh" });
    expect(requests[1].url).toBe(
      `https://www.strava.com/api/v3/athlete/activities?after=${berlinMidnightEpoch}&per_page=100`,
    );
    expect(values).toEqual([{ habitId: "habit-s", value: 45, unit: "min" }]);

    const stored = await readJson<StravaTokens>(env.STATE, STATE_KEYS.stravaTokens);
    expect(stored?.refreshToken).toBe("new-refresh");
  });

  it("throws AuthNeededError when the activities call returns 401", async () => {
    const valid: StravaTokens = { accessToken: "access", refreshToken: "refresh", expiresAt: 9999999999 };
    await writeJson(env.STATE, STATE_KEYS.stravaTokens, valid);
    const fetchFn = (async () => new Response("unauthorized", { status: 401 })) as typeof fetch;
    await expect(stravaSource.fetchToday(makeContext(stravaEnv(), fetchFn))).rejects.toThrow(AuthNeededError);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/sources/strava.test.ts` — Expected: FAIL, cannot resolve module.

- [ ] **Step 3: Implement `src/sources/strava.ts`**

```ts
import { readJson, STATE_KEYS, writeJson, type StravaTokens } from "../state";
import { localMidnightEpochSeconds } from "../time";
import { AuthNeededError, type Env, type HabitValue, type Source, type SourceContext } from "./types";

export const STRAVA_TOKEN_URL = "https://www.strava.com/oauth/token";
const STRAVA_ACTIVITIES_URL = "https://www.strava.com/api/v3/athlete/activities";

interface StravaTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_at: number;
}

// Strava rotates refresh tokens on every refresh, so the new one must be persisted.
async function refreshTokens(env: Env, fetchFn: typeof fetch, tokens: StravaTokens): Promise<StravaTokens> {
  const response = await fetchFn(STRAVA_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: env.STRAVA_CLIENT_ID,
      client_secret: env.STRAVA_CLIENT_SECRET,
      grant_type: "refresh_token",
      refresh_token: tokens.refreshToken,
    }),
  });
  if (response.status === 400 || response.status === 401) {
    throw new AuthNeededError("Strava refused the refresh token; re-run /strava/authorize");
  }
  if (!response.ok) {
    throw new Error(`Strava token refresh failed with status ${response.status}`);
  }
  const body = (await response.json()) as StravaTokenResponse;
  const refreshed: StravaTokens = {
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    expiresAt: body.expires_at,
  };
  await writeJson(env.STATE, STATE_KEYS.stravaTokens, refreshed);
  return refreshed;
}

export const stravaSource: Source = {
  name: "strava",

  enabled(env: Env): boolean {
    return Boolean(env.STRAVA_CLIENT_ID && env.STRAVA_CLIENT_SECRET && env.HABIT_ID_STRAVA);
  },

  async fetchToday(context: SourceContext): Promise<HabitValue[]> {
    const { env, timeZone, now, fetchFn } = context;
    let tokens = await readJson<StravaTokens>(env.STATE, STATE_KEYS.stravaTokens);
    if (!tokens) {
      throw new AuthNeededError("Strava is not authorized yet; open /strava/authorize");
    }
    const nowEpoch = Math.floor(now.getTime() / 1000);
    if (tokens.expiresAt <= nowEpoch + 60) {
      tokens = await refreshTokens(env, fetchFn, tokens);
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
    const totalSeconds = activities.reduce((sum, activity) => sum + activity.moving_time, 0);
    return [{ habitId: env.HABIT_ID_STRAVA!, value: Math.round(totalSeconds / 60), unit: "min" }];
  },
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/sources/strava.test.ts` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/sources/strava.ts test/sources/strava.test.ts
git commit -m "Add Strava source with rotating refresh token handling"
```

---

### Task 7: Kindle source

**Files:**
- Create: `src/sources/kindle.ts`, `test/fixtures/kindle-insights.json`
- Test: `test/sources/kindle.test.ts`

**Interfaces:**
- Consumes: `Source`, `AuthNeededError` from `types.ts`; `readJson`, `STATE_KEYS`, `AmazonCookies` from `src/state.ts`.
- Produces: `kindleSource: Source` (name `"kindle"`), `parsePagesReadToday(payload: unknown, today: string): number` (exported for tests).

This source has one deliberately discovery-driven step: Amazon's reading-insights endpoint is unofficial, so the exact URL and JSON shape are captured from the real site first, then locked in by a fixture-based test.

- [ ] **Step 1: Capture the real endpoint and response**

1. Log in at `https://read.amazon.com` in a browser, open `https://read.amazon.com/kindle-reading-insights` (the reading-insights dashboard).
2. Open DevTools → Network → filter XHR/JSON. Reload. Find the request whose response contains daily reading data (pages read / days read). Expected candidates contain `insights` in the path.
3. Copy the full request URL — it becomes the `KINDLE_INSIGHTS_URL` constant in Step 4.
4. Save the raw JSON response body to `test/fixtures/kindle-insights.json` (this is personal but non-secret reading data; if it contains anything sensitive, trim to the fields the parser needs plus one day entry).
5. Note which field holds today's pages read — the parser in Step 4 and the assertion in Step 2 are written against exactly this captured shape (adjust the field access to match the fixture; the fixture keeps it honest).

- [ ] **Step 2: Write the failing tests**

`test/sources/kindle.test.ts` (adjust the expected page count to the fixture's real value for today's date; pick any date present in the fixture as `today`):

```ts
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import fixture from "../fixtures/kindle-insights.json";
import { kindleSource, parsePagesReadToday } from "../../src/sources/kindle";
import { STATE_KEYS, writeJson } from "../../src/state";
import { AuthNeededError, type Env, type SourceContext } from "../../src/sources/types";

const fixtureDay = "2026-08-04"; // a date present in the fixture
const fixturePages = 12; // the pages-read value the fixture holds for that date

function makeContext(testEnv: Env, fetchFn: typeof fetch): SourceContext {
  return { env: testEnv, timeZone: "Europe/Berlin", today: fixtureDay, now: new Date(`${fixtureDay}T10:00:00Z`), fetchFn };
}

function kindleEnv(): Env {
  return { ...env, HABIT_ID_KINDLE: "habit-k" };
}

describe("parsePagesReadToday", () => {
  it("extracts today's pages from the captured insights payload", () => {
    expect(parsePagesReadToday(fixture, fixtureDay)).toBe(fixturePages);
  });

  it("returns 0 for a day with no reading", () => {
    expect(parsePagesReadToday(fixture, "1999-01-01")).toBe(0);
  });
});

describe("kindleSource", () => {
  beforeEach(async () => {
    await env.STATE.delete(STATE_KEYS.amazonCookies);
  });

  it("is disabled without a habit id", () => {
    expect(kindleSource.enabled({ ...env, HABIT_ID_KINDLE: "" })).toBe(false);
    expect(kindleSource.enabled(kindleEnv())).toBe(true);
  });

  it("throws AuthNeededError when no cookies are stored", async () => {
    const fetchFn = (async () => Response.json(fixture)) as typeof fetch;
    await expect(kindleSource.fetchToday(makeContext(kindleEnv(), fetchFn))).rejects.toThrow(AuthNeededError);
  });

  it("throws AuthNeededError when Amazon redirects to sign-in", async () => {
    await writeJson(env.STATE, STATE_KEYS.amazonCookies, { cookie: "session=dead", updatedAt: "2026-08-01T00:00:00Z" });
    const fetchFn = (async () =>
      new Response(null, { status: 302, headers: { Location: "https://www.amazon.com/ap/signin" } })) as typeof fetch;
    await expect(kindleSource.fetchToday(makeContext(kindleEnv(), fetchFn))).rejects.toThrow(AuthNeededError);
  });

  it("sends the stored cookies and returns pages read", async () => {
    await writeJson(env.STATE, STATE_KEYS.amazonCookies, { cookie: "session=alive", updatedAt: "2026-08-04T00:00:00Z" });
    const fetchFn = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("Cookie")).toBe("session=alive");
      return Response.json(fixture);
    }) as typeof fetch;

    const values = await kindleSource.fetchToday(makeContext(kindleEnv(), fetchFn));
    expect(values).toEqual([{ habitId: "habit-k", value: fixturePages, unit: "pages" }]);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run test/sources/kindle.test.ts` — Expected: FAIL, cannot resolve `../../src/sources/kindle`.

- [ ] **Step 4: Implement `src/sources/kindle.ts`**

The skeleton below is complete except the two `CAPTURED:` markers, which are filled from Step 1's capture (URL and the field path into the daily data — the fixture test verifies the result):

```ts
import { readJson, STATE_KEYS, type AmazonCookies } from "../state";
import { AuthNeededError, type Env, type HabitValue, type Source, type SourceContext } from "./types";

// CAPTURED: replace with the exact URL recorded from DevTools in the capture step.
const KINDLE_INSIGHTS_URL = "https://read.amazon.com/kindle-reading-insights/...";

const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

// CAPTURED: adjust the field access to the fixture's real shape; the fixture test locks it in.
export function parsePagesReadToday(payload: unknown, today: string): number {
  const insights = payload as { dailyReadingData?: { date: string; pagesRead: number }[] };
  const day = insights.dailyReadingData?.find((entry) => entry.date === today);
  return day?.pagesRead ?? 0;
}

export const kindleSource: Source = {
  name: "kindle",

  enabled(env: Env): boolean {
    return Boolean(env.HABIT_ID_KINDLE);
  },

  async fetchToday(context: SourceContext): Promise<HabitValue[]> {
    const { env, today, fetchFn } = context;
    const cookies = await readJson<AmazonCookies>(env.STATE, STATE_KEYS.amazonCookies);
    if (!cookies) {
      throw new AuthNeededError("Amazon cookies missing; upload them via PUT /state/amazon-cookies");
    }
    const response = await fetchFn(KINDLE_INSIGHTS_URL, {
      redirect: "manual",
      headers: { Cookie: cookies.cookie, "User-Agent": BROWSER_USER_AGENT, Accept: "application/json" },
    });
    if (response.status >= 300 && response.status < 400) {
      throw new AuthNeededError("Amazon session expired; upload fresh cookies via PUT /state/amazon-cookies");
    }
    if (response.status === 401 || response.status === 403) {
      throw new AuthNeededError("Amazon rejected the session cookies; upload fresh ones");
    }
    if (!response.ok) {
      throw new Error(`Kindle insights request failed with status ${response.status}`);
    }
    const contentType = response.headers.get("Content-Type") ?? "";
    if (!contentType.includes("json")) {
      throw new AuthNeededError("Amazon returned a non-JSON page (likely a sign-in wall); upload fresh cookies");
    }
    const payload = await response.json();
    return [{ habitId: env.HABIT_ID_KINDLE!, value: parsePagesReadToday(payload, today), unit: "pages" }];
  },
};
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run test/sources/kindle.test.ts` — Expected: PASS. If the parser doesn't match the fixture, fix the parser (not the fixture).

- [ ] **Step 6: Commit**

```bash
git add src/sources/kindle.ts test/sources/kindle.test.ts test/fixtures/kindle-insights.json
git commit -m "Add Kindle source reading daily pages from Amazon insights"
```

---

### Task 8: Sync orchestrator and source registry

**Files:**
- Create: `src/sources/registry.ts`, `src/sync.ts`
- Test: `test/sync.test.ts`

**Interfaces:**
- Consumes: everything above.
- Produces:
  - `SOURCES: Source[]` in `src/sources/registry.ts` — THE extension point list.
  - `runSync(env: Env, sources: Source[], now: Date, fetchFn?: typeof fetch, onlySource?: string): Promise<SyncResult[]>` where `SyncResult = { source: string; status: SourceStatus }`.

- [ ] **Step 1: Write the failing tests**

`test/sync.test.ts`:

```ts
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { runSync } from "../src/sync";
import { readJson, STATE_KEYS, writeJson, type SourceStatus } from "../src/state";
import { AuthNeededError, type Env, type Source } from "../src/sources/types";

const now = new Date("2026-08-04T10:00:00Z");

function habitifyFetchRecorder(urls: string[]): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    urls.push(String(input));
    return new Response("{}");
  }) as typeof fetch;
}

function makeSource(name: string, behavior: () => Promise<{ habitId: string; value: number; unit: string }[]>): Source {
  return { name, enabled: () => true, fetchToday: behavior };
}

describe("runSync", () => {
  beforeEach(async () => {
    await env.STATE.delete(STATE_KEYS.sourceStatus("good"));
    await env.STATE.delete(STATE_KEYS.sourceStatus("broken"));
  });

  it("pushes values to Habitify and records ok status", async () => {
    const urls: string[] = [];
    const good = makeSource("good", async () => [{ habitId: "habit-1", value: 10, unit: "min" }]);

    const results = await runSync(env, [good], now, habitifyFetchRecorder(urls));

    expect(results[0].status.state).toBe("ok");
    expect(urls.some((url) => url.includes("/logs/habit-1"))).toBe(true);
    const stored = await readJson<SourceStatus>(env.STATE, STATE_KEYS.sourceStatus("good"));
    expect(stored?.state).toBe("ok");
    expect(stored?.values).toEqual([{ habitId: "habit-1", value: 10, unit: "min" }]);
  });

  it("isolates a throwing source and still runs the others", async () => {
    const urls: string[] = [];
    const broken = makeSource("broken", async () => {
      throw new Error("service exploded");
    });
    const good = makeSource("good", async () => [{ habitId: "habit-1", value: 5, unit: "min" }]);

    const results = await runSync(env, [broken, good], now, habitifyFetchRecorder(urls));

    expect(results.find((result) => result.source === "broken")?.status.state).toBe("error");
    expect(results.find((result) => result.source === "good")?.status.state).toBe("ok");
  });

  it("marks AuthNeededError as auth_needed and preserves the previous lastSuccessAt", async () => {
    await writeJson(env.STATE, STATE_KEYS.sourceStatus("broken"), {
      state: "ok",
      lastSuccessAt: "2026-08-03T10:00:00.000Z",
    } satisfies SourceStatus);
    const broken = makeSource("broken", async () => {
      throw new AuthNeededError("cookies expired");
    });

    const results = await runSync(env, [broken], now, habitifyFetchRecorder([]));

    expect(results[0].status.state).toBe("auth_needed");
    expect(results[0].status.lastError).toBe("cookies expired");
    expect(results[0].status.lastSuccessAt).toBe("2026-08-03T10:00:00.000Z");
  });

  it("reports disabled sources without calling them", async () => {
    const disabled: Source = {
      name: "off",
      enabled: () => false,
      fetchToday: async () => {
        throw new Error("must not be called");
      },
    };
    const results = await runSync(env, [disabled], now, habitifyFetchRecorder([]));
    expect(results[0].status.state).toBe("disabled");
  });

  it("filters to a single source when onlySource is given", async () => {
    const first = makeSource("good", async () => [{ habitId: "habit-1", value: 1, unit: "min" }]);
    const second = makeSource("broken", async () => {
      throw new Error("should be skipped");
    });
    const results = await runSync(env, [first, second], now, habitifyFetchRecorder([]), "good");
    expect(results).toHaveLength(1);
    expect(results[0].source).toBe("good");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/sync.test.ts` — Expected: FAIL, cannot resolve `../src/sync`.

- [ ] **Step 3: Implement registry and orchestrator**

`src/sources/registry.ts`:

```ts
import { kindleSource } from "./kindle";
import { stravaSource } from "./strava";
import type { Source } from "./types";
import { wakatimeSource } from "./wakatime";

// Adding a new integration: implement Source in a new file here and add it to this list.
export const SOURCES: Source[] = [kindleSource, stravaSource, wakatimeSource];
```

`src/sync.ts`:

```ts
import { HabitifyClient } from "./habitify";
import { readJson, STATE_KEYS, writeJson, type SourceStatus } from "./state";
import { AuthNeededError, type Env, type Source, type SourceContext } from "./sources/types";
import { todayInTimeZone } from "./time";

const DEFAULT_TIME_ZONE = "Europe/Berlin";

export interface SyncResult {
  source: string;
  status: SourceStatus;
}

export async function runSync(
  env: Env,
  sources: Source[],
  now: Date,
  fetchFn: typeof fetch = fetch,
  onlySource?: string,
): Promise<SyncResult[]> {
  const timeZone = env.TIMEZONE || DEFAULT_TIME_ZONE;
  const context: SourceContext = { env, timeZone, today: todayInTimeZone(timeZone, now), now, fetchFn };
  const habitify = new HabitifyClient(env.HABITIFY_API_KEY, fetchFn);
  const results: SyncResult[] = [];

  for (const source of sources) {
    if (onlySource && source.name !== onlySource) continue;
    if (!source.enabled(env)) {
      results.push({ source: source.name, status: { state: "disabled" } });
      continue;
    }

    const previous = await readJson<SourceStatus>(env.STATE, STATE_KEYS.sourceStatus(source.name));
    let status: SourceStatus;
    try {
      const values = await source.fetchToday(context);
      for (const value of values) {
        await habitify.upsertTodayLog(value, timeZone, now);
      }
      status = { state: "ok", lastSuccessAt: now.toISOString(), values };
    } catch (error) {
      status = {
        state: error instanceof AuthNeededError ? "auth_needed" : "error",
        lastSuccessAt: previous?.lastSuccessAt,
        lastErrorAt: now.toISOString(),
        lastError: error instanceof Error ? error.message : String(error),
      };
    }
    await writeJson(env.STATE, STATE_KEYS.sourceStatus(source.name), status);
    results.push({ source: source.name, status });
  }

  return results;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/sync.test.ts && npm run typecheck` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/sources/registry.ts src/sync.ts test/sync.test.ts
git commit -m "Add sync orchestrator with per-source failure isolation"
```

---

### Task 9: Worker entry — cron handler and HTTP API

**Files:**
- Create: `src/index.ts`
- Test: `test/index.test.ts`

**Interfaces:**
- Consumes: `runSync`, `SOURCES`, `STATE_KEYS`, `writeJson`, `readJson`, `STRAVA_TOKEN_URL`, `StravaTokens`, `AmazonCookies`.
- Produces: the default Worker export with `fetch` and `scheduled` handlers. Routes:
  - `POST /sync` (optional `?source=<name>`) — runs sync, returns JSON results (bearer auth)
  - `GET /status` — per-source status from KV (bearer auth)
  - `PUT /state/amazon-cookies` — body `{"cookie": "<cookie header string>"}` (bearer auth)
  - `GET /strava/authorize` — redirects to Strava consent (bearer auth via `?token=` query param, since it is opened in a browser)
  - `GET /strava/callback` — exchanges the code, stores tokens (validated by the `state` parameter, no bearer)

- [ ] **Step 1: Write the failing tests**

`test/index.test.ts`:

```ts
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import worker from "../src/index";
import { readJson, STATE_KEYS, writeJson, type AmazonCookies, type SourceStatus } from "../src/state";
import type { Env } from "../src/sources/types";

const authedEnv: Env = { ...env, ADMIN_TOKEN: "secret-token", HABITIFY_API_KEY: "habitify-key" };

async function request(path: string, init?: RequestInit): Promise<Response> {
  const context = createExecutionContext();
  const response = await worker.fetch(new Request(`https://worker.example${path}`, init), authedEnv, context);
  await waitOnExecutionContext(context);
  return response;
}

const bearer = { Authorization: "Bearer secret-token" };

describe("authentication", () => {
  it("rejects requests without the admin token", async () => {
    expect((await request("/status")).status).toBe(401);
    expect((await request("/status", { headers: { Authorization: "Bearer wrong" } })).status).toBe(401);
  });

  it("rejects unknown routes with 404", async () => {
    expect((await request("/nope", { headers: bearer })).status).toBe(404);
  });
});

describe("GET /status", () => {
  it("returns stored per-source status", async () => {
    await writeJson(env.STATE, STATE_KEYS.sourceStatus("kindle"), { state: "ok" } satisfies SourceStatus);
    const response = await request("/status", { headers: bearer });
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, SourceStatus>;
    expect(body.kindle.state).toBe("ok");
  });
});

describe("PUT /state/amazon-cookies", () => {
  it("stores the cookie string with a timestamp", async () => {
    const response = await request("/state/amazon-cookies", {
      method: "PUT",
      headers: { ...bearer, "Content-Type": "application/json" },
      body: JSON.stringify({ cookie: "session-id=abc; at-main=def" }),
    });
    expect(response.status).toBe(204);
    const stored = await readJson<AmazonCookies>(env.STATE, STATE_KEYS.amazonCookies);
    expect(stored?.cookie).toBe("session-id=abc; at-main=def");
    expect(stored?.updatedAt).toBeTruthy();
  });

  it("rejects a body without a cookie string", async () => {
    const response = await request("/state/amazon-cookies", {
      method: "PUT",
      headers: { ...bearer, "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(response.status).toBe(400);
  });
});

describe("GET /strava/authorize", () => {
  it("redirects to Strava consent with a stored state parameter", async () => {
    const stravaEnv: Env = { ...authedEnv, STRAVA_CLIENT_ID: "client-id", STRAVA_CLIENT_SECRET: "client-secret" };
    const context = createExecutionContext();
    const response = await worker.fetch(
      new Request("https://worker.example/strava/authorize?token=secret-token"),
      stravaEnv,
      context,
    );
    await waitOnExecutionContext(context);

    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("Location")!);
    expect(location.origin).toBe("https://www.strava.com");
    expect(location.searchParams.get("client_id")).toBe("client-id");
    expect(location.searchParams.get("redirect_uri")).toBe("https://worker.example/strava/callback");
    const state = location.searchParams.get("state")!;
    expect(await env.STATE.get(STATE_KEYS.stravaOauthState)).toBe(state);
  });
});

describe("GET /strava/callback", () => {
  it("rejects a mismatched state parameter", async () => {
    await env.STATE.put(STATE_KEYS.stravaOauthState, "expected-state");
    const response = await request("/strava/callback?code=abc&state=wrong-state");
    expect(response.status).toBe(403);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/index.test.ts` — Expected: FAIL, cannot resolve `../src/index`.

- [ ] **Step 3: Implement `src/index.ts`**

```ts
import { readJson, STATE_KEYS, writeJson, type AmazonCookies, type SourceStatus, type StravaTokens } from "./state";
import { SOURCES } from "./sources/registry";
import { STRAVA_TOKEN_URL } from "./sources/strava";
import type { Env } from "./sources/types";
import { runSync } from "./sync";

const STRAVA_AUTHORIZE_URL = "https://www.strava.com/oauth/authorize";

function isAuthorized(request: Request, env: Env): boolean {
  const url = new URL(request.url);
  const token = request.headers.get("Authorization")?.replace(/^Bearer /, "") ?? url.searchParams.get("token");
  return Boolean(env.ADMIN_TOKEN) && token === env.ADMIN_TOKEN;
}

async function handleStatus(env: Env): Promise<Response> {
  const statuses: Record<string, SourceStatus | null> = {};
  for (const source of SOURCES) {
    statuses[source.name] = await readJson<SourceStatus>(env.STATE, STATE_KEYS.sourceStatus(source.name));
  }
  return Response.json(statuses);
}

async function handleAmazonCookies(request: Request, env: Env): Promise<Response> {
  const body = (await request.json().catch(() => null)) as { cookie?: unknown } | null;
  if (!body || typeof body.cookie !== "string" || body.cookie.length === 0) {
    return Response.json({ error: 'expected body {"cookie": "<cookie header string>"}' }, { status: 400 });
  }
  const cookies: AmazonCookies = { cookie: body.cookie, updatedAt: new Date().toISOString() };
  await writeJson(env.STATE, STATE_KEYS.amazonCookies, cookies);
  return new Response(null, { status: 204 });
}

async function handleStravaAuthorize(request: Request, env: Env): Promise<Response> {
  if (!env.STRAVA_CLIENT_ID) {
    return Response.json({ error: "STRAVA_CLIENT_ID is not configured" }, { status: 500 });
  }
  const state = crypto.randomUUID();
  await env.STATE.put(STATE_KEYS.stravaOauthState, state, { expirationTtl: 600 });
  const redirect = new URL(STRAVA_AUTHORIZE_URL);
  redirect.searchParams.set("client_id", env.STRAVA_CLIENT_ID);
  redirect.searchParams.set("redirect_uri", `${new URL(request.url).origin}/strava/callback`);
  redirect.searchParams.set("response_type", "code");
  redirect.searchParams.set("scope", "activity:read_all");
  redirect.searchParams.set("state", state);
  return Response.redirect(redirect.toString(), 302);
}

async function handleStravaCallback(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const expectedState = await env.STATE.get(STATE_KEYS.stravaOauthState);
  if (!expectedState || url.searchParams.get("state") !== expectedState) {
    return Response.json({ error: "state mismatch; restart at /strava/authorize" }, { status: 403 });
  }
  const code = url.searchParams.get("code");
  if (!code) {
    return Response.json({ error: "missing code parameter" }, { status: 400 });
  }
  const response = await fetch(STRAVA_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: env.STRAVA_CLIENT_ID,
      client_secret: env.STRAVA_CLIENT_SECRET,
      grant_type: "authorization_code",
      code,
    }),
  });
  if (!response.ok) {
    return Response.json({ error: `Strava code exchange failed with status ${response.status}` }, { status: 502 });
  }
  const body = (await response.json()) as { access_token: string; refresh_token: string; expires_at: number };
  const tokens: StravaTokens = {
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    expiresAt: body.expires_at,
  };
  await writeJson(env.STATE, STATE_KEYS.stravaTokens, tokens);
  await env.STATE.delete(STATE_KEYS.stravaOauthState);
  return new Response("Strava connected. You can close this tab.", { status: 200 });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const route = `${request.method} ${url.pathname}`;

    if (route === "GET /strava/callback") {
      return handleStravaCallback(request, env);
    }
    if (!isAuthorized(request, env)) {
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }
    switch (route) {
      case "POST /sync":
        return Response.json(await runSync(env, SOURCES, new Date(), fetch, url.searchParams.get("source") ?? undefined));
      case "GET /status":
        return handleStatus(env);
      case "PUT /state/amazon-cookies":
        return handleAmazonCookies(request, env);
      case "GET /strava/authorize":
        return handleStravaAuthorize(request, env);
      default:
        return Response.json({ error: "not found" }, { status: 404 });
    }
  },

  async scheduled(_event: ScheduledEvent, env: Env, context: ExecutionContext): Promise<void> {
    context.waitUntil(runSync(env, SOURCES, new Date()));
  },
} satisfies ExportedHandler<Env>;
```

- [ ] **Step 4: Run the full suite and typecheck**

Run: `npm test && npm run typecheck` — Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/index.ts test/index.test.ts
git commit -m "Add worker entry with cron sync and admin HTTP API"
```

---

### Task 10: README, license, deploy, and publish

**Files:**
- Create: `README.md`, `LICENSE`
- Modify: `wrangler.toml` (real KV namespace id, habit ids)

**Interfaces:**
- Consumes: the finished worker.
- Produces: a deployed worker and a public GitHub repo.

- [ ] **Step 1: Write `LICENSE`**

MIT license, copyright `2026 Finn Birich`.

- [ ] **Step 2: Write `README.md`**

Must contain, in this order:
1. One-paragraph description (what it syncs, hourly cron, Habitify).
2. **Setup**: clone; `npm install`; create KV (`npx wrangler kv namespace create STATE`, paste id into `wrangler.toml`); fill habit ids in `wrangler.toml` (find them via Habitify API `GET /habits`); copy `.dev.vars.example` to `.dev.vars` for local dev; set production secrets (`npx wrangler secret put HABITIFY_API_KEY` etc. for all five secrets); `npm run deploy`.
3. **Connecting services**: Strava — create an API application at strava.com/settings/api, set the callback domain to the worker's domain, open `https://<worker-url>/strava/authorize?token=<ADMIN_TOKEN>`; WakaTime — API key from wakatime.com/settings/api-key; Kindle — how to copy the `Cookie` header for read.amazon.com from DevTools and upload it with `curl -X PUT https://<worker-url>/state/amazon-cookies -H "Authorization: Bearer <ADMIN_TOKEN>" -H "Content-Type: application/json" -d "{\"cookie\": \"<value>\"}"`, and that `GET /status` shows `auth_needed` when they expire.
4. **HTTP API**: the route table from the spec.
5. **Adding a new integration**: the recipe — create `src/sources/<name>.ts` implementing `Source`, add it to `SOURCES` in `src/sources/registry.ts`, add its env keys to `Env` in `src/sources/types.ts` and to `.dev.vars.example`, write a test following `test/sources/wakatime.test.ts` as the template.

- [ ] **Step 3: Deploy**

```bash
npx wrangler kv namespace create STATE   # paste the returned id into wrangler.toml
npx wrangler secret put HABITIFY_API_KEY
npx wrangler secret put STRAVA_CLIENT_ID
npx wrangler secret put STRAVA_CLIENT_SECRET
npx wrangler secret put WAKATIME_API_KEY
npx wrangler secret put ADMIN_TOKEN
npm run deploy
```

Fill the three `HABIT_ID_*` vars in `wrangler.toml` with the real Habitify habit ids first (`curl -H "Authorization: <HABITIFY_API_KEY>" https://api.habitify.me/habits`).

- [ ] **Step 4: Verify live**

```bash
curl -X POST "https://<worker-url>/sync" -H "Authorization: Bearer <ADMIN_TOKEN>"
curl "https://<worker-url>/status" -H "Authorization: Bearer <ADMIN_TOKEN>"
```

Expected: WakaTime `ok` immediately; Strava `auth_needed` until the browser authorize flow is done; Kindle `auth_needed` until cookies are uploaded. Complete both flows, re-run `/sync`, and confirm all three read `ok` and the values appear in the Habitify app.

- [ ] **Step 5: Publish to GitHub**

```bash
git add README.md LICENSE wrangler.toml
git commit -m "Add readme, license, and deploy configuration"
gh repo create habitify-sync --public --source . --push
```

Before pushing, confirm no secrets are staged: `git grep -iE "(api[-_]?key|secret|token|cookie)" -- ':!*.md' ':!test/*'` should only hit variable names, never values, and `.dev.vars` must not be tracked (`git status --ignored` shows it ignored).

---

## Self-Review Notes

- Spec coverage: connector interface (T3), per-source behavior (T5–T7), orchestrator isolation + status (T8), HTTP API + OAuth bootstrap + cron (T9), config/secrets/README recipe + publish (T1, T10), idempotent upsert (T3), timezone handling (T2). Out-of-scope items (backfill, notifications) have no tasks, as intended.
- The Kindle endpoint/shape is capture-driven by design (spec defers it); the fixture test locks in whatever is captured. The two `CAPTURED:` markers are instructions to the implementer with an exact capture procedure, not open questions.
- Type names were cross-checked: `HabitValue`, `SourceContext`, `SourceStatus`, `StravaTokens`, `AmazonCookies`, `STATE_KEYS`, `STRAVA_TOKEN_URL` are consistent across tasks.
