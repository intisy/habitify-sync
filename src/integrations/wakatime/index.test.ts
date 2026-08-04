import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { wakatimeIntegration } from "./index";
import type { Env, SourceContext } from "../types";

function makeContext(testEnv: Env, fetchFn: typeof fetch): SourceContext {
  return { env: testEnv, timeZone: "Europe/Berlin", today: "2026-08-04", now: new Date("2026-08-04T10:00:00Z"), fetchFn };
}

describe("wakatimeIntegration", () => {
  it("is disabled without an API key and habit id", () => {
    expect(wakatimeIntegration.enabled({ ...env, WAKATIME_API_KEY: undefined })).toBe(false);
    expect(wakatimeIntegration.enabled({ ...env, WAKATIME_API_KEY: "key", HABIT_ID_WAKATIME: "" })).toBe(false);
    expect(wakatimeIntegration.enabled({ ...env, WAKATIME_API_KEY: "key", HABIT_ID_WAKATIME: "habit-w" })).toBe(true);
  });

  it("sums today's grand total into minutes", async () => {
    const requested: string[] = [];
    const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requested.push(String(input));
      expect(new Headers(init?.headers).get("Authorization")).toBe(`Basic ${btoa("waka-key")}`);
      return Response.json({ data: [{ grand_total: { total_seconds: 5430 } }] });
    }) as typeof fetch;

    const testEnv: Env = { ...env, WAKATIME_API_KEY: "waka-key", HABIT_ID_WAKATIME: "habit-w" };
    const values = await wakatimeIntegration.fetchToday(makeContext(testEnv, fetchFn));

    expect(requested[0]).toBe("https://wakatime.com/api/v1/users/current/summaries?start=2026-08-04&end=2026-08-04");
    expect(values).toEqual([{ habitId: "habit-w", value: 91, unit: "min" }]);
  });

  it("throws on a non-ok response", async () => {
    const fetchFn = (async () => new Response("nope", { status: 500 })) as typeof fetch;
    const testEnv: Env = { ...env, WAKATIME_API_KEY: "waka-key", HABIT_ID_WAKATIME: "habit-w" };
    await expect(wakatimeIntegration.fetchToday(makeContext(testEnv, fetchFn))).rejects.toThrow("WakaTime");
  });

  it("throws a clear error when the payload shape is unexpected", async () => {
    // e.g. WakaTime's 202 "still computing" response, which still passes response.ok
    const fetchFn = (async () => Response.json({ data: "not-an-array" })) as typeof fetch;
    const testEnv: Env = { ...env, WAKATIME_API_KEY: "waka-key", HABIT_ID_WAKATIME: "habit-w" };
    await expect(wakatimeIntegration.fetchToday(makeContext(testEnv, fetchFn))).rejects.toThrow(
      "WakaTime returned an unexpected payload shape",
    );
  });
});
