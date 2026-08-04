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
    await env.STATE.delete(STATE_KEYS.sourceStatus("off"));
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
    const stored = await readJson<SourceStatus>(env.STATE, STATE_KEYS.sourceStatus("off"));
    expect(stored?.state).toBe("disabled");
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
