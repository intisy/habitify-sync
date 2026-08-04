import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import worker, { handleFetch } from "../../index";
import { readJson, writeJson } from "../../state";
import { AuthNeededError, type Env, type SourceContext } from "../types";
import { KINDLE_STATE_KEYS, kindleIntegration, type KindlePositions, type KindleSession } from "./index";

const DEVICE_TOKEN_URL = "https://read.amazon.com/service/web/register/getDeviceToken";
const LIBRARY_URL = "https://read.amazon.com/kindle-library/search";
const START_READING_URL = "https://read.amazon.com/service/mobile/reader/startReading";

const DUMMY_SESSION: KindleSession = {
  cookie: "session-id=000-0000000-0000000; ubid-main=000-0000000-0000000",
  deviceSerialNumber: "TESTSERIAL0001",
  deviceType: "A1TESTDEVICETYPE",
  updatedAt: "2026-08-01T00:00:00.000Z",
};

function makeContext(testEnv: Env, fetchFn: typeof fetch, today = "2026-08-04"): SourceContext {
  return { env: testEnv, timeZone: "Europe/Berlin", today, now: new Date(`${today}T10:00:00Z`), fetchFn };
}

function kindleEnv(): Env {
  return { ...env, HABIT_ID_KINDLE: "habit-k" };
}

function libraryResponse(items: { asin: string; percentageRead: number }[]) {
  return Response.json({
    itemsList: items.map((item) => ({
      asin: item.asin,
      title: `Book ${item.asin}`,
      percentageRead: item.percentageRead,
      resourceType: "EBOOK",
      originType: "PURCHASE",
    })),
    libraryType: "BOOKS",
    sortType: "recency",
  });
}

beforeEach(async () => {
  await env.STATE.delete(KINDLE_STATE_KEYS.session);
  await env.STATE.delete(KINDLE_STATE_KEYS.positions);
});

describe("kindleIntegration.enabled", () => {
  it("is false without HABIT_ID_KINDLE and true with it", () => {
    expect(kindleIntegration.enabled({ ...env, HABIT_ID_KINDLE: undefined })).toBe(false);
    expect(kindleIntegration.enabled({ ...env, HABIT_ID_KINDLE: "" })).toBe(false);
    expect(kindleIntegration.enabled(kindleEnv())).toBe(true);
  });
});

describe("kindleIntegration.fetchToday - auth", () => {
  it("throws AuthNeededError when no session is stored", async () => {
    const fetchFn = (async () => {
      throw new Error("fetch should not be called without a stored session");
    }) as typeof fetch;
    await expect(kindleIntegration.fetchToday(makeContext(kindleEnv(), fetchFn))).rejects.toThrow(AuthNeededError);
  });

  it("throws AuthNeededError when getDeviceToken returns a 4xx status", async () => {
    await writeJson(env.STATE, KINDLE_STATE_KEYS.session, DUMMY_SESSION);
    const fetchFn = (async (input: RequestInfo | URL) => {
      expect(String(input)).toContain(DEVICE_TOKEN_URL);
      return new Response("forbidden", { status: 403 });
    }) as typeof fetch;
    await expect(kindleIntegration.fetchToday(makeContext(kindleEnv(), fetchFn))).rejects.toThrow(AuthNeededError);
  });

  it("throws AuthNeededError when getDeviceToken's body has no usable token field", async () => {
    await writeJson(env.STATE, KINDLE_STATE_KEYS.session, DUMMY_SESSION);
    const fetchFn = (async (input: RequestInfo | URL) => {
      expect(String(input)).toContain(DEVICE_TOKEN_URL);
      return Response.json({ somethingElse: "no token here" });
    }) as typeof fetch;
    await expect(kindleIntegration.fetchToday(makeContext(kindleEnv(), fetchFn))).rejects.toThrow(AuthNeededError);
  });
});

