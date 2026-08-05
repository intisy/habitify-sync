import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { runSync } from "../src/sync";
import { readJson, STATE_KEYS, writeJson, type SourceStatus } from "../src/state";
import { AuthNeededError, type Env, type Integration } from "../src/integrations/types";

const now = new Date("2026-08-04T10:00:00Z");
// HABIT_ID_GOOD/HABIT_ID_BROKEN are set so the fake "good"/"broken" sources below (which declare
// no settings of their own) resolve enabled via the implicit habitId requirement — see
// makeSource. HABIT_ID_OFF is deliberately left unset so a fake "off" source stays disabled
// without needing its own explicit enabled() override (there is no such thing anymore).
const testEnv: Env = { ...env, HABITIFY_API_KEY: "habitify-key", HABIT_ID_GOOD: "habit-good", HABIT_ID_BROKEN: "habit-broken" };

interface RecordedRequest {
  method: string;
  url: string;
  body: string | undefined;
}

// Routes a fake Habitify v2 API: GET /habits returns `habitsResponse` (default: no habits, so
// every value falls back to its integration's own declared unit); GET /habits/journal returns
// `journalResponse` (default: no habits, so every value's current is treated as 0 and its full
// target gets posted); every POST under /habits/* (undo and log-create) succeeds with 200. Every
// request is recorded for assertions.
function fakeHabitify(
  recorded: RecordedRequest[],
  habitsResponse: unknown = { data: [] },
  journalResponse: unknown = { data: [] },
): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    recorded.push({ method: init?.method ?? "GET", url, body: init?.body === undefined ? undefined : String(init.body) });
    if (url.includes("/habits/journal") && (init?.method ?? "GET") === "GET") {
      return new Response(JSON.stringify(journalResponse), { status: 200 });
    }
    if (url.endsWith("/habits") && (init?.method ?? "GET") === "GET") {
      return new Response(JSON.stringify(habitsResponse), { status: 200 });
    }
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
}

function makeSource(name: string, behavior: () => Promise<{ habitId: string; value: number; unit: string }[]>): Integration {
  return { name, settings: [], fetchToday: behavior };
}

