import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import worker, { handleFetch } from "../../index";
import { readJson, writeJson } from "../../state";
import { AuthNeededError, type Env, type HabitValue, type SourceContext } from "../types";
import { KINDLE_STATE_KEYS, kindleIntegration, type KindlePositions, type KindleSession } from "./index";

// Kindle's own diagnostics shape, nested under HabitValue.diagnostics — never sent to Habitify,
// only surfaced via GET /status. Extracting it needs one narrow cast from `unknown` (diagnostics
// is intentionally a loosely-typed bag), not the whole-object cast this used to require.
interface KindleDiagnostics {
  estimated: boolean;
  books: {
    asin: string;
    title: string;
    progress: number;
    wordsRead: number;
    derivation: "print-pages" | "words-per-page" | "positions-fallback";
    pages: number;
  }[];
}

function diagnosticsOf(value: HabitValue): KindleDiagnostics | undefined {
  return value.diagnostics as KindleDiagnostics | undefined;
}

const DEVICE_TOKEN_URL = "https://read.amazon.com/service/web/register/getDeviceToken";
const LIBRARY_URL = "https://read.amazon.com/kindle-library/search";
const START_READING_URL = "https://read.amazon.com/service/mobile/reader/startReading";
const WORD_COUNT_URL = "https://read.amazon.com/renderer/wordCount";

