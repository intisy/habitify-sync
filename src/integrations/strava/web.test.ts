import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import worker from "../../index";
import { readJson, writeJson } from "../../state";
import { SettingsResolver } from "../../settings";
import { AuthNeededError, type Env, type SourceContext } from "../types";
import { fetchWebActivities, STRAVA_WEB_STATE_KEYS, type StravaSession } from "./web";
import { stravaIntegration } from "./index";

const now = new Date("2026-08-04T10:00:00Z");
// Naive Berlin midnight: what start_date_local_raw is compared against.
const todayStart = Date.parse("2026-08-04T00:00:00Z") / 1000;
const session: StravaSession = { cookie: "_strava4_session=abc", updatedAt: "2026-08-04T00:00:00.000Z" };

function makeContext(fetchFn: typeof fetch): SourceContext {
  const testEnv: Env = { ...env, HABIT_ID_STRAVA: "habit-s" };
  const settings = new SettingsResolver(testEnv, testEnv.STATE, "strava", stravaIntegration.settings);
  return { env: testEnv, timeZone: "Europe/Berlin", today: "2026-08-04", now, fetchFn, settings };
}

function jsonFetch(body: unknown): typeof fetch {
  return (async () => Response.json(body)) as typeof fetch;
}

describe("fetchWebActivities", () => {
  it("requests the training activities page with the stored cookie and browser headers", async () => {
    const seen: { url: string; headers: Headers }[] = [];
    const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push({ url: String(input), headers: new Headers(init?.headers) });
      return Response.json({ models: [] });
    }) as typeof fetch;

    await fetchWebActivities(makeContext(fetchFn), session);

    expect(seen[0].url).toBe("https://www.strava.com/athlete/training_activities?page=1&per_page=100");
    expect(seen[0].headers.get("Cookie")).toBe("_strava4_session=abc");
    expect(seen[0].headers.get("X-Requested-With")).toBe("XMLHttpRequest");
    expect(seen[0].headers.get("Referer")).toBe("https://www.strava.com/athlete/training");
    expect(seen[0].headers.get("User-Agent")).toContain("Mozilla/5.0");
  });

  it("sums today's activities and reports which field names matched", async () => {
    const result = await fetchWebActivities(
      makeContext(
        jsonFetch({
          models: [
            { moving_time_raw: 1800, start_date_local_raw: todayStart + 3600 },
            { moving_time_raw: 900, start_date_local_raw: todayStart + 7200 },
          ],
        }),
      ),
      session,
    );

    expect(result.activities).toEqual([{ movingTimeSeconds: 1800 }, { movingTimeSeconds: 900 }]);
    expect(result.diagnostics).toEqual({
      reader: "web",
      activitiesSeen: 2,
      activitiesCounted: 2,
      fieldsMatched: { movingTime: "moving_time_raw", startedAt: "start_date_local_raw" },
    });
  });

  it("falls back to the alternate field names and records that it did", async () => {
    const result = await fetchWebActivities(
      makeContext(jsonFetch({ models: [{ moving_time: 600, start_date_local: todayStart + 60 }] })),
      session,
    );

    expect(result.activities).toEqual([{ movingTimeSeconds: 600 }]);
    expect(result.diagnostics.fieldsMatched).toEqual({ movingTime: "moving_time", startedAt: "start_date_local" });
  });

  it("skips a model with no recognizable fields rather than counting it as zero", async () => {
    const result = await fetchWebActivities(
      makeContext(jsonFetch({ models: [{ renamed_time: 1800, renamed_start: todayStart }, { renamed_time: 60 }] })),
      session,
    );

    expect(result.activities).toEqual([]);
    expect(result.diagnostics.activitiesSeen).toBe(2);
    expect(result.diagnostics.activitiesCounted).toBe(0);
    expect(result.diagnostics.fieldsMatched).toEqual({ movingTime: null, startedAt: null });
  });

  it("excludes activities from before local midnight", async () => {
    const result = await fetchWebActivities(
      makeContext(
        jsonFetch({
          models: [
            { moving_time_raw: 1800, start_date_local_raw: todayStart + 60 },
            { moving_time_raw: 3600, start_date_local_raw: todayStart - 60 },
          ],
        }),
      ),
      session,
    );

    expect(result.activities).toEqual([{ movingTimeSeconds: 1800 }]);
    expect(result.diagnostics.activitiesSeen).toBe(2);
    expect(result.diagnostics.activitiesCounted).toBe(1);
  });

  it("counts an early-morning activity that only the naive boundary admits", async () => {
    // 00:30 Berlin local on 2026-08-04. The true-UTC boundary sits two hours later in this frame,
    // so comparing against localMidnightEpochSeconds would wrongly exclude this activity.
    const result = await fetchWebActivities(
      makeContext(jsonFetch({ models: [{ moving_time_raw: 1200, start_date_local_raw: todayStart + 1800 }] })),
      session,
    );
    expect(result.activities).toEqual([{ movingTimeSeconds: 1200 }]);
  });

  it("scans the whole page rather than stopping at the first old activity", async () => {
    const result = await fetchWebActivities(
      makeContext(
        jsonFetch({
          models: [
            { moving_time_raw: 600, start_date_local_raw: todayStart - 60 },
            { moving_time_raw: 900, start_date_local_raw: todayStart + 60 },
          ],
        }),
      ),
      session,
    );
    expect(result.activities).toEqual([{ movingTimeSeconds: 900 }]);
  });

  it("throws AuthNeededError when Strava rejects the cookie", async () => {
    for (const status of [401, 403]) {
      const fetchFn = (async () => new Response("denied", { status })) as typeof fetch;
      await expect(fetchWebActivities(makeContext(fetchFn), session)).rejects.toThrow(AuthNeededError);
    }
  });

  it("throws a plain error for another non-2xx status", async () => {
    const fetchFn = (async () => new Response("oops", { status: 500 })) as typeof fetch;
    await expect(fetchWebActivities(makeContext(fetchFn), session)).rejects.toThrow(
      "Strava training activities request failed with status 500",
    );
  });

  it("names the content type when a bot challenge returns HTML", async () => {
    const fetchFn = (async () =>
      new Response("<html>challenge</html>", { headers: { "Content-Type": "text/html" } })) as typeof fetch;
    await expect(fetchWebActivities(makeContext(fetchFn), session)).rejects.toThrow("text/html");
  });

  it("throws when models is not an array", async () => {
    await expect(fetchWebActivities(makeContext(jsonFetch({ models: "nope" })), session)).rejects.toThrow(
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

describe("PUT /strava/session", () => {
  beforeEach(async () => {
    await env.STATE.delete(STRAVA_WEB_STATE_KEYS.session);
  });

  it("stores the cookie and returns 204", async () => {
    const response = await request("/strava/session", {
      method: "PUT",
      headers: { ...bearer, "Content-Type": "application/json" },
      body: JSON.stringify({ cookie: "_strava4_session=abc; strava_remember_token=xyz" }),
    });

    expect(response.status).toBe(204);
    const stored = await readJson<StravaSession>(env.STATE, STRAVA_WEB_STATE_KEYS.session);
    expect(stored?.cookie).toBe("_strava4_session=abc; strava_remember_token=xyz");
    expect(stored?.updatedAt).toBeTruthy();
  });

  it("returns 400 for a malformed JSON body", async () => {
    const response = await request("/strava/session", {
      method: "PUT",
      headers: { ...bearer, "Content-Type": "application/json" },
      body: "not json",
    });
    expect(response.status).toBe(400);
  });

  it("returns 400 when cookie is missing or empty", async () => {
    const response = await request("/strava/session", {
      method: "PUT",
      headers: { ...bearer, "Content-Type": "application/json" },
      body: JSON.stringify({ cookie: "" }),
    });
    expect(response.status).toBe(400);
  });

  it("rejects a request with no admin token", async () => {
    const response = await request("/strava/session", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cookie: "_strava4_session=abc" }),
    });
    expect(response.status).toBe(401);
  });
});

describe("DELETE /strava/session", () => {
  it("clears the stored session", async () => {
    await writeJson(env.STATE, STRAVA_WEB_STATE_KEYS.session, session);
    const response = await request("/strava/session", { method: "DELETE", headers: bearer });
    expect(response.status).toBe(204);
    expect(await readJson<StravaSession>(env.STATE, STRAVA_WEB_STATE_KEYS.session)).toBeNull();
  });

  it("rejects a request with no admin token", async () => {
    const response = await request("/strava/session", { method: "DELETE" });
    expect(response.status).toBe(401);
  });
});