describe("kindleIntegration.fetchToday - happy path and baseline/delta", () => {
  beforeEach(async () => {
    await writeJson(env.STATE, KINDLE_STATE_KEYS.session, DUMMY_SESSION);
  });

  function makeFetch(positionsByAsin: Record<string, number>, sentTokens: string[]) {
    return (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith(DEVICE_TOKEN_URL)) {
        return Response.json({ deviceSessionToken: "adp-session-token-1" });
      }
      if (url.startsWith(LIBRARY_URL)) {
        return libraryResponse(Object.keys(positionsByAsin).map((asin) => ({ asin, percentageRead: 0 })));
      }
      if (url.startsWith(START_READING_URL)) {
        const asin = new URL(url).searchParams.get("asin")!;
        sentTokens.push(new Headers(init?.headers).get("x-adp-session-token") ?? "");
        return Response.json({ lastPageReadData: { position: positionsByAsin[asin], syncTime: 1 } });
      }
      throw new Error(`unexpected fetch to ${url}`);
    }) as typeof fetch;
  }

  it("establishes a baseline on the first sync of the day and returns 0", async () => {
    const sentTokens: string[] = [];
    const fetchFn = makeFetch({ ASIN1: 1400, ASIN2: 2800 }, sentTokens);

    const values = await kindleIntegration.fetchToday(makeContext(kindleEnv(), fetchFn));

    expect(values).toEqual([{ habitId: "habit-k", value: 0, unit: "pages" }]);
    expect(sentTokens).toEqual(["adp-session-token-1", "adp-session-token-1"]);

    const stored = await readJson<KindlePositions>(env.STATE, KINDLE_STATE_KEYS.positions);
    expect(stored).toEqual({ date: "2026-08-04", pages: { ASIN1: 1, ASIN2: 2 }, estimated: true });
  });

  it("returns the page delta on a second sync the same day", async () => {
    await writeJson(env.STATE, KINDLE_STATE_KEYS.positions, {
      date: "2026-08-04",
      pages: { ASIN1: 1, ASIN2: 2 },
      estimated: true,
    } satisfies KindlePositions);

    const fetchFn = makeFetch({ ASIN1: 2900, ASIN2: 4300 }, []);
    const values = await kindleIntegration.fetchToday(makeContext(kindleEnv(), fetchFn));

    // ASIN1: floor(2900/1400) = 2, delta 1. ASIN2: floor(4300/1400) = 3, delta 1. Total 2.
    expect(values).toEqual([{ habitId: "habit-k", value: 2, unit: "pages" }]);
  });

  it("does not establish a new baseline for a different day than local 'today'", async () => {
    await writeJson(env.STATE, KINDLE_STATE_KEYS.positions, {
      date: "2026-08-03",
      pages: { ASIN1: 5, ASIN2: 5 },
      estimated: true,
    } satisfies KindlePositions);

    const fetchFn = makeFetch({ ASIN1: 1400, ASIN2: 2800 }, []);
    const values = await kindleIntegration.fetchToday(makeContext(kindleEnv(), fetchFn));

    // Stale baseline is from a previous day, so today resets to 0 rather than using it.
    expect(values).toEqual([{ habitId: "habit-k", value: 0, unit: "pages" }]);
    const stored = await readJson<KindlePositions>(env.STATE, KINDLE_STATE_KEYS.positions);
    expect(stored?.date).toBe("2026-08-04");
  });
});

