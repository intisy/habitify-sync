import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import worker, { handleFetch } from "../../index";
import { readJson, writeJson } from "../../state";
import { AuthNeededError, type Env, type SourceContext } from "../types";
import { KINDLE_STATE_KEYS, kindleIntegration, type KindlePositions, type KindleSession } from "./index";

const DEVICE_TOKEN_URL = "https://read.amazon.com/service/web/register/getDeviceToken";
const LIBRARY_URL = "https://read.amazon.com/kindle-library/search";
const START_READING_URL = "https://read.amazon.com/service/mobile/reader/startReading";

// A fake but well-formed Amazon cookie header — never a real value. session-id is the piece the
// integration promotes to the x-amzn-sessionid header.
const DUMMY_SESSION: KindleSession = {
  cookie: "session-id=999-0000000-0000000; at-main=DUMMY; ubid-main=999-1111111-1111111",
  updatedAt: "2026-08-01T00:00:00.000Z",
};
const DUMMY_SESSION_ID = "999-0000000-0000000";

// Three real books' verified startPosition/endPosition, used to ground the progress-fraction tests.
const DEEP_WORK = { asin: "ASINDEEPWORK01", startPosition: 3, endPosition: 456177, position: 8047 };
const C_PROGRAMMING_LANGUAGE = { asin: "ASINCPROGLANG1", startPosition: 3, endPosition: 563246, position: 238526 };
const ESV_BIBLE = { asin: "ASINESVBIBLE01", startPosition: 3, endPosition: 6960680, position: 5238294 };

function makeContext(testEnv: Env, fetchFn: typeof fetch, today = "2026-08-04"): SourceContext {
  return { env: testEnv, timeZone: "Europe/Berlin", today, now: new Date(`${today}T10:00:00Z`), fetchFn };
}

function kindleEnv(overrides: Partial<Env> = {}): Env {
  return { ...env, HABIT_ID_KINDLE: "habit-k", ...overrides };
}

function libraryResponse(asins: string[]) {
  return Response.json({
    itemsList: asins.map((asin) => ({
      asin,
      title: `Book ${asin}`,
      percentageRead: 0, // verified to always be 0 live; the integration never reads this field
      resourceType: "EBOOK",
      originType: "PURCHASE",
    })),
    libraryType: "BOOKS",
    sortType: "recency",
  });
}

