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
