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

  it("throws AuthNeededError when the token refresh is rejected", async () => {
    const expired: StravaTokens = { accessToken: "old-access", refreshToken: "revoked-refresh", expiresAt: 1000 };
    await writeJson(env.STATE, STATE_KEYS.stravaTokens, expired);
    const fetchFn = (async (input: RequestInfo | URL) => {
      expect(String(input)).toBe("https://www.strava.com/oauth/token");
      return new Response("bad request", { status: 400 });
    }) as typeof fetch;
    await expect(stravaSource.fetchToday(makeContext(stravaEnv(), fetchFn))).rejects.toThrow(AuthNeededError);
  });

  it("throws AuthNeededError when the activities call returns 401", async () => {
    const valid: StravaTokens = { accessToken: "access", refreshToken: "refresh", expiresAt: 9999999999 };
    await writeJson(env.STATE, STATE_KEYS.stravaTokens, valid);
    const fetchFn = (async () => new Response("unauthorized", { status: 401 })) as typeof fetch;
    await expect(stravaSource.fetchToday(makeContext(stravaEnv(), fetchFn))).rejects.toThrow(AuthNeededError);
  });
});
