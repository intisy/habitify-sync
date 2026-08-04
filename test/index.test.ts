import { createExecutionContext, createScheduledController, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker, { handleFetch } from "../src/index";
import { readJson, STATE_KEYS, writeJson, type SourceStatus, type StravaTokens } from "../src/state";
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

  it("rejects a query-string token on routes other than /strava/authorize", async () => {
    expect((await request("/status?token=secret-token")).status).toBe(401);
  });
});

describe("GET /status", () => {
  it("returns stored status for a source no longer in the registry", async () => {
    await writeJson(env.STATE, STATE_KEYS.sourceStatus("kindle"), { state: "ok" } satisfies SourceStatus);
    const response = await request("/status", { headers: bearer });
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, SourceStatus>;
    expect(body.kindle.state).toBe("ok");
  });

  it("includes a registered source that has never run as null", async () => {
    await env.STATE.delete(STATE_KEYS.sourceStatus("strava"));
    const response = await request("/status", { headers: bearer });
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, SourceStatus | null>;
    expect("strava" in body).toBe(true);
    expect(body.strava).toBeNull();
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

  it("exchanges the code for tokens and stores them in KV", async () => {
    await env.STATE.put(STATE_KEYS.stravaOauthState, "expected-state");
    const fakeFetch = (async () =>
      Response.json({ access_token: "access-1", refresh_token: "refresh-1", expires_at: 9999999999 })) as typeof fetch;

    const response = await handleFetch(
      new Request("https://worker.example/strava/callback?code=abc123&state=expected-state"),
      authedEnv,
      fakeFetch,
    );

    expect(response.status).toBe(200);
    const stored = await readJson<StravaTokens>(env.STATE, STATE_KEYS.stravaTokens);
    expect(stored).toEqual({ accessToken: "access-1", refreshToken: "refresh-1", expiresAt: 9999999999 });
  });
});

describe("scheduled", () => {
  it("runs the sync and writes source status to KV", async () => {
    await env.STATE.delete(STATE_KEYS.sourceStatus("strava"));
    await env.STATE.delete(STATE_KEYS.sourceStatus("wakatime"));

    const controller = createScheduledController();
    const context = createExecutionContext();
    await worker.scheduled(controller, authedEnv, context);
    await waitOnExecutionContext(context);

    const stravaStatus = await readJson<SourceStatus>(env.STATE, STATE_KEYS.sourceStatus("strava"));
    expect(stravaStatus).not.toBeNull();
  });
});
