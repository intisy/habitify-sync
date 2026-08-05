import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import worker, { handleFetch } from "../../index";
import { readJson, writeJson } from "../../state";
import { SettingsResolver } from "../../settings";
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
    derivation: "print-pages" | "words-per-page" | "positions-fallback" | "not-measured";
    pages: number;
    pageCountSource: "override" | "lookup" | "none";
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

function makeSettings(testEnv: Env): SettingsResolver {
  return new SettingsResolver(testEnv, testEnv.STATE, "kindle", kindleIntegration.settings);
}

function makeContext(testEnv: Env, fetchFn: typeof fetch, today = "2026-08-04"): SourceContext {
  return { env: testEnv, timeZone: "Europe/Berlin", today, now: new Date(`${today}T10:00:00Z`), fetchFn, settings: makeSettings(testEnv) };
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
  it("is false without HABIT_ID_KINDLE and true with it", async () => {
    expect(await makeSettings({ ...env, HABIT_ID_KINDLE: undefined }).isEnabled()).toBe(false);
    expect(await makeSettings({ ...env, HABIT_ID_KINDLE: "" }).isEnabled()).toBe(false);
    expect(await makeSettings(kindleEnv()).isEnabled()).toBe(true);
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
    // Neither book contributed any pages (both are first sightings), so nothing was estimated —
    // "not-measured" is not "positions-fallback", and a book that was never measured must not
    // poison the estimated flag (see the "non-contributing books" describe block below).
    expect(stored).toEqual({ date: "2026-08-04", positions: { ASIN1: 1000, ASIN2: 2000 }, estimated: false });
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

// The public, unauthenticated product page the dynamic page-count lookup fetches — verified live
// (see the design doc) to carry the printed page count in its detail bullets, with no auth needed.
const PRODUCT_PAGE_URL = "https://www.amazon.com/dp";

// Wraps fetchForWordCountBook's book-reading/wordCount handling with a product-page handler, so
// tests can drive the dynamic page-count lookup independently of the book's other endpoints.
function fetchWithProductPage(options: {
  wordCountByRange: Record<string, number | "error">;
  position?: number;
  contentVersion?: string;
  productPageResponse: (asin: string) => Response;
  onProductPageCall?: (url: URL, headers: Headers) => void;
}) {
  const base = fetchForWordCountBook({
    asin: WORDCOUNT_BOOK.asin,
    contentVersion: options.contentVersion ?? WORDCOUNT_BOOK.contentVersion,
    position: options.position ?? WORDCOUNT_BOOK.position,
    karamelToken: DUMMY_RENDERING_TOKEN,
    wordCountByRange: options.wordCountByRange,
  });
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith(PRODUCT_PAGE_URL)) {
      const parsed = new URL(url);
      const asin = parsed.pathname.split("/").pop()!;
      options.onProductPageCall?.(parsed, new Headers(init?.headers));
      return options.productPageResponse(asin);
    }
    return base(input, init);
  }) as typeof fetch;
}

// A fragment of real, verified Amazon product-page HTML (see the design doc), trimmed to just the
// detail-bullet text the parser looks for. The English fragment mirrors the exact markup observed
// live: `Print length: 279 pages" href="javascript:void(0)" ...`.
function englishPrintLengthHtml(pages: number | string): string {
  return `<span>Print length: ${pages} pages" href="javascript:void(0)" role="button" class="a-popover-trigger a-</span>`;
}

function germanPrintLengthHtml(pages: number | string): string {
  return `<span>Seitenzahl der Print-Ausgabe: ${pages} Seiten</span>`;
}

function numberOfPagesJsonHtml(pages: number | string): string {
  return `<script type="application/ld+json">{"@type":"Book","numberOfPages":"${pages}"}</script>`;
}