// Real, verified measurements for asin B009ZUZ9FW, contentVersion e2e02ac4 (see the design doc):
// wordCount(0, 238526) = 43090, wordCount(0) [whole book, no endPosition] = 98651.
const WORDCOUNT_BOOK = { asin: "B009ZUZ9FW", contentVersion: "e2e02ac4", baseline: 0, position: 238526 };
const WORDS_IN_RANGE = 43090;
const WORDS_IN_WHOLE_BOOK = 98651;
const DUMMY_RENDERING_TOKEN = "dummy-rendering-token";

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

  it("sends x-amzn-sessionid on getDeviceToken, library search, and startReading, plus x-adp-session-token on startReading", async () => {
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

    const libraryCall = seenHeaders.find((call) => call.url.startsWith(LIBRARY_URL))!;
    expect(libraryCall.headers.get("x-amzn-sessionid")).toBe(DUMMY_SESSION_ID);

    const startReadingCall = seenHeaders.find((call) => call.url.startsWith(START_READING_URL))!;
    expect(startReadingCall.headers.get("x-amzn-sessionid")).toBe(DUMMY_SESSION_ID);
    expect(startReadingCall.headers.get("x-adp-session-token")).toBe("a".repeat(1481));
  });

  it("throws AuthNeededError when the library search returns 401", async () => {
    await writeJson(env.STATE, KINDLE_STATE_KEYS.session, DUMMY_SESSION);
    const fetchFn = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith(DEVICE_TOKEN_URL)) return Response.json({ deviceSessionToken: "token" });
      if (url.startsWith(LIBRARY_URL)) return new Response("unauthorized", { status: 401 });
      throw new Error(`unexpected fetch to ${url}`);
    }) as typeof fetch;
    await expect(kindleIntegration.fetchToday(makeContext(kindleEnv(), fetchFn))).rejects.toThrow(AuthNeededError);
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
    const books = diagnosticsOf(values[0])?.books;
    expect(books).toHaveLength(1);
    expect(books?.[0].progress).toBeCloseTo(0.018, 2);
  });

  it("computes the progress fraction correctly for the three verified books", async () => {
    const fetchFn = fetchForBooks([DEEP_WORK, C_PROGRAMMING_LANGUAGE, ESV_BIBLE]);
    const values = await kindleIntegration.fetchToday(makeContext(kindleEnv(), fetchFn));
    const books = diagnosticsOf(values[0])?.books ?? [];
    const byAsin = Object.fromEntries(books.map((book) => [book.asin, book.progress]));
    expect(byAsin[DEEP_WORK.asin]).toBeCloseTo(0.018, 2);
    expect(byAsin[C_PROGRAMMING_LANGUAGE.asin]).toBeCloseTo(0.42, 2);
    expect(byAsin[ESV_BIBLE.asin]).toBeCloseTo(0.75, 2);
  });

  it("omits a book from diagnostics when the metadata span is not positive", async () => {
    await writeJson(env.STATE, KINDLE_STATE_KEYS.session, DUMMY_SESSION);
    const fetchFn = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith(DEVICE_TOKEN_URL)) return Response.json({ deviceSessionToken: "token" });
      if (url.startsWith(LIBRARY_URL)) return libraryResponse(["ASIN1"]);
      if (url.startsWith(START_READING_URL)) {
        return Response.json({
          lastPageReadData: { position: 100 },
          metadataUrl: "https://cdn.example.com/metadata/degenerate",
        });
      }
      if (url === "https://cdn.example.com/metadata/degenerate") {
        // endPosition <= startPosition: a degenerate span that would otherwise report a
        // misleading 0% rather than being omitted.
        return new Response(jsonp({ startPosition: 100, endPosition: 100 }));
      }
      throw new Error(`unexpected fetch to ${url}`);
    }) as typeof fetch;

    const values = await kindleIntegration.fetchToday(makeContext(kindleEnv(), fetchFn));
    expect(diagnosticsOf(values[0])?.books).toEqual([]);
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
    expect(values).toEqual([expect.objectContaining({ value: 2 })]);
    expect(diagnosticsOf(values[0])?.estimated).toBe(true);
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
    expect(values).toEqual([expect.objectContaining({ value: 4 })]);
    expect(diagnosticsOf(values[0])?.estimated).toBe(true);
  });

  it("guards a negative KINDLE_POSITIONS_PER_PAGE override up to a minimum of 1", async () => {
    await writeJson(env.STATE, KINDLE_STATE_KEYS.positions, {
      date: "2026-08-04",
      positions: { ASIN1: 1000 },
      estimated: false,
    } satisfies KindlePositions);

    // "0" would fall back to the default via `Number(...) || DEFAULT`, since 0 is falsy — this
    // wouldn't exercise the guard. A negative value is truthy, so it survives that fallback and
    // must be caught by Math.max(1, ...) instead, or it would produce a nonsensical inflated
    // (or, for an exact divisor, negative) page count.
    const fetchFn = fetchForPositions({ ASIN1: 1000 + 3600 });
    const values = await kindleIntegration.fetchToday(
      makeContext(kindleEnv({ KINDLE_POSITIONS_PER_PAGE: "-100" }), fetchFn),
    );
    // Guarded to 1 position/page, so this is 3600 pages, not a negative or otherwise bogus number.
    expect(values).toEqual([expect.objectContaining({ value: 3600 })]);
  });

  it("sums fractional per-book estimates before rounding once at the end", async () => {
    await writeJson(env.STATE, KINDLE_STATE_KEYS.positions, {
      date: "2026-08-04",
      positions: { ASIN_A: 1000, ASIN_B: 2000 },
      estimated: false,
    } satisfies KindlePositions);

    // Each book advances by 900 positions — half of the default 1800/page — so each contributes
    // exactly 0.5 pages. Rounding each book independently (0.5 -> 1) would wrongly total 2; summing
    // the floats first and rounding once yields 1.
    const fetchFn = fetchForPositions({ ASIN_A: 1900, ASIN_B: 2900 });
    const values = await kindleIntegration.fetchToday(makeContext(kindleEnv(), fetchFn));
    expect(values).toEqual([expect.objectContaining({ value: 1 })]);
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

// Builds a fetchFn for a single word-count-eligible book: startReading returns contentVersion +
// karamelToken (in whichever shape `karamelToken` is given), and wordCount responses are driven
// off actual startPosition/endPosition query params rather than call order, matching how Amazon's
// range semantics actually work (see the comment on fetchWordCount).
function fetchForWordCountBook(options: {
  asin: string;
  contentVersion: string;
  position: number;
  karamelToken: unknown;
  wordCountByRange: Record<string, number | "error">;
  onWordCountCall?: (url: URL, headers: Headers) => void;
}) {
  const { asin, contentVersion, position, karamelToken, wordCountByRange, onWordCountCall } = options;
  const metadataUrl = `https://cdn.example.com/metadata/${asin}`;
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith(DEVICE_TOKEN_URL)) return Response.json({ deviceSessionToken: "token" });
    if (url.startsWith(LIBRARY_URL)) return libraryResponse([asin]);
    if (url.startsWith(START_READING_URL)) {
      return Response.json({ lastPageReadData: { position }, contentVersion, karamelToken, metadataUrl });
    }
    // Arbitrary but valid span, purely so a progress fraction exists and the book gets a
    // diagnostics entry — the pages math under test never reads this endpoint.
    if (url === metadataUrl) {
      return new Response(jsonp({ startPosition: 0, endPosition: 1000000 }));
    }
    if (url.startsWith(WORD_COUNT_URL)) {
      const parsed = new URL(url);
      onWordCountCall?.(parsed, new Headers(init?.headers));
      const start = parsed.searchParams.get("startPosition");
      const end = parsed.searchParams.get("endPosition");
      const rangeKey = `${start}-${end ?? ""}`;
      const result = wordCountByRange[rangeKey];
      if (result === "error") return new Response("server error", { status: 500 });
      if (result === undefined) throw new Error(`unexpected wordCount range ${rangeKey}`);
      return Response.json({ wordCount: result });
    }
    throw new Error(`unexpected fetch to ${url}`);
  }) as typeof fetch;
}

