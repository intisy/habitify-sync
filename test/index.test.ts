import { createExecutionContext, createScheduledController, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker, { buildRouteTable, dispatch } from "../src/index";
import { readJson, STATE_KEYS, writeJson, type SourceStatus } from "../src/state";
import type { Env, IntegrationRoute } from "../src/integrations/types";

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

describe("POST /sync", () => {
  it("returns 404 naming the valid sources when ?source= matches none registered", async () => {
    const response = await request("/sync?source=kindle", { method: "POST", headers: bearer });
    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain("kindle");
    expect(body.error).toContain("strava");
    expect(body.error).toContain("wakatime");
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

describe("dispatch (generic route table)", () => {
  it("throws naming the conflicting route when two routes register the same method and path", () => {
    const routeA: IntegrationRoute = { method: "GET", path: "/dup", auth: "admin", handler: async () => new Response("a") };
    const routeB: IntegrationRoute = { method: "GET", path: "/dup", auth: "public", handler: async () => new Response("b") };
    expect(() => buildRouteTable([routeA, routeB])).toThrow("GET /dup");
  });

  it("routes an integration-contributed path and honors its declared auth mode", async () => {
    const publicRoute: IntegrationRoute = {
      method: "GET",
      path: "/fake/public",
      auth: "public",
      handler: async () => new Response("public ok"),
    };
    const queryRoute: IntegrationRoute = {
      method: "GET",
      path: "/fake/query",
      auth: "admin-or-query-token",
      handler: async () => new Response("query ok"),
    };
    const adminRoute: IntegrationRoute = {
      method: "GET",
      path: "/fake/admin",
      auth: "admin",
      handler: async () => new Response("admin ok"),
    };
    const table = buildRouteTable([publicRoute, queryRoute, adminRoute]);
    const testEnv: Env = { ...env, ADMIN_TOKEN: "secret-token" };

    // public: reachable with no auth at all
    const publicResponse = await dispatch(table, new Request("https://worker.example/fake/public"), testEnv, fetch);
    expect(await publicResponse.text()).toBe("public ok");

    // admin-or-query-token: the ?token= fallback works
    const queryResponse = await dispatch(
      table,
      new Request("https://worker.example/fake/query?token=secret-token"),
      testEnv,
      fetch,
    );
    expect(await queryResponse.text()).toBe("query ok");

    // admin: the ?token= fallback does NOT work — only the Authorization header does
    const adminQueryResponse = await dispatch(
      table,
      new Request("https://worker.example/fake/admin?token=secret-token"),
      testEnv,
      fetch,
    );
    expect(adminQueryResponse.status).toBe(401);

    const adminHeaderResponse = await dispatch(
      table,
      new Request("https://worker.example/fake/admin", { headers: bearer }),
      testEnv,
      fetch,
    );
    expect(await adminHeaderResponse.text()).toBe("admin ok");
  });
});