describe("runSync", () => {
  beforeEach(async () => {
    await env.STATE.delete(STATE_KEYS.sourceStatus("good"));
    await env.STATE.delete(STATE_KEYS.sourceStatus("broken"));
    await env.STATE.delete(STATE_KEYS.sourceStatus("off"));
  });

  it("pushes values to Habitify as the difference from today's journal, and records ok status", async () => {
    const recorded: RecordedRequest[] = [];
    const good = makeSource("good", async () => [{ habitId: "habit-1", value: 10, unit: "min" }]);

    const results = await runSync(testEnv, [good], now, fakeHabitify(recorded));

    expect(results[0].status.state).toBe("ok");
    expect(recorded.some((request) => request.url.endsWith("/habits/habit-1/logs"))).toBe(true);
    // The journal reports no habits, so current is treated as 0 and the full target is posted —
    // and, critically, undo is never called: convergence-by-difference doesn't need it.
    expect(recorded.some((request) => request.url.endsWith("/habits/habit-1/logs/undo"))).toBe(false);
    const stored = await readJson<SourceStatus>(env.STATE, STATE_KEYS.sourceStatus("good"));
    expect(stored?.state).toBe("ok");
    expect(stored?.values).toEqual([{ habitId: "habit-1", value: 10, unit: "min" }]);
    expect(stored?.convergence).toEqual([
      { habitId: "habit-1", target: 10, current: 0, difference: 10, usedUndoFallback: false },
    ]);
  });

  it("fetches the journal once per run, not once per habit", async () => {
    const recorded: RecordedRequest[] = [];
    const good = makeSource("good", async () => [
      { habitId: "habit-1", value: 10, unit: "min" },
      { habitId: "habit-2", value: 20, unit: "min" },
    ]);

    await runSync(testEnv, [good], now, fakeHabitify(recorded));

    const journalRequests = recorded.filter((request) => request.url.includes("/habits/journal"));
    expect(journalRequests).toHaveLength(1);
  });

  it("isolates a throwing source and still runs the others", async () => {
    const recorded: RecordedRequest[] = [];
    const broken = makeSource("broken", async () => {
      throw new Error("service exploded");
    });
    const good = makeSource("good", async () => [{ habitId: "habit-1", value: 5, unit: "min" }]);

    const results = await runSync(testEnv, [broken, good], now, fakeHabitify(recorded));

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

    const results = await runSync(testEnv, [broken], now, fakeHabitify([]));

    expect(results[0].status.state).toBe("auth_needed");
    expect(results[0].status.lastError).toBe("cookies expired");
    expect(results[0].status.lastSuccessAt).toBe("2026-08-03T10:00:00.000Z");
  });

  it("reports disabled sources without calling them, preserving the previous lastSuccessAt", async () => {
    await writeJson(env.STATE, STATE_KEYS.sourceStatus("off"), {
      state: "ok",
      lastSuccessAt: "2026-08-03T10:00:00.000Z",
    } satisfies SourceStatus);
    const disabled: Integration = {
      name: "off",
      // No HABIT_ID_OFF is set on testEnv, so the implicit habitId requirement is what keeps this
      // source disabled — there is no explicit enabled() to override anymore.
      settings: [],
      fetchToday: async () => {
        throw new Error("must not be called");
      },
    };
    const results = await runSync(testEnv, [disabled], now, fakeHabitify([]));
    expect(results[0].status.state).toBe("disabled");
    expect(results[0].status.lastSuccessAt).toBe("2026-08-03T10:00:00.000Z");
    const stored = await readJson<SourceStatus>(env.STATE, STATE_KEYS.sourceStatus("off"));
    expect(stored?.state).toBe("disabled");
    expect(stored?.lastSuccessAt).toBe("2026-08-03T10:00:00.000Z");
  });

  it("filters to a single source when onlySource is given", async () => {
    const first = makeSource("good", async () => [{ habitId: "habit-1", value: 1, unit: "min" }]);
    const second = makeSource("broken", async () => {
      throw new Error("should be skipped");
    });
    const results = await runSync(testEnv, [first, second], now, fakeHabitify([]), "good");
    expect(results).toHaveLength(1);
    expect(results[0].source).toBe("good");
  });

  it("reports every source as error when HABITIFY_API_KEY is missing, without calling them", async () => {
    await writeJson(env.STATE, STATE_KEYS.sourceStatus("good"), {
      state: "ok",
      lastSuccessAt: "2026-08-03T10:00:00.000Z",
    } satisfies SourceStatus);
    const source = makeSource("good", async () => {
      throw new Error("must not be called");
    });
    const noKeyEnv: Env = { ...testEnv, HABITIFY_API_KEY: "" };

    const results = await runSync(noKeyEnv, [source], now, fakeHabitify([]));

    expect(results[0].status.state).toBe("error");
    expect(results[0].status.lastError).toBe("HABITIFY_API_KEY is not configured");
    expect(results[0].status.lastSuccessAt).toBe("2026-08-03T10:00:00.000Z");
    const stored = await readJson<SourceStatus>(env.STATE, STATE_KEYS.sourceStatus("good"));
    expect(stored?.state).toBe("error");
  });
});