describe("kindleIntegration.fetchToday - per-book failure isolation", () => {
  beforeEach(async () => {
    await writeJson(env.STATE, KINDLE_STATE_KEYS.session, DUMMY_SESSION);
  });

  it("skips a book whose startReading fails, without failing the whole source", async () => {
    const fetchFn = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith(DEVICE_TOKEN_URL)) return Response.json({ deviceSessionToken: "token" });
      if (url.startsWith(LIBRARY_URL)) {
        return libraryResponse([
          { asin: "BROKEN", percentageRead: 0 },
          { asin: "GOOD", percentageRead: 0 },
        ]);
      }
      if (url.startsWith(START_READING_URL)) {
        const asin = new URL(url).searchParams.get("asin")!;
        if (asin === "BROKEN") return new Response("server error", { status: 500 });
        return Response.json({ lastPageReadData: { position: 1400 } });
      }
      throw new Error(`unexpected fetch to ${url}`);
    }) as typeof fetch;

    const values = await kindleIntegration.fetchToday(makeContext(kindleEnv(), fetchFn));

    expect(values).toEqual([{ habitId: "habit-k", value: 0, unit: "pages" }]);
    const stored = await readJson<KindlePositions>(env.STATE, KINDLE_STATE_KEYS.positions);
    // Only the successful book made it into the baseline; the broken one is simply absent.
    expect(stored?.pages).toEqual({ GOOD: 1 });
  });

  it("throws naming the last failure when every book fails", async () => {
    const fetchFn = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith(DEVICE_TOKEN_URL)) return Response.json({ deviceSessionToken: "token" });
      if (url.startsWith(LIBRARY_URL)) return libraryResponse([{ asin: "ASIN1", percentageRead: 0 }]);
      if (url.startsWith(START_READING_URL)) return new Response("server error", { status: 503 });
      throw new Error(`unexpected fetch to ${url}`);
    }) as typeof fetch;

    await expect(kindleIntegration.fetchToday(makeContext(kindleEnv(), fetchFn))).rejects.toThrow("503");
  });
});