describe("kindleIntegration.fetchToday - wordCount request shape", () => {
  beforeEach(async () => {
    await writeJson(env.STATE, KINDLE_STATE_KEYS.session, DUMMY_SESSION);
    await writeJson(env.STATE, KINDLE_STATE_KEYS.positions, {
      date: "2026-08-04",
      positions: { [WORDCOUNT_BOOK.asin]: WORDCOUNT_BOOK.baseline },
      estimated: false,
    } satisfies KindlePositions);
  });

  it("calls wordCount with the correct URL params and both the sessionid and rendering-token headers", async () => {
    let seenUrl: URL | undefined;
    let seenHeaders: Headers | undefined;
    const fetchFn = fetchForWordCountBook({
      asin: WORDCOUNT_BOOK.asin,
      contentVersion: WORDCOUNT_BOOK.contentVersion,
      position: WORDCOUNT_BOOK.position,
      karamelToken: DUMMY_RENDERING_TOKEN,
      wordCountByRange: { [`0-${WORDCOUNT_BOOK.position}`]: WORDS_IN_RANGE },
      onWordCountCall: (url, headers) => {
        seenUrl = url;
        seenHeaders = headers;
      },
    });

    await kindleIntegration.fetchToday(makeContext(kindleEnv(), fetchFn));

    expect(seenUrl?.searchParams.get("asin")).toBe(WORDCOUNT_BOOK.asin);
    expect(seenUrl?.searchParams.get("revision")).toBe(WORDCOUNT_BOOK.contentVersion);
    expect(seenUrl?.searchParams.get("contentType")).toBe("FullBook");
    expect(seenUrl?.searchParams.get("startPosition")).toBe(String(WORDCOUNT_BOOK.baseline));
    expect(seenUrl?.searchParams.get("endPosition")).toBe(String(WORDCOUNT_BOOK.position));
    expect(seenHeaders?.get("x-amzn-sessionid")).toBe(DUMMY_SESSION_ID);
    expect(seenHeaders?.get("x-amz-rendering-token")).toBe(DUMMY_RENDERING_TOKEN);
  });

  it("accepts karamelToken as a bare string", async () => {
    const fetchFn = fetchForWordCountBook({
      asin: WORDCOUNT_BOOK.asin,
      contentVersion: WORDCOUNT_BOOK.contentVersion,
      position: WORDCOUNT_BOOK.position,
      karamelToken: DUMMY_RENDERING_TOKEN,
      wordCountByRange: { [`0-${WORDCOUNT_BOOK.position}`]: WORDS_IN_RANGE },
    });

    const values = await kindleIntegration.fetchToday(makeContext(kindleEnv(), fetchFn));
    const book = diagnosticsOf(values[0])?.books.find((entry) => entry.asin === WORDCOUNT_BOOK.asin);
    expect(book?.wordsRead).toBe(WORDS_IN_RANGE);
    expect(book?.derivation).toBe("words-per-page");
  });

  it("accepts karamelToken as an object with a .token field", async () => {
    const fetchFn = fetchForWordCountBook({
      asin: WORDCOUNT_BOOK.asin,
      contentVersion: WORDCOUNT_BOOK.contentVersion,
      position: WORDCOUNT_BOOK.position,
      karamelToken: { token: DUMMY_RENDERING_TOKEN },
      wordCountByRange: { [`0-${WORDCOUNT_BOOK.position}`]: WORDS_IN_RANGE },
    });

    const values = await kindleIntegration.fetchToday(makeContext(kindleEnv(), fetchFn));
    const book = diagnosticsOf(values[0])?.books.find((entry) => entry.asin === WORDCOUNT_BOOK.asin);
    expect(book?.wordsRead).toBe(WORDS_IN_RANGE);
    expect(book?.derivation).toBe("words-per-page");
  });
});