describe("runSync - Habitify unit resolution", () => {
  beforeEach(async () => {
    await env.STATE.delete(STATE_KEYS.sourceStatus("good"));
    await env.STATE.delete(STATE_KEYS.sourceStatus("kindle-like"));
  });

  it("prefers the habit's own configured unit over the integration's declared unit", async () => {
    const recorded: RecordedRequest[] = [];
    const source = makeSource("good", async () => [{ habitId: "habit-1", value: 10, unit: "min" }]);
    const habitsResponse = { data: [{ id: "habit-1", goals: [{ unit: "hr" }] }] };

    await runSync(testEnv, [source], now, fakeHabitify(recorded, habitsResponse));

    const logRequest = recorded.find((request) => request.url.endsWith("/habits/habit-1/logs"));
    expect(JSON.parse(logRequest!.body!).unitSymbol).toBe("hr");
    const stored = await readJson<SourceStatus>(env.STATE, STATE_KEYS.sourceStatus("good"));
    expect(stored?.unitFallbacks ?? []).toEqual([]);
  });

  it("falls back to the integration's declared unit when the habit has no configured unit, and records it", async () => {
    const recorded: RecordedRequest[] = [];
    const source = makeSource("good", async () => [{ habitId: "habit-1", value: 10, unit: "min" }]);
    const habitsResponse = { data: [{ id: "habit-1", goals: [] }] };

    await runSync(testEnv, [source], now, fakeHabitify(recorded, habitsResponse));

    const logRequest = recorded.find((request) => request.url.endsWith("/habits/habit-1/logs"));
    expect(JSON.parse(logRequest!.body!).unitSymbol).toBe("min");
    const stored = await readJson<SourceStatus>(env.STATE, STATE_KEYS.sourceStatus("good"));
    expect(stored?.unitFallbacks?.length).toBeGreaterThan(0);
  });

  // This is the Kindle path: the integration's declared unit ("pages") is not a valid Habitify
  // unit symbol at all, so when the habit also has no configured unit, "rep" (the generic count
  // unit) is what actually gets sent.
  it("falls back to \"rep\" when neither the habit's unit nor the integration's unit is valid", async () => {
    const recorded: RecordedRequest[] = [];
    const source = makeSource("kindle-like", async () => [{ habitId: "habit-2", value: 40, unit: "pages" }]);
    const habitsResponse = { data: [{ id: "habit-2", goals: [] }] };
    // "kindle-like" isn't in the shared testEnv above (unlike "good"/"broken"), so it needs its
    // own habitId var to resolve enabled.
    const kindleLikeEnv: Env = { ...testEnv, "HABIT_ID_KINDLE-LIKE": "habit-2" };

    await runSync(kindleLikeEnv, [source], now, fakeHabitify(recorded, habitsResponse));

    const logRequest = recorded.find((request) => request.url.endsWith("/habits/habit-2/logs"));
    expect(JSON.parse(logRequest!.body!).unitSymbol).toBe("rep");
    const stored = await readJson<SourceStatus>(env.STATE, STATE_KEYS.sourceStatus("kindle-like"));
    expect(stored?.unitFallbacks?.length).toBeGreaterThan(0);
    expect(stored?.unitFallbacks?.[0]).toMatch(/rep/);
  });

  it("degrades to per-value units without failing the sync when listHabits itself fails", async () => {
    const recorded: RecordedRequest[] = [];
    const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      recorded.push({ method: init?.method ?? "GET", url, body: init?.body === undefined ? undefined : String(init.body) });
      if (url.endsWith("/habits") && (init?.method ?? "GET") === "GET") {
        return new Response("server error", { status: 500 });
      }
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    const source = makeSource("good", async () => [{ habitId: "habit-1", value: 10, unit: "min" }]);

    const results = await runSync(testEnv, [source], now, fetchFn);

    expect(results[0].status.state).toBe("ok");
    const logRequest = recorded.find((request) => request.url.endsWith("/habits/habit-1/logs"));
    expect(JSON.parse(logRequest!.body!).unitSymbol).toBe("min");
    const stored = await readJson<SourceStatus>(env.STATE, STATE_KEYS.sourceStatus("good"));
    expect(stored?.unitFallbacks?.length).toBeGreaterThan(0);
  });
});

