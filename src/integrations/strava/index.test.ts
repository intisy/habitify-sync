import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import worker, { handleFetch } from "../../index";
import { readJson, writeJson } from "../../state";
import { SettingsResolver } from "../../settings";
import { AuthNeededError, type Env, type SourceContext } from "../types";
import { STRAVA_STATE_KEYS, stravaIntegration, type StravaTokens } from "./index";

const now = new Date("2026-08-04T10:00:00Z");
const berlinMidnightEpoch = Date.parse("2026-08-03T22:00:00Z") / 1000;

function makeContext(testEnv: Env, fetchFn: typeof fetch): SourceContext {
  const settings = new SettingsResolver(testEnv, testEnv.STATE, "strava", stravaIntegration.settings);
  return { env: testEnv, timeZone: "Europe/Berlin", today: "2026-08-04", now, fetchFn, settings };
}

function stravaEnv(): Env {
  return { ...env, STRAVA_CLIENT_ID: "client-id", STRAVA_CLIENT_SECRET: "client-secret", HABIT_ID_STRAVA: "habit-s" };
}

describe("stravaIntegration.fetchToday", () => {
  beforeEach(async () => {
    await env.STATE.delete(STRAVA_STATE_KEYS.tokens);
  });

  it("is disabled without client credentials and habit id", async () => {
    const missingClientId: Env = { ...stravaEnv(), STRAVA_CLIENT_ID: undefined };
    expect(await new SettingsResolver(missingClientId, missingClientId.STATE, "strava", stravaIntegration.settings).isEnabled()).toBe(
      false,
    );
    const complete = stravaEnv();
    expect(await new SettingsResolver(complete, complete.STATE, "strava", stravaIntegration.settings).isEnabled()).toBe(true);
  });

  it("throws AuthNeededError when no tokens are stored", async () => {
    const fetchFn = (async () => new Response("{}")) as typeof fetch;
    await expect(stravaIntegration.fetchToday(makeContext(stravaEnv(), fetchFn))).rejects.toThrow(AuthNeededError);
  });

  it("refreshes an expired token, persists the rotated refresh token, and sums today's moving time", async () => {
    const expired: StravaTokens = { accessToken: "old-access", refreshToken: "old-refresh", expiresAt: 1000 };
    await writeJson(env.STATE, STRAVA_STATE_KEYS.tokens, expired);

    const requests: { url: string; body?: string }[] = [];
    const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, body: init?.body === undefined ? undefined : String(init.body) });
      if (url === "https://www.strava.com/api/v3/oauth/token") {
        return Response.json({ access_token: "new-access", refresh_token: "new-refresh", expires_at: 9999999999 });
      }
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer new-access");
      return Response.json([{ moving_time: 1800 }, { moving_time: 900 }]);
    }) as typeof fetch;

    const values = await stravaIntegration.fetchToday(makeContext(stravaEnv(), fetchFn));

    const refreshParams = new URLSearchParams(requests[0].body!);
    expect(refreshParams.get("grant_type")).toBe("refresh_token");
    expect(refreshParams.get("refresh_token")).toBe("old-refresh");
    expect(refreshParams.get("client_id")).toBe("client-id");
    expect(refreshParams.get("client_secret")).toBe("client-secret");
    expect(requests[1].url).toBe(
      `https://www.strava.com/api/v3/athlete/activities?after=${berlinMidnightEpoch}&per_page=100`,
    );
    expect(values).toEqual([{ habitId: "habit-s", value: 45, unit: "min" }]);

    const stored = await readJson<StravaTokens>(env.STATE, STRAVA_STATE_KEYS.tokens);
    expect(stored?.refreshToken).toBe("new-refresh");
  });

  it("throws AuthNeededError when the token refresh is rejected", async () => {
    const expired: StravaTokens = { accessToken: "old-access", refreshToken: "revoked-refresh", expiresAt: 1000 };
    await writeJson(env.STATE, STRAVA_STATE_KEYS.tokens, expired);
    const fetchFn = (async (input: RequestInfo | URL) => {
      expect(String(input)).toBe("https://www.strava.com/api/v3/oauth/token");
      return new Response("bad request", { status: 400 });
    }) as typeof fetch;
    await expect(stravaIntegration.fetchToday(makeContext(stravaEnv(), fetchFn))).rejects.toThrow(AuthNeededError);
  });

  it("throws AuthNeededError when the activities call returns 401", async () => {
    const valid: StravaTokens = { accessToken: "access", refreshToken: "refresh", expiresAt: 9999999999 };
    await writeJson(env.STATE, STRAVA_STATE_KEYS.tokens, valid);
    const fetchFn = (async () => new Response("unauthorized", { status: 401 })) as typeof fetch;
    await expect(stravaIntegration.fetchToday(makeContext(stravaEnv(), fetchFn))).rejects.toThrow(AuthNeededError);
  });

  it("throws a clear error when the activities payload shape is unexpected", async () => {
    const valid: StravaTokens = { accessToken: "access", refreshToken: "refresh", expiresAt: 9999999999 };
    await writeJson(env.STATE, STRAVA_STATE_KEYS.tokens, valid);
    const fetchFn = (async () => Response.json({ not: "an array" })) as typeof fetch;
    await expect(stravaIntegration.fetchToday(makeContext(stravaEnv(), fetchFn))).rejects.toThrow(
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

describe("GET /strava/authorize", () => {
  it("redirects to Strava consent with a stored state parameter", async () => {
    const stravaEnvValue: Env = { ...authedEnv, STRAVA_CLIENT_ID: "client-id", STRAVA_CLIENT_SECRET: "client-secret" };
    const context = createExecutionContext();
    const response = await worker.fetch(
      new Request("https://worker.example/strava/authorize?token=secret-token"),
      stravaEnvValue,
      context,
    );
    await waitOnExecutionContext(context);

    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("Location")!);
    expect(location.origin).toBe("https://www.strava.com");
    expect(location.searchParams.get("client_id")).toBe("client-id");
    expect(location.searchParams.get("redirect_uri")).toBe("https://worker.example/strava/callback");
    const state = location.searchParams.get("state")!;
    expect(await env.STATE.get(STRAVA_STATE_KEYS.oauthState)).toBe(state);
  });
});

describe("GET /strava/callback", () => {
  it("rejects a mismatched state parameter", async () => {
    await env.STATE.put(STRAVA_STATE_KEYS.oauthState, "expected-state");
    const response = await request("/strava/callback?code=abc&state=wrong-state");
    expect(response.status).toBe(403);
  });

  it("exchanges the code for tokens and stores them in KV", async () => {
    await env.STATE.put(STRAVA_STATE_KEYS.oauthState, "expected-state");
    const fakeFetch = (async () =>
      Response.json({ access_token: "access-1", refresh_token: "refresh-1", expires_at: 9999999999 })) as typeof fetch;

    const response = await handleFetch(
      new Request("https://worker.example/strava/callback?code=abc123&state=expected-state"),
      stravaEnv(),
      fakeFetch,
    );

    expect(response.status).toBe(200);
    const stored = await readJson<StravaTokens>(env.STATE, STRAVA_STATE_KEYS.tokens);
    expect(stored).toEqual({ accessToken: "access-1", refreshToken: "refresh-1", expiresAt: 9999999999 });
  });
});