describe("kindleIntegration.fetchToday - words-per-page derivation", () => {
  beforeEach(async () => {
    await writeJson(env.STATE, KINDLE_STATE_KEYS.session, DUMMY_SESSION);
    await writeJson(env.STATE, KINDLE_STATE_KEYS.positions, {
      date: "2026-08-04",
      positions: { [WORDCOUNT_BOOK.asin]: WORDCOUNT_BOOK.baseline },
      estimated: false,
    } satisfies KindlePositions);
  });

  it("derives pages from words read at the default 250 words/page when no print length is configured", async () => {
    const fetchFn = fetchForWordCountBook({
      asin: WORDCOUNT_BOOK.asin,
      contentVersion: WORDCOUNT_BOOK.contentVersion,
      position: WORDCOUNT_BOOK.position,
      karamelToken: DUMMY_RENDERING_TOKEN,
      wordCountByRange: { [`0-${WORDCOUNT_BOOK.position}`]: WORDS_IN_RANGE },
    });

    const values = await kindleIntegration.fetchToday(makeContext(kindleEnv(), fetchFn));
    // 43090 / 250 = 172.36 -> rounds to 172.
    expect(values).toEqual([expect.objectContaining({ value: 172 })]);
    expect(diagnosticsOf(values[0])?.estimated).toBe(true);
  });

  it("honors an overridden KINDLE_WORDS_PER_PAGE", async () => {
    const fetchFn = fetchForWordCountBook({
      asin: WORDCOUNT_BOOK.asin,
      contentVersion: WORDCOUNT_BOOK.contentVersion,
      position: WORDCOUNT_BOOK.position,
      karamelToken: DUMMY_RENDERING_TOKEN,
      wordCountByRange: { [`0-${WORDCOUNT_BOOK.position}`]: WORDS_IN_RANGE },
    });

    const values = await kindleIntegration.fetchToday(
      makeContext(kindleEnv({ KINDLE_WORDS_PER_PAGE: "200" }), fetchFn),
    );
    // 43090 / 200 = 215.45 -> rounds to 215.
    expect(values).toEqual([expect.objectContaining({ value: 215 })]);
  });
});