function jsonp(body: Record<string, unknown>): string {
  return `loadMetadata(${JSON.stringify(body)});`;
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

  it("throws AuthNeededError when the stored cookie lacks session-id", async () => {
    await writeJson(env.STATE, KINDLE_STATE_KEYS.session, {
      cookie: "at-main=DUMMY; ubid-main=999-1111111-1111111",
      updatedAt: "2026-08-01T00:00:00.000Z",
    } satisfies KindleSession);
    const fetchFn = (async () => {
      throw new Error("fetch should not be called when session-id is missing");
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

  it("throws AuthNeededError when getDeviceToken's body has no deviceSessionToken field", async () => {
    await writeJson(env.STATE, KINDLE_STATE_KEYS.session, DUMMY_SESSION);
    const fetchFn = (async (input: RequestInfo | URL) => {
      expect(String(input)).toContain(DEVICE_TOKEN_URL);
      return Response.json({ clientHashId: "x", deviceName: "y", eid: "z" });
    }) as typeof fetch;
    await expect(kindleIntegration.fetchToday(makeContext(kindleEnv(), fetchFn))).rejects.toThrow(AuthNeededError);
  });

  it("sends x-amzn-sessionid on getDeviceToken and both x-amzn-sessionid and x-adp-session-token on startReading", async () => {
    await writeJson(env.STATE, KINDLE_STATE_KEYS.session, DUMMY_SESSION);
    const seenHeaders: { url: string; headers: Headers }[] = [];
    const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      seenHeaders.push({ url, headers: new Headers(init?.headers) });
      if (url.startsWith(DEVICE_TOKEN_URL)) return Response.json({ deviceSessionToken: "a".repeat(1481) });
      if (url.startsWith(LIBRARY_URL)) return libraryResponse(["ASIN1"]);
      if (url.startsWith(START_READING_URL)) return Response.json({ lastPageReadData: { position: 100 } });
      throw new Error(`unexpected fetch to ${url}`);
    }) as typeof fetch;

    await kindleIntegration.fetchToday(makeContext(kindleEnv(), fetchFn));

    const deviceTokenCall = seenHeaders.find((call) => call.url.startsWith(DEVICE_TOKEN_URL))!;
    expect(deviceTokenCall.headers.get("x-amzn-sessionid")).toBe(DUMMY_SESSION_ID);

    const startReadingCall = seenHeaders.find((call) => call.url.startsWith(START_READING_URL))!;
    expect(startReadingCall.headers.get("x-amzn-sessionid")).toBe(DUMMY_SESSION_ID);
    expect(startReadingCall.headers.get("x-adp-session-token")).toBe("a".repeat(1481));
  });

  it("uses the constant device id as both serialNumber and deviceType, with no per-user capture", async () => {
    await writeJson(env.STATE, KINDLE_STATE_KEYS.session, DUMMY_SESSION);
    const fetchFn = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith(DEVICE_TOKEN_URL)) {
        const parsed = new URL(url);
        expect(parsed.searchParams.get("serialNumber")).toBe("A2CTZ977SKFQZY");
        expect(parsed.searchParams.get("deviceType")).toBe("A2CTZ977SKFQZY");
        return Response.json({ deviceSessionToken: "token" });
      }
      if (url.startsWith(LIBRARY_URL)) return libraryResponse([]);
      throw new Error(`unexpected fetch to ${url}`);
    }) as typeof fetch;

    await kindleIntegration.fetchToday(makeContext(kindleEnv(), fetchFn));
  });
});

describe("kindleIntegration.fetchToday - skipped books", () => {
  beforeEach(async () => {
    await writeJson(env.STATE, KINDLE_STATE_KEYS.session, DUMMY_SESSION);
  });

  it("silently skips a book with lastPageReadData: null and one with position: -1, without failing the sync", async () => {
    const fetchFn = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith(DEVICE_TOKEN_URL)) return Response.json({ deviceSessionToken: "token" });
      if (url.startsWith(LIBRARY_URL)) return libraryResponse(["PDOC", "NEVER_OPENED", "NORMAL"]);
      if (url.startsWith(START_READING_URL)) {
        const asin = new URL(url).searchParams.get("asin")!;
        if (asin === "PDOC") return Response.json({ lastPageReadData: null });
        if (asin === "NEVER_OPENED") return Response.json({ lastPageReadData: { position: -1 } });
        return Response.json({ lastPageReadData: { position: 1800 } });
      }
      throw new Error(`unexpected fetch to ${url}`);
    }) as typeof fetch;

    const values = await kindleIntegration.fetchToday(makeContext(kindleEnv(), fetchFn));

    expect(values).toEqual([expect.objectContaining({ habitId: "habit-k", value: 0, unit: "pages" })]);
    const stored = await readJson<KindlePositions>(env.STATE, KINDLE_STATE_KEYS.positions);
    // Only the normal book's baseline is recorded; the two skipped books never appear.
    expect(stored?.positions).toEqual({ NORMAL: 1800 });
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
      if (url.startsWith(LIBRARY_URL)) return libraryResponse(["BROKEN", "GOOD"]);
      if (url.startsWith(START_READING_URL)) {
        const asin = new URL(url).searchParams.get("asin")!;
        if (asin === "BROKEN") return new Response("server error", { status: 500 });
        return Response.json({ lastPageReadData: { position: 1800 } });
      }
      throw new Error(`unexpected fetch to ${url}`);
    }) as typeof fetch;

    const values = await kindleIntegration.fetchToday(makeContext(kindleEnv(), fetchFn));

    expect(values).toEqual([expect.objectContaining({ habitId: "habit-k", value: 0, unit: "pages" })]);
    const stored = await readJson<KindlePositions>(env.STATE, KINDLE_STATE_KEYS.positions);
    expect(stored?.positions).toEqual({ GOOD: 1800 });
  });

  it("throws naming the last failure when every book fails", async () => {
    const fetchFn = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith(DEVICE_TOKEN_URL)) return Response.json({ deviceSessionToken: "token" });
      if (url.startsWith(LIBRARY_URL)) return libraryResponse(["ASIN1"]);
      if (url.startsWith(START_READING_URL)) return new Response("server error", { status: 503 });
      throw new Error(`unexpected fetch to ${url}`);
    }) as typeof fetch;

    await expect(kindleIntegration.fetchToday(makeContext(kindleEnv(), fetchFn))).rejects.toThrow("503");
  });
});