describe("kindleIntegration.fetchToday - dynamic page-count lookup", () => {
  beforeEach(async () => {
    await writeJson(env.STATE, KINDLE_STATE_KEYS.session, DUMMY_SESSION);
    await writeJson(env.STATE, KINDLE_STATE_KEYS.positions, {
      date: "2026-08-04",
      positions: { [WORDCOUNT_BOOK.asin]: WORDCOUNT_BOOK.baseline },
      estimated: false,
    } satisfies KindlePositions);
  });

  it("requests the product page at the correct URL with a browser User-Agent and sends no Cookie header", async () => {
    let seenUrl: URL | undefined;
    let seenHeaders: Headers | undefined;
    const fetchFn = fetchWithProductPage({
      wordCountByRange: { [`0-${WORDCOUNT_BOOK.position}`]: WORDS_IN_RANGE },
      productPageResponse: () => new Response(englishPrintLengthHtml(279)),
      onProductPageCall: (url, headers) => {
        seenUrl = url;
        seenHeaders = headers;
      },
    });

    await kindleIntegration.fetchToday(makeContext(kindleEnv(), fetchFn));

    expect(seenUrl?.toString()).toBe(`${PRODUCT_PAGE_URL}/${WORDCOUNT_BOOK.asin}`);
    expect(seenHeaders?.get("User-Agent")).toMatch(/Mozilla/);
    // The product page is public; sending the captured Amazon session cookie here would leak it
    // to a request that doesn't need it and need not ever see it.
    expect(seenHeaders?.has("Cookie")).toBe(false);
  });

  it.each([
    ["the English 'Print length' label", englishPrintLengthHtml(279), 279],
    ["the German 'Seitenzahl der Print-Ausgabe' label", germanPrintLengthHtml(305), 305],
    ["a 'numberOfPages' JSON field", numberOfPagesJsonHtml(272), 272],
    ["a thousands separator", englishPrintLengthHtml("1,024"), 1024],
  ])("discovers the page count from %s", async (_label, html, expectedPageCount) => {
    const fetchFn = fetchWithProductPage({
      wordCountByRange: {
        [`0-${WORDCOUNT_BOOK.position}`]: WORDS_IN_RANGE,
        "0-": WORDS_IN_WHOLE_BOOK,
      },
      productPageResponse: () => new Response(html),
    });

    const values = await kindleIntegration.fetchToday(makeContext(kindleEnv(), fetchFn));
    const book = diagnosticsOf(values[0])?.books.find((entry) => entry.asin === WORDCOUNT_BOOK.asin);
    expect(book?.derivation).toBe("print-pages");
    expect(book?.pageCountSource).toBe("lookup");
    expect(book?.pages).toBeCloseTo((WORDS_IN_RANGE / WORDS_IN_WHOLE_BOOK) * expectedPageCount, 1);
  });

  it.each([
    ["a non-numeric value", englishPrintLengthHtml("N/A")],
    ["a zero page count", englishPrintLengthHtml(0)],
    ["an absurdly large page count", englishPrintLengthHtml(999999999)],
    ["no recognizable page-count text at all", "<html><body>nothing relevant here</body></html>"],
  ])("falls back to words-per-page and reports source 'none' when the product page has %s", async (_label, html) => {
    const fetchFn = fetchWithProductPage({
      wordCountByRange: { [`0-${WORDCOUNT_BOOK.position}`]: WORDS_IN_RANGE },
      productPageResponse: () => new Response(html),
    });

    const values = await kindleIntegration.fetchToday(makeContext(kindleEnv(), fetchFn));
    const book = diagnosticsOf(values[0])?.books.find((entry) => entry.asin === WORDCOUNT_BOOK.asin);
    expect(book?.derivation).toBe("words-per-page");
    expect(book?.pageCountSource).toBe("none");
    expect(diagnosticsOf(values[0])?.estimated).toBe(true);
  });

  it("derives pages exactly end-to-end from real verified numbers: B009ZUZ9FW, 43090/98651 words, 279 discovered pages", async () => {
    const fetchFn = fetchWithProductPage({
      wordCountByRange: {
        [`0-${WORDCOUNT_BOOK.position}`]: WORDS_IN_RANGE,
        "0-": WORDS_IN_WHOLE_BOOK,
      },
      productPageResponse: () => new Response(englishPrintLengthHtml(279)),
    });

    const values = await kindleIntegration.fetchToday(makeContext(kindleEnv(), fetchFn));
    const book = diagnosticsOf(values[0])?.books.find((entry) => entry.asin === WORDCOUNT_BOOK.asin);
    // (43090/98651)*279 ≈ 121.87.
    expect(book?.pages).toBeCloseTo(121.9, 1);
    expect(book?.derivation).toBe("print-pages");
    expect(book?.pageCountSource).toBe("lookup");
    expect(diagnosticsOf(values[0])?.estimated).toBe(false);
  });

  it("prefers the KINDLE_PAGE_COUNTS override over the dynamic lookup, and makes no product-page request", async () => {
    let productPageCallCount = 0;
    const fetchFn = fetchWithProductPage({
      wordCountByRange: {
        [`0-${WORDCOUNT_BOOK.position}`]: WORDS_IN_RANGE,
        "0-": WORDS_IN_WHOLE_BOOK,
      },
      productPageResponse: () => {
        throw new Error("the override must make the dynamic lookup unnecessary");
      },
      onProductPageCall: () => {
        productPageCallCount++;
      },
    });

    const values = await kindleIntegration.fetchToday(
      makeContext(kindleEnv({ KINDLE_PAGE_COUNTS: `{"${WORDCOUNT_BOOK.asin}":272}` }), fetchFn),
    );

    expect(productPageCallCount).toBe(0);
    const book = diagnosticsOf(values[0])?.books.find((entry) => entry.asin === WORDCOUNT_BOOK.asin);
    expect(book?.derivation).toBe("print-pages");
    expect(book?.pageCountSource).toBe("override");
    // (43090/98651)*272 ≈ 118.8, confirming the override's value (not the lookup's 279) was used.
    expect(book?.pages).toBeCloseTo(118.8, 1);
  });

  it("caches a discovered page count in KV and does not refetch the product page on a later sync", async () => {
    // The day's baseline (set by the describe's beforeEach) stays fixed at 0 for the whole day —
    // only a book's FIRST sighting of the day ever records a baseline (see the "page delta math
    // and baseline lifecycle" describe block above). So every sync this same day measures
    // wordsRead over [0, currentPosition], a growing range, not [previousPosition, currentPosition].
    let productPageCallCount = 0;
    const makeFetch = (position: number, wordsInRange: number) =>
      fetchWithProductPage({
        wordCountByRange: {
          [`0-${position}`]: wordsInRange,
          "0-": WORDS_IN_WHOLE_BOOK,
        },
        position,
        productPageResponse: () => new Response(englishPrintLengthHtml(279)),
        onProductPageCall: () => {
          productPageCallCount++;
        },
      });

    // Sync 1: position 100000, discovers and caches the page count.
    await kindleIntegration.fetchToday(makeContext(kindleEnv(), makeFetch(100000, 1000)));
    expect(productPageCallCount).toBe(1);

    // Sync 2: position advances further, same day and same baseline. The cached page count must
    // be reused, with no second product-page request.
    await kindleIntegration.fetchToday(makeContext(kindleEnv(), makeFetch(150000, 1500)));
    expect(productPageCallCount).toBe(1);
  });

  it("caches a failed lookup negatively and does not retry the product page on a later sync the same day", async () => {
    let productPageCallCount = 0;
    const makeFetch = (position: number) =>
      fetchWithProductPage({
        wordCountByRange: { [`0-${position}`]: 1000 },
        position,
        productPageResponse: () => {
          productPageCallCount++;
          return new Response("service unavailable", { status: 503 });
        },
      });

    // Sync 1: the product page fails; the book still contributes via words-per-page.
    const sync1 = await kindleIntegration.fetchToday(makeContext(kindleEnv(), makeFetch(100000)));
    const book1 = diagnosticsOf(sync1[0])?.books.find((entry) => entry.asin === WORDCOUNT_BOOK.asin);
    expect(book1?.derivation).toBe("words-per-page");
    expect(book1?.pageCountSource).toBe("none");
    expect(productPageCallCount).toBe(1);

    // Sync 2: position advances further, same day/baseline. The negative cache marker must
    // suppress a second product-page request entirely.
    const sync2 = await kindleIntegration.fetchToday(makeContext(kindleEnv(), makeFetch(150000)));
    const book2 = diagnosticsOf(sync2[0])?.books.find((entry) => entry.asin === WORDCOUNT_BOOK.asin);
    expect(book2?.derivation).toBe("words-per-page");
    expect(productPageCallCount).toBe(1);
  });

  it("degrades only the affected book to words-per-page on a 503, while another book (using the override) still counts", async () => {
    const overriddenAsin = "ASINOVERRIDDEN";
    const wordCountBookMetadataUrl = `https://cdn.example.com/metadata/${WORDCOUNT_BOOK.asin}`;
    const overriddenMetadataUrl = `https://cdn.example.com/metadata/${overriddenAsin}`;
    const fetchFn = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith(DEVICE_TOKEN_URL)) return Response.json({ deviceSessionToken: "token" });
      if (url.startsWith(LIBRARY_URL)) return libraryResponse([WORDCOUNT_BOOK.asin, overriddenAsin]);
      if (url.startsWith(START_READING_URL)) {
        const asin = new URL(url).searchParams.get("asin")!;
        if (asin === overriddenAsin) {
          return Response.json({
            lastPageReadData: { position: 5000 },
            contentVersion: "rev-overridden",
            karamelToken: DUMMY_RENDERING_TOKEN,
            metadataUrl: overriddenMetadataUrl,
          });
        }
        return Response.json({
          lastPageReadData: { position: WORDCOUNT_BOOK.position },
          contentVersion: WORDCOUNT_BOOK.contentVersion,
          karamelToken: DUMMY_RENDERING_TOKEN,
          metadataUrl: wordCountBookMetadataUrl,
        });
      }
      // Arbitrary but valid span, purely so a progress fraction exists and each book gets a
      // diagnostics entry — the page-count math under test never reads this endpoint.
      if (url === wordCountBookMetadataUrl || url === overriddenMetadataUrl) {
        return new Response(jsonp({ startPosition: 0, endPosition: 1000000 }));
      }
      if (url.startsWith(PRODUCT_PAGE_URL)) return new Response("service unavailable", { status: 503 });
      if (url.startsWith(WORD_COUNT_URL)) {
        const parsed = new URL(url);
        const revision = parsed.searchParams.get("revision");
        if (revision === "rev-overridden") return Response.json({ wordCount: 500 });
        if (revision === WORDCOUNT_BOOK.contentVersion) return Response.json({ wordCount: WORDS_IN_RANGE });
        throw new Error(`unexpected wordCount revision ${revision}`);
      }
      throw new Error(`unexpected fetch to ${url}`);
    }) as typeof fetch;

    await writeJson(env.STATE, KINDLE_STATE_KEYS.positions, {
      date: "2026-08-04",
      positions: { [WORDCOUNT_BOOK.asin]: WORDCOUNT_BOOK.baseline, [overriddenAsin]: 0 },
      estimated: false,
    } satisfies KindlePositions);

    const values = await kindleIntegration.fetchToday(
      makeContext(kindleEnv({ KINDLE_PAGE_COUNTS: `{"${overriddenAsin}":250}` }), fetchFn),
    );
    const books = diagnosticsOf(values[0])?.books ?? [];
    const wordCountBook = books.find((entry) => entry.asin === WORDCOUNT_BOOK.asin);
    const overriddenBook = books.find((entry) => entry.asin === overriddenAsin);
    expect(wordCountBook?.derivation).toBe("words-per-page");
    expect(wordCountBook?.pageCountSource).toBe("none");
    expect(overriddenBook?.derivation).toBe("print-pages");
    expect(overriddenBook?.pageCountSource).toBe("override");
  });

  it("makes no product-page request for a book that contributed nothing this sync", async () => {
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
        // Position unchanged from the stored baseline: delta is 0, so nothing should be looked up.
        return Response.json({
          lastPageReadData: { position: WORDCOUNT_BOOK.position },
          contentVersion: WORDCOUNT_BOOK.contentVersion,
          karamelToken: DUMMY_RENDERING_TOKEN,
        });
      }
      if (url.startsWith(PRODUCT_PAGE_URL)) {
        throw new Error("the product page must not be requested for a book that did not advance");
      }
      if (url.startsWith(WORD_COUNT_URL)) {
        throw new Error("wordCount must not be called for a book that has not advanced past its baseline");
      }
      throw new Error(`unexpected fetch to ${url}`);
    }) as typeof fetch;

    const values = await kindleIntegration.fetchToday(makeContext(kindleEnv(), fetchFn));
    expect(values).toEqual([expect.objectContaining({ value: 0 })]);
  });
});

