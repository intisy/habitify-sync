import { createExecutionContext, createScheduledController, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
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

describe("GET /config", () => {
  it("rejects requests without the admin token", async () => {
    expect((await request("/config")).status).toBe(401);
  });

  it("lists every registered integration, redacting secrets to a configured boolean", async () => {
    // A real, distinctive secret value, set here specifically so the assertion below actually
    // proves redaction — asserting a string's absence means nothing if that string was never
    // configured in the first place.
    const DISTINCTIVE_SECRET = "distinctive-strava-client-secret-do-not-leak";
    const envWithSecret: Env = { ...authedEnv, STRAVA_CLIENT_ID: "client-id", STRAVA_CLIENT_SECRET: DISTINCTIVE_SECRET };
    const response = await handleFetch(new Request("https://worker.example/config", { headers: bearer }), envWithSecret);
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, { key: string; value?: string; configured?: boolean }[]>;
    expect(Object.keys(body).sort()).toEqual(["keybr", "kindle", "strava", "wakatime"]);

    const stravaClientId = body.strava.find((setting) => setting.key === "clientId")!;
    expect(stravaClientId).not.toHaveProperty("value");
    expect(typeof stravaClientId.configured).toBe("boolean");
    const stravaClientSecret = body.strava.find((setting) => setting.key === "clientSecret")!;
    expect(stravaClientSecret).not.toHaveProperty("value");
    expect(stravaClientSecret.configured).toBe(true);
    expect(JSON.stringify(body)).not.toContain(DISTINCTIVE_SECRET);

    const keybrPublicId = body.keybr.find((setting) => setting.key === "publicId")!;
    expect(keybrPublicId).not.toHaveProperty("configured");
    expect(typeof keybrPublicId.value).toBe("string");
  });
});

describe("GET /config/<integration>", () => {
  it("rejects requests without the admin token", async () => {
    expect((await request("/config/keybr")).status).toBe(401);
  });

  it("returns 404 for an integration not in the registry", async () => {
    expect((await request("/config/nonexistent", { headers: bearer })).status).toBe(404);
  });

  it("returns one integration's settings, habitId included", async () => {
    const response = await request("/config/keybr", { headers: bearer });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { integration: string; settings: { key: string }[] };
    expect(body.integration).toBe("keybr");
    expect(body.settings.map((setting) => setting.key).sort()).toEqual(["habitId", "publicId"]);
  });
});

describe("PUT /config/<integration>", () => {
  afterEach(async () => {
    await env.STATE.delete("config:keybr");
    await env.STATE.delete("config:kindle");
  });

  it("rejects requests without the admin token", async () => {
    const response = await request("/config/keybr", { method: "PUT", body: JSON.stringify({ publicId: "x" }) });
    expect(response.status).toBe(401);
  });

  it("merges a valid override into KV and echoes it back", async () => {
    const response = await request("/config/keybr", {
      method: "PUT",
      headers: { ...bearer, "Content-Type": "application/json" },
      body: JSON.stringify({ publicId: "overridden-id" }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { overrides: Record<string, string> };
    expect(body.overrides.publicId).toBe("overridden-id");

    const getResponse = await request("/config/keybr", { headers: bearer });
    const settings = (await getResponse.json()) as { settings: { key: string; value?: string; source: string }[] };
    const publicId = settings.settings.find((setting) => setting.key === "publicId")!;
    expect(publicId).toMatchObject({ value: "overridden-id", source: "kv" });
  });

  it("rejects an unknown setting key, naming what is allowed", async () => {
    const response = await request("/config/keybr", {
      method: "PUT",
      headers: { ...bearer, "Content-Type": "application/json" },
      body: JSON.stringify({ notARealSetting: "x" }),
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain("notARealSetting");
    expect(body.error).toContain("publicId");
    expect(body.error).toContain("habitId");
  });

  it("rejects a secret key, naming how to configure it instead", async () => {
    const response = await request("/config/strava", {
      method: "PUT",
      headers: { ...bearer, "Content-Type": "application/json" },
      body: JSON.stringify({ clientId: "should-not-be-settable" }),
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain("secret");
    expect(body.error).toContain("STRAVA_CLIENT_ID");
    const stored = await env.STATE.get("config:strava");
    expect(stored).toBeNull();
  });

  it("rejects a non-numeric value for a number-typed setting", async () => {
    const response = await request("/config/kindle", {
      method: "PUT",
      headers: { ...bearer, "Content-Type": "application/json" },
      body: JSON.stringify({ wordsPerPage: "not-a-number" }),
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain("wordsPerPage");
    expect(body.error).toContain("number");
  });

  it("rejects unparseable JSON for a json-typed setting", async () => {
    const response = await request("/config/kindle", {
      method: "PUT",
      headers: { ...bearer, "Content-Type": "application/json" },
      body: JSON.stringify({ pageCounts: "not json" }),
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain("pageCounts");
    expect(body.error).toContain("JSON");
  });

  it("rejects a malformed request body", async () => {
    const response = await request("/config/keybr", {
      method: "PUT",
      headers: { ...bearer, "Content-Type": "application/json" },
      body: "not json",
    });
    expect(response.status).toBe(400);
  });
});

describe("DELETE /config/<integration>", () => {
  afterEach(async () => {
    await env.STATE.delete("config:keybr");
  });

  it("rejects requests without the admin token", async () => {
    expect((await request("/config/keybr", { method: "DELETE" })).status).toBe(401);
  });

  it("clears a single override with ?key=, leaving the rest untouched", async () => {
    await request("/config/keybr", {
      method: "PUT",
      headers: { ...bearer, "Content-Type": "application/json" },
      body: JSON.stringify({ publicId: "overridden-id", habitId: "overridden-habit" }),
    });

    const deleteResponse = await request("/config/keybr?key=publicId", { method: "DELETE", headers: bearer });
    expect(deleteResponse.status).toBe(204);

    const stored = await env.STATE.get("config:keybr");
    expect(JSON.parse(stored!)).toEqual({ habitId: "overridden-habit" });
  });

  it("returns 400 naming valid keys when ?key= isn't a declared setting", async () => {
    const response = await request("/config/keybr?key=nonexistent", { method: "DELETE", headers: bearer });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain("nonexistent");
  });

  it("clears every override without ?key=", async () => {
    await request("/config/keybr", {
      method: "PUT",
      headers: { ...bearer, "Content-Type": "application/json" },
      body: JSON.stringify({ publicId: "overridden-id" }),
    });

    const deleteResponse = await request("/config/keybr", { method: "DELETE", headers: bearer });
    expect(deleteResponse.status).toBe(204);
    expect(await env.STATE.get("config:keybr")).toBeNull();
  });
});

describe("a PUT override changes what the next sync reads", () => {
  afterEach(async () => {
    await env.STATE.delete("config:keybr");
    await env.STATE.delete(STATE_KEYS.sourceStatus("keybr"));
  });

  it("uses the KV-overridden publicId instead of KEYBR_PUBLIC_ID on the next sync", async () => {
    await request("/config/keybr", {
      method: "PUT",
      headers: { ...bearer, "Content-Type": "application/json" },
      body: JSON.stringify({ publicId: "overridden-id" }),
    });

    let requestedKeybrUrl: string | undefined;
    // Header-only keybr history: signature 0x4B455942, version 2, no records.
    const emptyKeybrHistory = Uint8Array.of(0x4b, 0x45, 0x59, 0x42, 0, 0, 0, 2);
    const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("keybr.com")) {
        requestedKeybrUrl = url;
        return new Response(emptyKeybrHistory, { status: 200 });
      }
      if (url.endsWith("/habits") && (init?.method ?? "GET") === "GET") {
        return Response.json({ data: [] });
      }
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    const response = await handleFetch(
      new Request("https://worker.example/sync?source=keybr", { method: "POST", headers: bearer }),
      authedEnv,
      fetchFn,
    );
    expect(response.status).toBe(200);
    expect(requestedKeybrUrl).toContain("overridden-id");
    expect(requestedKeybrUrl).not.toContain("b23mgn5");
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

describe("Cache-Control: no-store", () => {
  it("is present on a 200 response", async () => {
    const response = await request("/status", { headers: bearer });
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    // The body is still intact JSON with the right Content-Type — copying the response to add
    // the header must not have disturbed either.
    expect(response.headers.get("Content-Type")).toContain("application/json");
    const body = (await response.json()) as unknown;
    expect(body).toEqual(await (await request("/status", { headers: bearer })).json());
  });

  it("is present on the 401", async () => {
    const response = await request("/status");
    expect(response.status).toBe(401);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("is present on the 404", async () => {
    const response = await request("/nope", { headers: bearer });
    expect(response.status).toBe(404);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("is present on the Strava authorize 302, without breaking the redirect", async () => {
    const stravaEnv: Env = { ...authedEnv, STRAVA_CLIENT_ID: "client-id", STRAVA_CLIENT_SECRET: "client-secret" };
    const context = createExecutionContext();
    const response = await worker.fetch(
      new Request("https://worker.example/strava/authorize?token=secret-token"),
      stravaEnv,
      context,
    );
    await waitOnExecutionContext(context);
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toContain("https://www.strava.com/oauth/authorize");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
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