describe("kindleIntegration.fetchToday - metadata JSONP and progress fraction", () => {
  beforeEach(async () => {
    await writeJson(env.STATE, KINDLE_STATE_KEYS.session, DUMMY_SESSION);
  });

  function fetchForBooks(books: { asin: string; position: number; startPosition: number; endPosition: number }[]) {
    return (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith(DEVICE_TOKEN_URL)) return Response.json({ deviceSessionToken: "token" });
      if (url.startsWith(LIBRARY_URL)) return libraryResponse(books.map((book) => book.asin));
      if (url.startsWith(START_READING_URL)) {
        const asin = new URL(url).searchParams.get("asin")!;
        const book = books.find((candidate) => candidate.asin === asin)!;
        return Response.json({
          lastPageReadData: { position: book.position },
          metadataUrl: `https://cdn.example.com/metadata/${asin}`,
        });
      }
      const metadataMatch = url.match(/metadata\/(.+)$/);
      if (metadataMatch) {
        const book = books.find((candidate) => candidate.asin === metadataMatch[1])!;
        return new Response(jsonp({ startPosition: book.startPosition, endPosition: book.endPosition }));
      }
      throw new Error(`unexpected fetch to ${url}`);
    }) as typeof fetch;
  }

  it("unwraps JSONP with a trailing ); and surrounding whitespace", async () => {
    await writeJson(env.STATE, KINDLE_STATE_KEYS.session, DUMMY_SESSION);
    const fetchFn = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith(DEVICE_TOKEN_URL)) return Response.json({ deviceSessionToken: "token" });
      if (url.startsWith(LIBRARY_URL)) return libraryResponse(["ASIN1"]);
      if (url.startsWith(START_READING_URL)) {
        return Response.json({
          lastPageReadData: { position: DEEP_WORK.position },
          metadataUrl: "https://cdn.example.com/metadata/asin1",
        });
      }
      if (url === "https://cdn.example.com/metadata/asin1") {
        return new Response(
          `  \n  identifier(   {"startPosition":${DEEP_WORK.startPosition},"endPosition":${DEEP_WORK.endPosition},"bookSize":999999}   )  ;  \n  `,
        );
      }
      throw new Error(`unexpected fetch to ${url}`);
    }) as typeof fetch;

    const values = await kindleIntegration.fetchToday(makeContext(kindleEnv(), fetchFn));
    const [value] = values as unknown as { books: { asin: string; progress: number }[] }[];
    expect(value.books).toHaveLength(1);
    expect(value.books[0].progress).toBeCloseTo(0.018, 2);
  });

  it("computes the progress fraction correctly for the three verified books", async () => {
    const fetchFn = fetchForBooks([DEEP_WORK, C_PROGRAMMING_LANGUAGE, ESV_BIBLE]);
    const values = await kindleIntegration.fetchToday(makeContext(kindleEnv(), fetchFn));
    const [value] = values as unknown as { books: { asin: string; progress: number }[] }[];
    const byAsin = Object.fromEntries(value.books.map((book) => [book.asin, book.progress]));
    expect(byAsin[DEEP_WORK.asin]).toBeCloseTo(0.018, 2);
    expect(byAsin[C_PROGRAMMING_LANGUAGE.asin]).toBeCloseTo(0.42, 2);
    expect(byAsin[ESV_BIBLE.asin]).toBeCloseTo(0.75, 2);
  });
});