describe("runSync - convergence by difference", () => {
  beforeEach(async () => {
    await env.STATE.delete(STATE_KEYS.sourceStatus("good"));
  });

  it("posts the negative difference when the journal reports a current value above target (the live inflation fix)", async () => {
    const recorded: RecordedRequest[] = [];
    // Mirrors the live Pages-read case: the habit already holds 104, the source's true daily
    // value is 8.
    const source = makeSource("good", async () => [{ habitId: "habit-1", value: 8, unit: "rep" }]);
    const journalResponse = { data: [{ id: "habit-1", progress: { current: 104, target: 8 } }] };

    await runSync(testEnv, [source], now, fakeHabitify(recorded, undefined, journalResponse));

    const logRequests = recorded.filter((request) => request.url.endsWith("/habits/habit-1/logs"));
    expect(logRequests).toHaveLength(1);
    expect(JSON.parse(logRequests[0].body!)).toEqual({ unitSymbol: "rep", value: -96, targetDate: "2026-08-04" });
    expect(recorded.some((request) => request.url.endsWith("/habits/habit-1/logs/undo"))).toBe(false);
    const stored = await readJson<SourceStatus>(env.STATE, STATE_KEYS.sourceStatus("good"));
    expect(stored?.convergence).toEqual([
      { habitId: "habit-1", target: 8, current: 104, difference: -96, usedUndoFallback: false },
    ]);
  });

  it("makes no POST at all when the journal already reports the target value", async () => {
    const recorded: RecordedRequest[] = [];
    const source = makeSource("good", async () => [{ habitId: "habit-1", value: 10, unit: "min" }]);
    const journalResponse = { data: [{ id: "habit-1", progress: { current: 10, target: 10 } }] };

    await runSync(testEnv, [source], now, fakeHabitify(recorded, undefined, journalResponse));

    expect(recorded.some((request) => request.url.endsWith("/habits/habit-1/logs"))).toBe(false);
    expect(recorded.some((request) => request.url.endsWith("/habits/habit-1/logs/undo"))).toBe(false);
    const stored = await readJson<SourceStatus>(env.STATE, STATE_KEYS.sourceStatus("good"));
    expect(stored?.convergence).toEqual([
      { habitId: "habit-1", target: 10, current: 10, difference: 0, usedUndoFallback: false },
    ]);
  });

  it("treats a habit absent from the journal as current 0, posting the full target", async () => {
    const recorded: RecordedRequest[] = [];
    const source = makeSource("good", async () => [{ habitId: "habit-1", value: 15, unit: "min" }]);
    // The journal has entries, just none for habit-1.
    const journalResponse = { data: [{ id: "some-other-habit", progress: { current: 99, target: 99 } }] };

    await runSync(testEnv, [source], now, fakeHabitify(recorded, undefined, journalResponse));

    const logRequest = recorded.find((request) => request.url.endsWith("/habits/habit-1/logs"));
    expect(JSON.parse(logRequest!.body!).value).toBe(15);
    const stored = await readJson<SourceStatus>(env.STATE, STATE_KEYS.sourceStatus("good"));
    expect(stored?.convergence?.[0]).toEqual({
      habitId: "habit-1",
      target: 15,
      current: 0,
      difference: 15,
      usedUndoFallback: false,
    });
  });

  it("falls back to undo-then-post-total when Habitify rejects the negative post, and records it in status", async () => {
    const recorded: RecordedRequest[] = [];
    let logPostCount = 0;
    const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      recorded.push({ method, url, body: init?.body === undefined ? undefined : String(init.body) });
      if (url.includes("/habits/journal") && method === "GET") {
        return new Response(JSON.stringify({ data: [{ id: "habit-1", progress: { current: 104 } }] }), { status: 200 });
      }
      if (url.endsWith("/habits") && method === "GET") {
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      }
      if (url.endsWith("/habits/habit-1/logs") && method === "POST") {
        logPostCount++;
        // 1st POST /logs is the negative difference, rejected. 2nd (after undo) is the full total.
        return new Response(logPostCount === 1 ? "rejected" : "{}", { status: logPostCount === 1 ? 422 : 200 });
      }
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    const source = makeSource("good", async () => [{ habitId: "habit-1", value: 8, unit: "rep" }]);

    const results = await runSync(testEnv, [source], now, fetchFn);

    expect(results[0].status.state).toBe("ok");
    expect(recorded.some((request) => request.url.endsWith("/habits/habit-1/logs/undo"))).toBe(true);
    const stored = await readJson<SourceStatus>(env.STATE, STATE_KEYS.sourceStatus("good"));
    expect(stored?.convergence).toEqual([
      { habitId: "habit-1", target: 8, current: 104, difference: -96, usedUndoFallback: true },
    ]);
  });

  it("writes nothing and records an error when the journal read fails, and does NOT post a total", async () => {
    const recorded: RecordedRequest[] = [];
    const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      recorded.push({ method, url, body: init?.body === undefined ? undefined : String(init.body) });
      if (url.includes("/habits/journal") && method === "GET") {
        return new Response("server error", { status: 500 });
      }
      if (url.endsWith("/habits") && method === "GET") {
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    const source = makeSource("good", async () => [{ habitId: "habit-1", value: 8, unit: "rep" }]);

    const results = await runSync(testEnv, [source], now, fetchFn);

    expect(results[0].status.state).toBe("error");
    expect(results[0].status.lastError).toMatch(/journal/i);
    expect(recorded.some((request) => request.url.endsWith("/habits/habit-1/logs"))).toBe(false);
    expect(recorded.some((request) => request.url.endsWith("/habits/habit-1/logs/undo"))).toBe(false);
    const stored = await readJson<SourceStatus>(env.STATE, STATE_KEYS.sourceStatus("good"));
    expect(stored?.state).toBe("error");
    expect(stored?.convergence).toBeUndefined();
  });

  it("preserves lastSuccessAt when a failed journal read blocks a run", async () => {
    await writeJson(env.STATE, STATE_KEYS.sourceStatus("good"), {
      state: "ok",
      lastSuccessAt: "2026-08-03T10:00:00.000Z",
    } satisfies SourceStatus);
    const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url.includes("/habits/journal") && method === "GET") {
        return new Response("server error", { status: 500 });
      }
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    }) as typeof fetch;
    const source = makeSource("good", async () => [{ habitId: "habit-1", value: 8, unit: "rep" }]);

    const results = await runSync(testEnv, [source], now, fetchFn);

    expect(results[0].status.lastSuccessAt).toBe("2026-08-03T10:00:00.000Z");
  });
});