describe("kindleIntegration.fetchToday - non-contributing books are 'not-measured', never poisoning estimated", () => {
  beforeEach(async () => {
    await writeJson(env.STATE, KINDLE_STATE_KEYS.session, DUMMY_SESSION);
  });

  it("labels every book 'not-measured' on the first sync of a day, with estimated false and no wordCount calls", async () => {
    const asins = ["ASIN_A", "ASIN_B"];
    const fetchFn = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith(DEVICE_TOKEN_URL)) return Response.json({ deviceSessionToken: "token" });
      if (url.startsWith(LIBRARY_URL)) return libraryResponse(asins);
      if (url.startsWith(START_READING_URL)) {
        const asin = new URL(url).searchParams.get("asin")!;
        return Response.json({
          lastPageReadData: { position: 1000 },
          metadataUrl: `https://cdn.example.com/metadata/${asin}`,
        });
      }
      const metadataMatch = url.match(/metadata\/(.+)$/);
      if (metadataMatch) return new Response(jsonp({ startPosition: 0, endPosition: 100000 }));
      if (url.startsWith(WORD_COUNT_URL)) {
        throw new Error("wordCount must not be called for a book on its first sighting today");
      }
      throw new Error(`unexpected fetch to ${url}`);
    }) as typeof fetch;

    const values = await kindleIntegration.fetchToday(makeContext(kindleEnv(), fetchFn));
    expect(values).toEqual([expect.objectContaining({ value: 0 })]);
    const diagnostics = diagnosticsOf(values[0]);
    expect(diagnostics?.estimated).toBe(false);
    expect(diagnostics?.books).toHaveLength(2);
    for (const book of diagnostics?.books ?? []) {
      expect(book.derivation).toBe("not-measured");
      expect(book.wordsRead).toBe(0);
      expect(book.pages).toBe(0);
    }
  });

  it("a stalled book reports 'not-measured' without making estimated true when another book used print-pages", async () => {
    await writeJson(env.STATE, KINDLE_STATE_KEYS.positions, {
      date: "2026-08-04",
      positions: { [WORDCOUNT_BOOK.asin]: WORDCOUNT_BOOK.baseline, STALLED: 5000 },
      estimated: false,
    } satisfies KindlePositions);

    const advancingMetadataUrl = `https://cdn.example.com/metadata/${WORDCOUNT_BOOK.asin}`;
    const stalledMetadataUrl = "https://cdn.example.com/metadata/STALLED";

    const fetchFn = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith(DEVICE_TOKEN_URL)) return Response.json({ deviceSessionToken: "token" });
      if (url.startsWith(LIBRARY_URL)) return libraryResponse([WORDCOUNT_BOOK.asin, "STALLED"]);
      if (url.startsWith(START_READING_URL)) {
        const asin = new URL(url).searchParams.get("asin")!;
        if (asin === "STALLED") {
          // Position unchanged from its stored baseline (5000): contributes nothing.
          return Response.json({ lastPageReadData: { position: 5000 }, metadataUrl: stalledMetadataUrl });
        }
        return Response.json({
          lastPageReadData: { position: WORDCOUNT_BOOK.position },
          contentVersion: WORDCOUNT_BOOK.contentVersion,
          karamelToken: DUMMY_RENDERING_TOKEN,
          metadataUrl: advancingMetadataUrl,
        });
      }
      if (url === stalledMetadataUrl || url === advancingMetadataUrl) {
        return new Response(jsonp({ startPosition: 0, endPosition: 1000000 }));
      }
      if (url.startsWith(WORD_COUNT_URL)) {
        // STALLED must never reach here at all — only the advancing book's asin is expected.
        const parsed = new URL(url);
        expect(parsed.searchParams.get("asin")).toBe(WORDCOUNT_BOOK.asin);
        const start = parsed.searchParams.get("startPosition");
        const end = parsed.searchParams.get("endPosition");
        if (start === "0" && end === String(WORDCOUNT_BOOK.position)) return Response.json({ wordCount: WORDS_IN_RANGE });
        if (start === "0" && end === null) return Response.json({ wordCount: WORDS_IN_WHOLE_BOOK });
        throw new Error(`unexpected wordCount range ${start}-${end}`);
      }
      throw new Error(`unexpected fetch to ${url}`);
    }) as typeof fetch;

    const values = await kindleIntegration.fetchToday(
      makeContext(kindleEnv({ KINDLE_PAGE_COUNTS: `{"${WORDCOUNT_BOOK.asin}":272}` }), fetchFn),
    );
    const diagnostics = diagnosticsOf(values[0]);
    // The stalled book's non-measurement must not force estimated true when the only contributing
    // book used the exact print-pages tier.
    expect(diagnostics?.estimated).toBe(false);
    const advancing = diagnostics?.books.find((entry) => entry.asin === WORDCOUNT_BOOK.asin);
    const stalled = diagnostics?.books.find((entry) => entry.asin === "STALLED");
    expect(advancing?.derivation).toBe("print-pages");
    expect(stalled?.derivation).toBe("not-measured");
    expect(stalled?.wordsRead).toBe(0);
    expect(stalled?.pages).toBe(0);
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