describe("kindleIntegration.fetchToday - page delta math and baseline lifecycle", () => {
  beforeEach(async () => {
    await writeJson(env.STATE, KINDLE_STATE_KEYS.session, DUMMY_SESSION);
  });

  function fetchForPositions(positionsByAsin: Record<string, number>) {
    return (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith(DEVICE_TOKEN_URL)) return Response.json({ deviceSessionToken: "token" });
      if (url.startsWith(LIBRARY_URL)) return libraryResponse(Object.keys(positionsByAsin));
      if (url.startsWith(START_READING_URL)) {
        const asin = new URL(url).searchParams.get("asin")!;
        return Response.json({ lastPageReadData: { position: positionsByAsin[asin] } });
      }
      throw new Error(`unexpected fetch to ${url}`);
    }) as typeof fetch;
  }

  it("establishes a baseline on the first sync of the day and returns 0", async () => {
    const fetchFn = fetchForPositions({ ASIN1: 1000, ASIN2: 2000 });
    const values = await kindleIntegration.fetchToday(makeContext(kindleEnv(), fetchFn));
    expect(values).toEqual([expect.objectContaining({ habitId: "habit-k", value: 0, unit: "pages" })]);
    const stored = await readJson<KindlePositions>(env.STATE, KINDLE_STATE_KEYS.positions);
    // No pageNumberUrl on either book, so the sync truthfully reports estimated even though the
    // total itself is 0 (a fresh baseline never invents progress).
    expect(stored).toEqual({ date: "2026-08-04", positions: { ASIN1: 1000, ASIN2: 2000 }, estimated: true });
  });

  it("yields the position delta divided by POSITIONS_PER_PAGE on a later sync using the default var", async () => {
    await writeJson(env.STATE, KINDLE_STATE_KEYS.positions, {
      date: "2026-08-04",
      positions: { ASIN1: 1000 },
      estimated: false,
    } satisfies KindlePositions);

    const fetchFn = fetchForPositions({ ASIN1: 1000 + 3600 }); // delta 3600, default 1800/page => 2 pages
    const values = await kindleIntegration.fetchToday(makeContext(kindleEnv(), fetchFn));
    expect(values).toEqual([expect.objectContaining({ value: 2, estimated: true })]);
  });

  it("honors KINDLE_POSITIONS_PER_PAGE when overridden", async () => {
    await writeJson(env.STATE, KINDLE_STATE_KEYS.positions, {
      date: "2026-08-04",
      positions: { ASIN1: 1000 },
      estimated: false,
    } satisfies KindlePositions);

    const fetchFn = fetchForPositions({ ASIN1: 1000 + 3600 }); // delta 3600, 900/page override => 4 pages
    const values = await kindleIntegration.fetchToday(
      makeContext(kindleEnv({ KINDLE_POSITIONS_PER_PAGE: "900" }), fetchFn),
    );
    expect(values).toEqual([expect.objectContaining({ value: 4, estimated: true })]);
  });

  it("does not establish a new baseline for a different day than local 'today'", async () => {
    await writeJson(env.STATE, KINDLE_STATE_KEYS.positions, {
      date: "2026-08-03",
      positions: { ASIN1: 5000, ASIN2: 5000 },
      estimated: false,
    } satisfies KindlePositions);

    const fetchFn = fetchForPositions({ ASIN1: 1000, ASIN2: 2000 });
    const values = await kindleIntegration.fetchToday(makeContext(kindleEnv(), fetchFn));

    expect(values).toEqual([expect.objectContaining({ value: 0 })]);
    const stored = await readJson<KindlePositions>(env.STATE, KINDLE_STATE_KEYS.positions);
    expect(stored?.date).toBe("2026-08-04");
  });

  it("gives a book first seen mid-day a baseline, then credits its progress on the next sync", async () => {
    // Sync 1: only ASIN1 exists. Establishes the day's baseline.
    const sync1 = await kindleIntegration.fetchToday(makeContext(kindleEnv(), fetchForPositions({ ASIN1: 1000 })));
    expect(sync1).toEqual([expect.objectContaining({ value: 0 })]);

    // Sync 2: ASIN1 advances by 1800 (=> 1 page), and ASIN2 appears for the first time today. Only
    // ASIN1's advance should count — ASIN2 gets its baseline recorded now, contributing 0.
    const sync2 = await kindleIntegration.fetchToday(
      makeContext(kindleEnv(), fetchForPositions({ ASIN1: 2800, ASIN2: 500 })),
    );
    expect(sync2).toEqual([expect.objectContaining({ value: 1 })]);
    const afterSync2 = await readJson<KindlePositions>(env.STATE, KINDLE_STATE_KEYS.positions);
    expect(afterSync2?.positions).toEqual({ ASIN1: 1000, ASIN2: 500 });

    // Sync 3: both books advance further. ASIN2's delta must be measured from the position it had
    // at sync 2 (500), not from 0 and not from its current position.
    const sync3 = await kindleIntegration.fetchToday(
      makeContext(kindleEnv(), fetchForPositions({ ASIN1: 4600, ASIN2: 2300 })),
    );
    // ASIN1: (4600-1000)/1800 = 2. ASIN2: (2300-500)/1800 = 1. Total 3.
    expect(sync3).toEqual([expect.objectContaining({ value: 3 })]);
  });

  it("preserves a book's baseline across a sync where it's absent, so it isn't lost on reappearance", async () => {
    // Sync 1: ASIN1 exists, establishing its baseline.
    const sync1 = await kindleIntegration.fetchToday(makeContext(kindleEnv(), fetchForPositions({ ASIN1: 1000 })));
    expect(sync1).toEqual([expect.objectContaining({ value: 0 })]);

    // Sync 2: the library is empty (e.g. the book briefly failed to sync). Its baseline must survive.
    const sync2 = await kindleIntegration.fetchToday(makeContext(kindleEnv(), fetchForPositions({})));
    expect(sync2).toEqual([expect.objectContaining({ value: 0 })]);
    const afterSync2 = await readJson<KindlePositions>(env.STATE, KINDLE_STATE_KEYS.positions);
    expect(afterSync2?.positions).toEqual({ ASIN1: 1000 });

    // Sync 3: ASIN1 reappears with a higher position. The delta must be measured from its original
    // sync-1 baseline (1000), not from 0 as if it were newly seen this sync.
    const sync3 = await kindleIntegration.fetchToday(makeContext(kindleEnv(), fetchForPositions({ ASIN1: 4600 })));
    // (4600-1000)/1800 = 2.
    expect(sync3).toEqual([expect.objectContaining({ value: 2 })]);
  });
});

