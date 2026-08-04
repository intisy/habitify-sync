import { createExecutionContext, createScheduledController, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker, { buildRouteTable, dispatch, handleFetch } from "../src/index";
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
    const response = await request("/sync?source=nonexistent", { method: "POST", headers: bearer });
    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain("nonexistent");
    expect(body.error).toContain("strava");
    expect(body.error).toContain("wakatime");
    expect(body.error).toContain("kindle");
  });
});

describe("GET /status", () => {
  it("returns stored status for a source no longer in the registry", async () => {
    await writeJson(env.STATE, STATE_KEYS.sourceStatus("retired-service"), { state: "ok" } satisfies SourceStatus);
    const response = await request("/status", { headers: bearer });
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, SourceStatus>;
    expect(body["retired-service"].state).toBe("ok");
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

describe("GET /habits", () => {
  it("rejects requests without the admin token", async () => {
    expect((await request("/habits")).status).toBe(401);
  });

  it("returns a trimmed habit list using the injected fetchFn", async () => {
    const fetchFn = (async () =>
      Response.json({
        data: [
          {
            id: "habit-1",
            name: "Read",
            goals: [{ id: "goal-1", createdAt: "2026-01-01T00:00:00Z", periodicity: "daily", value: 1, unit: "rep" }],
            secret_internal_field: "should not leak",
          },
          { id: "habit-2", name: "Run", goals: [{ unit: "min" }] },
        ],
      })) as typeof fetch;
    const response = await handleFetch(new Request("https://worker.example/habits", { headers: bearer }), authedEnv, fetchFn);
    expect(response.status).toBe(200);
    const body = (await response.json()) as unknown[];
    expect(body).toEqual([
      { id: "habit-1", name: "Read", unit: "rep" },
      { id: "habit-2", name: "Run", unit: "min" },
    ]);
    expect(JSON.stringify(body)).not.toContain("habitify-key");
  });

  it("returns 503 with a clear error when HABITIFY_API_KEY is unset", async () => {
    const envWithoutKey: Env = { ...authedEnv, HABITIFY_API_KEY: "" };
    const response = await handleFetch(
      new Request("https://worker.example/habits", { headers: bearer }),
      envWithoutKey,
      fetch,
    );
    expect(response.status).toBe(503);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain("HABITIFY_API_KEY is not configured");
    expect(JSON.stringify(body)).not.toContain("habitify-key");
  });

  it("returns 502 with the upstream status/message when the Habitify call fails", async () => {
    const fetchFn = (async () => new Response("nope", { status: 500 })) as typeof fetch;
    const response = await handleFetch(new Request("https://worker.example/habits", { headers: bearer }), authedEnv, fetchFn);
    expect(response.status).toBe(502);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain("500");
    expect(JSON.stringify(body)).not.toContain("habitify-key");
  });

  it("with ?raw=1, returns the untrimmed payload instead of the trimmed summaries", async () => {
    const rawBody = {
      data: [
        {
          id: "habit-1",
          name: "Read",
          goals: [{ id: "goal-1", createdAt: "2026-01-01T00:00:00Z", periodicity: "daily", value: 1, unit: "rep" }],
          area: "personal",
          timeOfDay: "anytime",
          archived: false,
          startDate: "2026-01-01T00:00:00Z",
        },
      ],
    };
    const fetchFn = (async () => Response.json(rawBody)) as typeof fetch;
    const response = await handleFetch(
      new Request("https://worker.example/habits?raw=1", { headers: bearer }),
      authedEnv,
      fetchFn,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as unknown;
    expect(body).toEqual(rawBody);
  });
});

describe("POST /habits", () => {
  function postHabits(body: unknown, fetchFn: typeof fetch, env: Env = authedEnv): Promise<Response> {
    return handleFetch(
      new Request("https://worker.example/habits", {
        method: "POST",
        headers: { ...bearer, "Content-Type": "application/json" },
        body: typeof body === "string" ? body : JSON.stringify(body),
      }),
      env,
      fetchFn,
    );
  }

  it("rejects requests without the admin token", async () => {
    const response = await request("/habits", { method: "POST", body: JSON.stringify({ name: "Read" }) });
    expect(response.status).toBe(401);
  });

  it("creates a habit and returns 201 with the created HabitSummary", async () => {
    const fetchFn = (async () =>
      Response.json(
        {
          id: "habit-new",
          name: "Read 10 pages",
          goals: [{ id: "goal-1", periodicity: "daily", value: 10, unit: "rep" }],
        },
        { status: 201 },
      )) as typeof fetch;
    const response = await postHabits(
      { name: "Read 10 pages", goal: { periodicity: "daily", value: 10, unit: "rep" } },
      fetchFn,
    );
    expect(response.status).toBe(201);
    const body = (await response.json()) as unknown;
    expect(body).toEqual({ id: "habit-new", name: "Read 10 pages", unit: "rep" });
  });

  it("passes only name/type/description/goal/occurrence through, dropping unexpected fields", async () => {
    let capturedBody: unknown;
    const fetchFn = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedBody = JSON.parse(String(init?.body));
      return Response.json({ id: "habit-new", name: "Read", goals: [] }, { status: 201 });
    }) as typeof fetch;
    await postHabits(
      { name: "Read", areaIds: ["area-1"], timeOfDayIds: ["tod-1"], extra: "nope" },
      fetchFn,
    );
    expect(capturedBody).toEqual({ name: "Read", type: "good", occurrence: { type: "daily" } });
  });

  it("returns 400 on malformed JSON", async () => {
    const response = await postHabits("{not json", fetch);
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBeTruthy();
  });

  it("returns 400 on a client-side validation error, without calling fetch", async () => {
    let called = false;
    const fetchFn = (async () => {
      called = true;
      return Response.json({}, { status: 201 });
    }) as typeof fetch;
    const response = await postHabits({ name: "" }, fetchFn);
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain("Habit name must be a non-empty string");
    expect(called).toBe(false);
  });

  it("returns 503 with a clear error when HABITIFY_API_KEY is unset", async () => {
    const envWithoutKey: Env = { ...authedEnv, HABITIFY_API_KEY: "" };
    const response = await postHabits({ name: "Read" }, fetch, envWithoutKey);
    expect(response.status).toBe(503);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain("HABITIFY_API_KEY is not configured");
    expect(JSON.stringify(body)).not.toContain("habitify-key");
  });

  it("returns 502 with the upstream status/message when the Habitify call fails", async () => {
    const fetchFn = (async () => new Response("nope", { status: 500 })) as typeof fetch;
    const response = await postHabits({ name: "Read" }, fetchFn);
    expect(response.status).toBe(502);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain("500");
    expect(JSON.stringify(body)).not.toContain("habitify-key");
  });

  it("returns 201 with the created HabitSummary when the 201 body is wrapped in { data: {...} }", async () => {
    const fetchFn = (async () =>
      Response.json({ data: { id: "habit-new", name: "Pages read", goals: [{ unit: "rep" }] } }, { status: 201 })) as typeof fetch;
    const response = await postHabits({ name: "Pages read" }, fetchFn);
    expect(response.status).toBe(201);
    const body = (await response.json()) as unknown;
    expect(body).toEqual({ id: "habit-new", name: "Pages read", unit: "rep" });
  });

  it("returns 201 with the habit found via the listHabits fallback when the 201 body can't be parsed", async () => {
    let callCount = 0;
    const fetchFn = (async () => {
      callCount++;
      if (callCount === 1) {
        return Response.json({ message: "Habit created successfully" }, { status: 201 });
      }
      return Response.json({ data: [{ id: "habit-new", name: "Pages read", goals: [{ unit: "rep" }] }] }, { status: 200 });
    }) as typeof fetch;
    const response = await postHabits({ name: "Pages read" }, fetchFn);
    expect(response.status).toBe(201);
    const body = (await response.json()) as unknown;
    expect(body).toEqual({ id: "habit-new", name: "Pages read", unit: "rep" });
    expect(callCount).toBe(2);
  });

  it("returns 502 mentioning the habit was probably created when the fallback lookup also finds nothing", async () => {
    let callCount = 0;
    const fetchFn = (async () => {
      callCount++;
      if (callCount === 1) {
        return Response.json({ message: "Habit created successfully" }, { status: 201 });
      }
      return Response.json({ data: [] }, { status: 200 });
    }) as typeof fetch;
    const response = await postHabits({ name: "Pages read" }, fetchFn);
    expect(response.status).toBe(502);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain("probably created");
    expect(callCount).toBe(2);
  });
});

describe("GET /journal", () => {
  it("rejects requests without the admin token", async () => {
    expect((await request("/journal")).status).toBe(401);
  });

  it("returns the journal payload using the injected fetchFn", async () => {
    const journalBody = {
      data: [{ id: "habit-1", name: "Read", status: "completed", progress: { current: 1, target: 1 } }],
    };
    const fetchFn = (async () => Response.json(journalBody)) as typeof fetch;
    const response = await handleFetch(new Request("https://worker.example/journal", { headers: bearer }), authedEnv, fetchFn);
    expect(response.status).toBe(200);
    const body = (await response.json()) as unknown;
    expect(body).toEqual(journalBody);
  });

  it("appends the date to the upstream request when ?date= is given", async () => {
    let requestedUrl = "";
    const fetchFn = (async (input: RequestInfo | URL) => {
      requestedUrl = String(input);
      return Response.json({ data: [] });
    }) as typeof fetch;
    const response = await handleFetch(
      new Request("https://worker.example/journal?date=2026-08-05", { headers: bearer }),
      authedEnv,
      fetchFn,
    );
    expect(response.status).toBe(200);
    expect(requestedUrl).toBe("https://api.habitify.me/v2/habits/journal?date=2026-08-05");
  });

  it("returns 400 when ?date= is malformed", async () => {
    const response = await handleFetch(
      new Request("https://worker.example/journal?date=nonsense", { headers: bearer }),
      authedEnv,
      fetch,
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain("YYYY-MM-DD");
  });

  it("returns 503 with a clear error when HABITIFY_API_KEY is unset", async () => {
    const envWithoutKey: Env = { ...authedEnv, HABITIFY_API_KEY: "" };
    const response = await handleFetch(
      new Request("https://worker.example/journal", { headers: bearer }),
      envWithoutKey,
      fetch,
    );
    expect(response.status).toBe(503);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain("HABITIFY_API_KEY is not configured");
    expect(JSON.stringify(body)).not.toContain("habitify-key");
  });

  it("returns 502 with the upstream status/message when the Habitify call fails", async () => {
    const fetchFn = (async () => new Response("nope", { status: 500 })) as typeof fetch;
    const response = await handleFetch(new Request("https://worker.example/journal", { headers: bearer }), authedEnv, fetchFn);
    expect(response.status).toBe(502);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain("500");
    expect(JSON.stringify(body)).not.toContain("habitify-key");
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