describe("kindleIntegration.fetchToday - print-pages derivation", () => {
  beforeEach(async () => {
    await writeJson(env.STATE, KINDLE_STATE_KEYS.session, DUMMY_SESSION);
    await writeJson(env.STATE, KINDLE_STATE_KEYS.positions, {
      date: "2026-08-04",
      positions: { [WORDCOUNT_BOOK.asin]: WORDCOUNT_BOOK.baseline },
      estimated: false,
    } satisfies KindlePositions);
  });

  it("derives pages exactly from the configured print length and the real word counts", async () => {
    const fetchFn = fetchForWordCountBook({
      asin: WORDCOUNT_BOOK.asin,
      contentVersion: WORDCOUNT_BOOK.contentVersion,
      position: WORDCOUNT_BOOK.position,
      karamelToken: DUMMY_RENDERING_TOKEN,
      wordCountByRange: {
        [`0-${WORDCOUNT_BOOK.position}`]: WORDS_IN_RANGE,
        "0-": WORDS_IN_WHOLE_BOOK,
      },
    });

    const values = await kindleIntegration.fetchToday(
      makeContext(kindleEnv({ KINDLE_PAGE_COUNTS: `{"${WORDCOUNT_BOOK.asin}":272}` }), fetchFn),
    );
    // (43090/98651)*272 ≈ 118.8 -> rounds to 119.
    expect(values).toEqual([expect.objectContaining({ value: 119 })]);
    expect(diagnosticsOf(values[0])?.estimated).toBe(false);
    const book = diagnosticsOf(values[0])?.books.find((entry) => entry.asin === WORDCOUNT_BOOK.asin);
    expect(book?.derivation).toBe("print-pages");
    expect(book?.pages).toBeCloseTo(118.8, 1);
  });

  it.each([
    ["invalid JSON", "not json"],
    ["a JSON array", `[{"${WORDCOUNT_BOOK.asin}":272}]`],
    ["a zero page count", `{"${WORDCOUNT_BOOK.asin}":0}`],
    ["a negative page count", `{"${WORDCOUNT_BOOK.asin}":-5}`],
    ["a string page count", `{"${WORDCOUNT_BOOK.asin}":"272"}`],
  ])("falls through to words-per-page without throwing when KINDLE_PAGE_COUNTS is %s", async (_label, raw) => {
    const fetchFn = fetchForWordCountBook({
      asin: WORDCOUNT_BOOK.asin,
      contentVersion: WORDCOUNT_BOOK.contentVersion,
      position: WORDCOUNT_BOOK.position,
      karamelToken: DUMMY_RENDERING_TOKEN,
      wordCountByRange: { [`0-${WORDCOUNT_BOOK.position}`]: WORDS_IN_RANGE },
    });

    const values = await kindleIntegration.fetchToday(makeContext(kindleEnv({ KINDLE_PAGE_COUNTS: raw }), fetchFn));
    // Falls all the way through to the words-per-page default: 43090/250 = 172.36 -> 172.
    expect(values).toEqual([expect.objectContaining({ value: 172 })]);
    expect(diagnosticsOf(values[0])?.books[0]?.derivation).toBe("words-per-page");
  });

  it("fetches totalWordsInBook once and caches it in KV, keyed to contentVersion", async () => {
    let wholeBookCallCount = 0;
    const makeFetch = (position: number, contentVersion: string) =>
      fetchForWordCountBook({
        asin: WORDCOUNT_BOOK.asin,
        contentVersion,
        position,
        karamelToken: DUMMY_RENDERING_TOKEN,
        wordCountByRange: {
          [`${WORDCOUNT_BOOK.baseline}-${position}`]: 1000,
          "0-": WORDS_IN_WHOLE_BOOK,
        },
        onWordCountCall: (url) => {
          if (url.searchParams.get("startPosition") === "0" && !url.searchParams.has("endPosition")) {
            wholeBookCallCount++;
          }
        },
      });
    const pageCountsEnv = { KINDLE_PAGE_COUNTS: `{"${WORDCOUNT_BOOK.asin}":272}` };

    // Sync 1: contentVersion e2e02ac4, position advances from baseline 0 to 100000.
    await kindleIntegration.fetchToday(
      makeContext(kindleEnv(pageCountsEnv), makeFetch(100000, WORDCOUNT_BOOK.contentVersion)),
    );
    expect(wholeBookCallCount).toBe(1);

    // Sync 2: same contentVersion, position advances further — total words must come from cache.
    await kindleIntegration.fetchToday(
      makeContext(kindleEnv(pageCountsEnv), makeFetch(150000, WORDCOUNT_BOOK.contentVersion)),
    );
    expect(wholeBookCallCount).toBe(1);

    // Sync 3: a new contentVersion (Amazon reflowed the book) must invalidate the cache.
    await kindleIntegration.fetchToday(makeContext(kindleEnv(pageCountsEnv), makeFetch(200000, "different-revision")));
    expect(wholeBookCallCount).toBe(2);
  });
});