describe("kindleIntegration.fetchToday - pageNumberUrl preferred when usable", () => {
  beforeEach(async () => {
    await writeJson(env.STATE, KINDLE_STATE_KEYS.session, DUMMY_SESSION);
  });

  it("uses the real page map for the delta instead of the position estimate when it parses", async () => {
    await writeJson(env.STATE, KINDLE_STATE_KEYS.positions, {
      date: "2026-08-04",
      positions: { ASIN1: 1000 },
      estimated: false,
    } satisfies KindlePositions);

    const fetchFn = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith(DEVICE_TOKEN_URL)) return Response.json({ deviceSessionToken: "token" });
      if (url.startsWith(LIBRARY_URL)) return libraryResponse(["ASIN1"]);
      if (url.startsWith(START_READING_URL)) {
        return Response.json({
          lastPageReadData: { position: 4600 },
          pageNumberUrl: "https://cdn.example.com/pagemap/asin1",
        });
      }
      if (url === "https://cdn.example.com/pagemap/asin1") {
        // map[i] is the starting position of page i; 1000 -> page 1, 4600 -> page 4
        return Response.json([0, 1000, 2200, 3400, 4600, 5800]);
      }
      throw new Error(`unexpected fetch to ${url}`);
    }) as typeof fetch;

    const values = await kindleIntegration.fetchToday(makeContext(kindleEnv(), fetchFn));
    // page(4600) - page(1000) = 4 - 1 = 3, and this path is not an estimate.
    expect(values).toEqual([expect.objectContaining({ value: 3, estimated: false })]);
  });

  it("falls back to the position estimate when the pageNumberUrl map is unparseable", async () => {
    await writeJson(env.STATE, KINDLE_STATE_KEYS.positions, {
      date: "2026-08-04",
      positions: { ASIN1: 1000 },
      estimated: false,
    } satisfies KindlePositions);

    const fetchFn = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith(DEVICE_TOKEN_URL)) return Response.json({ deviceSessionToken: "token" });
      if (url.startsWith(LIBRARY_URL)) return libraryResponse(["ASIN1"]);
      if (url.startsWith(START_READING_URL)) {
        return Response.json({
          lastPageReadData: { position: 4600 },
          pageNumberUrl: "https://cdn.example.com/pagemap/bad",
        });
      }
      if (url === "https://cdn.example.com/pagemap/bad") return Response.json({ unexpectedShape: true });
      throw new Error(`unexpected fetch to ${url}`);
    }) as typeof fetch;

    const values = await kindleIntegration.fetchToday(makeContext(kindleEnv(), fetchFn));
    // (4600-1000)/1800 = 2, estimated.
    expect(values).toEqual([expect.objectContaining({ value: 2, estimated: true })]);
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
  it("stores a valid session with only { cookie } and returns 204", async () => {
    const response = await request("/kindle/session", {
      method: "PUT",
      headers: { ...bearer, "Content-Type": "application/json" },
      body: JSON.stringify({ cookie: "session-id=1-2-3; at-main=DUMMY" }),
    });

    expect(response.status).toBe(204);
    const stored = await readJson<KindleSession>(env.STATE, KINDLE_STATE_KEYS.session);
    expect(stored?.cookie).toBe("session-id=1-2-3; at-main=DUMMY");
    expect(stored).not.toHaveProperty("deviceSerialNumber");
    expect(stored).not.toHaveProperty("deviceType");
  });

  it("accepts and ignores a body that still carries the old deviceSerialNumber/deviceType fields", async () => {
    const response = await request("/kindle/session", {
      method: "PUT",
      headers: { ...bearer, "Content-Type": "application/json" },
      body: JSON.stringify({
        cookie: "session-id=1-2-3; at-main=DUMMY",
        deviceSerialNumber: "OLD-SERIAL",
        deviceType: "OLD-TYPE",
      }),
    });

    expect(response.status).toBe(204);
    const stored = await readJson<KindleSession>(env.STATE, KINDLE_STATE_KEYS.session);
    expect(stored?.cookie).toBe("session-id=1-2-3; at-main=DUMMY");
    expect(stored).not.toHaveProperty("deviceSerialNumber");
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

  it("returns 400 when cookie is missing or empty", async () => {
    const response = await request("/kindle/session", {
      method: "PUT",
      headers: { ...bearer, "Content-Type": "application/json" },
      body: JSON.stringify({ cookie: "" }),
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