describe("kindleIntegration.fetchToday - page derivation tiers", () => {
  beforeEach(async () => {
    await writeJson(env.STATE, KINDLE_STATE_KEYS.session, DUMMY_SESSION);
  });

  function fetchFor(startReadingBody: Record<string, unknown>, extra?: Record<string, () => Response>) {
    return (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith(DEVICE_TOKEN_URL)) return Response.json({ deviceSessionToken: "token" });
      if (url.startsWith(LIBRARY_URL)) return libraryResponse([{ asin: "ASIN1", percentageRead: 10 }]);
      if (url.startsWith(START_READING_URL)) return Response.json(startReadingBody);
      if (extra?.[url]) return extra[url]();
      throw new Error(`unexpected fetch to ${url}`);
    }) as typeof fetch;
  }

  it("tier 1: uses the pageNumberUrl map as the authoritative page when it parses", async () => {
    const fetchFn = fetchFor(
      { lastPageReadData: { position: 2900 }, pageNumberUrl: "https://cdn.example.com/pagemap/asin1" },
      { "https://cdn.example.com/pagemap/asin1": () => Response.json([0, 1400, 2800, 4200]) },
    );
    const values = await kindleIntegration.fetchToday(makeContext(kindleEnv(), fetchFn));
    // map[2] = 2800 <= 2900 < map[3] = 4200, so page index 2, and tier 1 is not an estimate.
    expect(values).toEqual([{ habitId: "habit-k", value: 0, unit: "pages" }]);
    const stored = await readJson<KindlePositions>(env.STATE, KINDLE_STATE_KEYS.positions);
    expect(stored).toEqual({ date: "2026-08-04", pages: { ASIN1: 2 }, estimated: false });
  });

  it("tier 1: an unparseable pageNumberUrl falls through to the next strategy", async () => {
    const fetchFn = fetchFor(
      { lastPageReadData: { position: 1400 }, pageNumberUrl: "https://cdn.example.com/pagemap/bad" },
      { "https://cdn.example.com/pagemap/bad": () => Response.json({ unexpectedShape: true }) },
    );
    const values = await kindleIntegration.fetchToday(makeContext(kindleEnv(), fetchFn));
    const stored = await readJson<KindlePositions>(env.STATE, KINDLE_STATE_KEYS.positions);
    // No metadataUrl either, so it falls all the way to tier 3: floor(1400/1400) = 1, estimated.
    expect(values).toEqual([{ habitId: "habit-k", value: 0, unit: "pages" }]);
    expect(stored).toEqual({ date: "2026-08-04", pages: { ASIN1: 1 }, estimated: true });
  });

  it("tier 2: derives a page from percentageRead and metadata's endPosition when no page map is available", async () => {
    const fetchFn = fetchFor(
      { lastPageReadData: { position: 14000 }, metadataUrl: "https://cdn.example.com/metadata/asin1" },
      {
        "https://cdn.example.com/metadata/asin1": () =>
          new Response('someCallback({"startPosition":0,"endPosition":140000})'),
      },
    );
    const values = await kindleIntegration.fetchToday(makeContext(kindleEnv(), fetchFn));
    // estimatedTotalPages = round(140000/1400) = 100; page = round(10/100 * 100) = 10.
    const stored = await readJson<KindlePositions>(env.STATE, KINDLE_STATE_KEYS.positions);
    expect(values).toEqual([{ habitId: "habit-k", value: 0, unit: "pages" }]);
    expect(stored).toEqual({ date: "2026-08-04", pages: { ASIN1: 10 }, estimated: true });
  });

  it("tier 3: falls back to position / positionsPerPage when no map or metadata is usable", async () => {
    const fetchFn = fetchFor({ lastPageReadData: { position: 2800 } });
    const values = await kindleIntegration.fetchToday(makeContext(kindleEnv(), fetchFn));
    const stored = await readJson<KindlePositions>(env.STATE, KINDLE_STATE_KEYS.positions);
    expect(values).toEqual([{ habitId: "habit-k", value: 0, unit: "pages" }]);
    expect(stored).toEqual({ date: "2026-08-04", pages: { ASIN1: 2 }, estimated: true });
  });

  it("tier 3: also used when the metadataUrl fetch fails, treating it as best-effort", async () => {
    const fetchFn = fetchFor(
      { lastPageReadData: { position: 1400 }, metadataUrl: "https://cdn.example.com/metadata/down" },
      { "https://cdn.example.com/metadata/down": () => new Response("gateway timeout", { status: 504 }) },
    );
    const values = await kindleIntegration.fetchToday(makeContext(kindleEnv(), fetchFn));
    const stored = await readJson<KindlePositions>(env.STATE, KINDLE_STATE_KEYS.positions);
    expect(values).toEqual([{ habitId: "habit-k", value: 0, unit: "pages" }]);
    expect(stored).toEqual({ date: "2026-08-04", pages: { ASIN1: 1 }, estimated: true });
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

describe("PUT /kindle/session", () => {
  it("stores a valid session and returns 204", async () => {
    const response = await request("/kindle/session", {
      method: "PUT",
      headers: { ...bearer, "Content-Type": "application/json" },
      body: JSON.stringify({
        cookie: "session-id=1-2-3",
        deviceSerialNumber: "SERIAL-ABC",
        deviceType: "A1SOMETYPE",
      }),
    });

    expect(response.status).toBe(204);
    const stored = await readJson<KindleSession>(env.STATE, KINDLE_STATE_KEYS.session);
    expect(stored?.cookie).toBe("session-id=1-2-3");
    expect(stored?.deviceSerialNumber).toBe("SERIAL-ABC");
    expect(stored?.deviceType).toBe("A1SOMETYPE");
  });

  it("returns 400 for a malformed JSON body", async () => {
    const response = await request("/kindle/session", {
      method: "PUT",
      headers: { ...bearer, "Content-Type": "application/json" },
      body: "not json",
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBeTruthy();
  });

  it("returns 400 when a required field is missing or empty", async () => {
    const response = await request("/kindle/session", {
      method: "PUT",
      headers: { ...bearer, "Content-Type": "application/json" },
      body: JSON.stringify({ cookie: "abc", deviceSerialNumber: "", deviceType: "A1SOMETYPE" }),
    });
    expect(response.status).toBe(400);
  });
});

describe("DELETE /kindle/session", () => {
  it("clears the stored session", async () => {
    await writeJson(env.STATE, KINDLE_STATE_KEYS.session, DUMMY_SESSION);
    const response = await handleFetch(
      new Request("https://worker.example/kindle/session", { method: "DELETE", headers: bearer }),
      authedEnv,
    );
    expect(response.status).toBe(204);
    expect(await readJson<KindleSession>(env.STATE, KINDLE_STATE_KEYS.session)).toBeNull();
  });
});