describe("kindleIntegration.fetchToday - wordCount failure and efficiency", () => {
  beforeEach(async () => {
    await writeJson(env.STATE, KINDLE_STATE_KEYS.session, DUMMY_SESSION);
  });

  it("falls back to the positions path for a book whose wordCount call fails, without affecting another book", async () => {
    await writeJson(env.STATE, KINDLE_STATE_KEYS.positions, {
      date: "2026-08-04",
      positions: { BROKEN: 1000, GOOD: 0 },
      estimated: false,
    } satisfies KindlePositions);

    const fetchFn = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith(DEVICE_TOKEN_URL)) return Response.json({ deviceSessionToken: "token" });
      if (url.startsWith(LIBRARY_URL)) return libraryResponse(["BROKEN", "GOOD"]);
      if (url.startsWith(START_READING_URL)) {
        const asin = new URL(url).searchParams.get("asin")!;
        if (asin === "BROKEN") {
          // delta 2800 (1000 -> 3800), contentVersion present but wordCount itself will fail.
          return Response.json({
            lastPageReadData: { position: 3800 },
            contentVersion: "rev-broken",
            karamelToken: DUMMY_RENDERING_TOKEN,
            metadataUrl: "https://cdn.example.com/metadata/BROKEN",
          });
        }
        // delta 43090 words worth of positions (0 -> 238526), succeeds via words-per-page.
        return Response.json({
          lastPageReadData: { position: WORDCOUNT_BOOK.position },
          contentVersion: WORDCOUNT_BOOK.contentVersion,
          karamelToken: DUMMY_RENDERING_TOKEN,
          metadataUrl: "https://cdn.example.com/metadata/GOOD",
        });
      }
      // Arbitrary but valid span, purely so a progress fraction exists and each book gets a
      // diagnostics entry — the pages math under test never reads this endpoint.
      if (url === "https://cdn.example.com/metadata/BROKEN" || url === "https://cdn.example.com/metadata/GOOD") {
        return new Response(jsonp({ startPosition: 0, endPosition: 1000000 }));
      }
      if (url.startsWith(WORD_COUNT_URL)) {
        const parsed = new URL(url);
        const revision = parsed.searchParams.get("revision");
        if (revision === "rev-broken") return new Response("server error", { status: 500 });
        if (revision === WORDCOUNT_BOOK.contentVersion) return Response.json({ wordCount: WORDS_IN_RANGE });
        throw new Error(`unexpected wordCount revision ${revision}`);
      }
      throw new Error(`unexpected fetch to ${url}`);
    }) as typeof fetch;

    const values = await kindleIntegration.fetchToday(makeContext(kindleEnv(), fetchFn));
    const books = diagnosticsOf(values[0])?.books ?? [];
    const broken = books.find((entry) => entry.asin === "BROKEN");
    const good = books.find((entry) => entry.asin === "GOOD");
    // BROKEN falls back to (3800-1000)/1800 = 1.555...; GOOD uses 43090/250 = 172.36.
    // Summed before rounding: 1.555... + 172.36 = 173.9155... -> rounds to 174.
    expect(broken?.derivation).toBe("positions-fallback");
    expect(good?.derivation).toBe("words-per-page");
    expect(values).toEqual([expect.objectContaining({ value: 174 })]);
  });

  it("makes no wordCount call at all for a book whose position did not advance past its baseline", async () => {
    await writeJson(env.STATE, KINDLE_STATE_KEYS.positions, {
      date: "2026-08-04",
      positions: { [WORDCOUNT_BOOK.asin]: WORDCOUNT_BOOK.position },
      estimated: false,
    } satisfies KindlePositions);

    const fetchFn = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith(DEVICE_TOKEN_URL)) return Response.json({ deviceSessionToken: "token" });
      if (url.startsWith(LIBRARY_URL)) return libraryResponse([WORDCOUNT_BOOK.asin]);
      if (url.startsWith(START_READING_URL)) {
        // Position unchanged from the stored baseline: delta is 0.
        return Response.json({
          lastPageReadData: { position: WORDCOUNT_BOOK.position },
          contentVersion: WORDCOUNT_BOOK.contentVersion,
          karamelToken: DUMMY_RENDERING_TOKEN,
        });
      }
      if (url.startsWith(WORD_COUNT_URL)) {
        throw new Error("wordCount must not be called for a book that has not advanced past its baseline");
      }
      throw new Error(`unexpected fetch to ${url}`);
    }) as typeof fetch;

    const values = await kindleIntegration.fetchToday(makeContext(kindleEnv(), fetchFn));
    expect(values).toEqual([expect.objectContaining({ value: 0 })]);
  });

  it("sums multiple books' fractional word-count-derived pages before the single final rounding", async () => {
    await writeJson(env.STATE, KINDLE_STATE_KEYS.positions, {
      date: "2026-08-04",
      positions: { BOOK_A: 0, BOOK_B: 0 },
      estimated: false,
    } satisfies KindlePositions);

    // Each book reads 125 words at the default 250 words/page => exactly 0.5 pages each. Rounding
    // each independently (0.5 -> 1) would wrongly total 2; summing first and rounding once yields 1.
    const fetchFn = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith(DEVICE_TOKEN_URL)) return Response.json({ deviceSessionToken: "token" });
      if (url.startsWith(LIBRARY_URL)) return libraryResponse(["BOOK_A", "BOOK_B"]);
      if (url.startsWith(START_READING_URL)) {
        const asin = new URL(url).searchParams.get("asin")!;
        return Response.json({
          lastPageReadData: { position: 500 },
          contentVersion: `rev-${asin}`,
          karamelToken: DUMMY_RENDERING_TOKEN,
        });
      }
      if (url.startsWith(WORD_COUNT_URL)) return Response.json({ wordCount: 125 });
      throw new Error(`unexpected fetch to ${url}`);
    }) as typeof fetch;

    const values = await kindleIntegration.fetchToday(makeContext(kindleEnv(), fetchFn));
    expect(values).toEqual([expect.objectContaining({ value: 1 })]);
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
