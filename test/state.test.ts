import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { readJson, STATE_KEYS, writeJson } from "../src/state";

describe("state helpers", () => {
  it("round-trips JSON values through KV", async () => {
    await writeJson(env.STATE, "test:key", { accessToken: "a", refreshToken: "r", expiresAt: 1 });
    const tokens = await readJson<{ accessToken: string }>(env.STATE, "test:key");
    expect(tokens?.accessToken).toBe("a");
  });

  it("returns null for a missing key", async () => {
    expect(await readJson(env.STATE, "missing-key")).toBeNull();
  });

  it("builds per-source status keys", () => {
    expect(STATE_KEYS.sourceStatus("strava")).toBe("status:strava");
  });
});
