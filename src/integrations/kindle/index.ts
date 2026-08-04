import { readJson, writeJson } from "../../state";
import {
  AuthNeededError,
  type Env,
  type HabitValue,
  type Integration,
  type RouteContext,
  type SourceContext,
} from "../types";

const GET_DEVICE_TOKEN_URL = "https://read.amazon.com/service/web/register/getDeviceToken";
const LIBRARY_URL = "https://read.amazon.com/kindle-library/search";
const START_READING_URL = "https://read.amazon.com/service/mobile/reader/startReading";

// The Kindle Cloud Reader's own device identity, verified live against a real account. It is a
// constant for every account and every book — NOT a per-user value — so it is used as both the
// serialNumber and deviceType query params and the user never captures or supplies one.
const KINDLE_DEVICE_ID = "A2CTZ977SKFQZY";

// One printed page of prose per Whispersync position unit, as a last-resort estimate for books
// with no usable pageNumberUrl map (verified to be every book tested in practice — see README).
// Grounded in three verified books: Deep Work worked out to ~1500 positions/page, C Programming
// Language to ~2070, and the dense, small-print ESV Bible to ~5600. 1800 splits the difference for
// normal prose while accepting that dense reference books will over-count pages.
const DEFAULT_POSITIONS_PER_PAGE = 1800;

// This integration's own KV keys — not shared generic state.
export const KINDLE_STATE_KEYS = {
  session: "kindle:session",
  positions: "kindle:positions",
};

export interface KindleSession {
  cookie: string;
  updatedAt: string;
}

// The per-day baseline: each book's Whispersync position at the first time it was seen this local
// day. Storing raw positions (rather than derived pages) means a page-count delta is computed once
// from a single position delta, instead of compounding rounding error across two independent
// per-sync page derivations.
export interface KindlePositions {
  date: string;
  positions: Record<string, number>;
  estimated: boolean;
}

interface LibraryItem {
  asin: string;
  title: string;
  resourceType: string;
  originType: string;
}

interface LibraryResponse {
  itemsList: LibraryItem[];
  libraryType: string;
  sortType: string;
}

interface StartReadingResponse {
  // Verified null for a personal document, and also the shape for a book that's never been
  // opened (position -1). Both mean "nothing to track" for this book.
  lastPageReadData: { deviceName?: string; position: number; syncTime?: number } | null;
  pageNumberUrl?: string;
  metadataUrl?: string;
}

interface BookMetadata {
  startPosition: number;
  endPosition: number;
}

interface BookReading {
  position: number;
  pageNumberUrl?: string;
  metadataUrl?: string;
}

// Diagnostic, per-book progress — carried on the returned HabitValue's `diagnostics` field purely
// so GET /status is useful for a human to sanity-check; not used in any math here, and never sent
// to Habitify (see the comment above the POST body in habitify.ts).
interface KindleBookDiagnostic {
  asin: string;
  title: string;
  progress: number;
}

// Amazon's own JavaScript promotes the session-id cookie to this request header for the ADP-gated
// endpoints. Without it, getDeviceToken and startReading both return 403 "The given request is not
// an ADP session request" — verified against a live account. With it, both return 200.
function extractSessionId(cookie: string): string | null {
  const match = cookie.match(/(?:^|;\s*)session-id=([^;]+)/);
  return match ? match[1] : null;
}

function kindleHeaders(cookie: string, sessionId: string): HeadersInit {
  return {
    Cookie: cookie,
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    Accept: "application/json, text/plain, */*",
    Referer: "https://read.amazon.com/kindle-library",
    "x-amzn-sessionid": sessionId,
  };
}

async function fetchDeviceSessionToken(cookie: string, sessionId: string, fetchFn: typeof fetch): Promise<string> {
  const url = `${GET_DEVICE_TOKEN_URL}?serialNumber=${KINDLE_DEVICE_ID}&deviceType=${KINDLE_DEVICE_ID}`;
  const response = await fetchFn(url, { headers: kindleHeaders(cookie, sessionId) });
  if (response.status >= 400 && response.status < 500) {
    throw new AuthNeededError("Kindle getDeviceToken rejected the stored cookie; redo the /kindle/session capture");
  }
  if (!response.ok) {
    throw new Error(`Kindle getDeviceToken failed with status ${response.status}`);
  }
  const body = (await response.json()) as { deviceSessionToken?: unknown };
  if (typeof body.deviceSessionToken !== "string" || body.deviceSessionToken.length === 0) {
    throw new AuthNeededError(
      "Kindle getDeviceToken response had no deviceSessionToken; redo the /kindle/session capture",
    );
  }
  return body.deviceSessionToken;
}

async function fetchLibrary(cookie: string, sessionId: string, fetchFn: typeof fetch): Promise<LibraryItem[]> {
  const url = `${LIBRARY_URL}?query=&libraryType=BOOKS&sortType=recency&querySize=50`;
  const response = await fetchFn(url, { headers: kindleHeaders(cookie, sessionId) });
  if (response.status === 401 || response.status === 403) {
    // The cookie can be rejected here even after getDeviceToken succeeded (e.g. it's since
    // expired) — that's still a re-capture situation, not a generic error.
    throw new AuthNeededError("Kindle library search rejected the stored cookie; redo the /kindle/session capture");
  }
  if (!response.ok) {
    throw new Error(`Kindle library request failed with status ${response.status}`);
  }
  const body = (await response.json()) as LibraryResponse;
  if (!Array.isArray(body.itemsList)) {
    throw new Error("Kindle library returned an unexpected payload shape");
  }
  return body.itemsList;
}

async function fetchBookReading(
  asin: string,
  cookie: string,
  sessionId: string,
  deviceSessionToken: string,
  fetchFn: typeof fetch,
): Promise<BookReading | null> {
  const url = `${START_READING_URL}?asin=${encodeURIComponent(asin)}&clientVersion=20000100`;
  const response = await fetchFn(url, {
    headers: { ...kindleHeaders(cookie, sessionId), "x-adp-session-token": deviceSessionToken },
  });
  if (!response.ok) {
    throw new Error(`Kindle startReading failed for ${asin} with status ${response.status}`);
  }
  const body = (await response.json()) as StartReadingResponse;
  if (!body.lastPageReadData || body.lastPageReadData.position < 0) {
    return null;
  }
  return { position: body.lastPageReadData.position, pageNumberUrl: body.pageNumberUrl, metadataUrl: body.metadataUrl };
}

// pageNumberUrl's response schema was never observed live (absent on every book tested), so this
// stays defensive: accept a bare array of positions (its index is the page number) or an object
// wrapping such an array under "pageNumbers" or "positions", and treat anything else as unusable.
function parsePageNumberMap(raw: unknown): number[] | null {
  if (Array.isArray(raw) && raw.every((value) => typeof value === "number")) {
    return raw as number[];
  }
  if (raw && typeof raw === "object") {
    const candidate = raw as Record<string, unknown>;
    for (const key of ["pageNumbers", "positions"]) {
      const value = candidate[key];
      if (Array.isArray(value) && value.every((entry) => typeof entry === "number")) {
        return value as number[];
      }
    }
  }
  return null;
}

function pageFromPositionMap(map: number[], position: number): number | null {
  if (map.length === 0) return null;
  let page: number | null = null;
  for (let index = 0; index < map.length; index++) {
    if (map[index] <= position) {
      page = index;
    } else {
      break;
    }
  }
  return page;
}

// pageNumberUrl is a presigned URL fetched without cookies, and is opportunistic/best-effort — it
// was absent for every book verified live, so any failure here just falls back to the position
// estimate rather than failing the book.
async function fetchPageNumberMap(url: string, fetchFn: typeof fetch): Promise<number[] | null> {
  try {
    const response = await fetchFn(url);
    if (!response.ok) return null;
    return parsePageNumberMap(await response.json());
  } catch {
    return null;
  }
}

// metadataUrl returns JSONP — a bare function-call wrapper around the JSON body, e.g.
// `loadMetadata({...});` — rather than plain JSON. The wrapper's callback name isn't fixed, so it's
// stripped generically: a leading identifier plus "(", the body, then ")" with an optional ";",
// tolerating surrounding whitespace.
function parseMetadataResponse(text: string): BookMetadata | null {
  const trimmed = text.trim();
  const jsonpMatch = trimmed.match(/^[A-Za-z0-9_$]+\(([\s\S]*)\)\s*;?\s*$/);
  const jsonText = jsonpMatch ? jsonpMatch[1] : trimmed;
  try {
    const parsed = JSON.parse(jsonText) as Record<string, unknown>;
    if (typeof parsed.startPosition === "number" && typeof parsed.endPosition === "number") {
      return { startPosition: parsed.startPosition, endPosition: parsed.endPosition };
    }
  } catch {
    // fall through to null below
  }
  return null;
}

// metadataUrl is a presigned, cross-origin URL — fetched with no cookies and no extra headers.
async function fetchMetadata(url: string, fetchFn: typeof fetch): Promise<BookMetadata | null> {
  try {
    const response = await fetchFn(url);
    if (!response.ok) return null;
    return parseMetadataResponse(await response.text());
  } catch {
    return null;
  }
}

// Verified against three real books (~1.8%, ~42%, ~75%): this is the actual progress fraction,
// unlike Amazon's own percentageRead field, which is verified to return 0 for every book even when
// well underway. Returns null for a metadata span that isn't positive, so the caller can omit the
// book from diagnostics entirely rather than report a misleading 0%.
function progressFraction(position: number, metadata: BookMetadata): number | null {
  const span = metadata.endPosition - metadata.startPosition;
  if (span <= 0) return null;
  return Math.min(1, Math.max(0, (position - metadata.startPosition) / span));
}

// Converts a position delta since the book's baseline into a page-count delta. Prefers a real
// printed-page lookup (pageFromPositionMap applied to both the baseline and current position, so
// both ends go through the same map) when the book has a usable pageNumberUrl map; falls back to
// the position/positionsPerPage estimate otherwise. Never negative — a book re-read from an
// earlier position doesn't subtract from the day's total.
function pagesSinceBaseline(
  baselinePosition: number,
  currentPosition: number,
  pageNumberMap: number[] | null,
  positionsPerPage: number,
): { pages: number; estimated: boolean } {
  if (pageNumberMap) {
    const baselinePage = pageFromPositionMap(pageNumberMap, baselinePosition);
    const currentPage = pageFromPositionMap(pageNumberMap, currentPosition);
    if (baselinePage !== null && currentPage !== null) {
      return { pages: Math.max(0, currentPage - baselinePage), estimated: false };
    }
  }
  const positionDelta = currentPosition - baselinePosition;
  return { pages: Math.max(0, positionDelta / positionsPerPage), estimated: true };
}

async function handlePutSession(request: Request, context: RouteContext): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "malformed JSON body" }, { status: 400 });
  }
  const candidate = body as Record<string, unknown> | null;
  const cookie = candidate !== null && typeof candidate === "object" ? candidate.cookie : undefined;
  if (typeof cookie !== "string" || cookie.length === 0) {
    return Response.json({ error: "expected { cookie } as a non-empty string" }, { status: 400 });
  }
  // deviceSerialNumber/deviceType are accepted-and-ignored for backward compatibility with callers
  // still sending the pre-verification shape; they're no longer needed (see KINDLE_DEVICE_ID above).
  const session: KindleSession = { cookie, updatedAt: new Date().toISOString() };
  await writeJson(context.env.STATE, KINDLE_STATE_KEYS.session, session);
  return new Response(null, { status: 204 });
}

async function handleDeleteSession(_request: Request, context: RouteContext): Promise<Response> {
  await context.env.STATE.delete(KINDLE_STATE_KEYS.session);
  return new Response(null, { status: 204 });
}

export const kindleIntegration: Integration = {
  name: "kindle",

  enabled(env: Env): boolean {
    return Boolean(env.HABIT_ID_KINDLE);
  },

  async fetchToday(context: SourceContext): Promise<HabitValue[]> {
    const { env, today, fetchFn } = context;
    const session = await readJson<KindleSession>(env.STATE, KINDLE_STATE_KEYS.session);
    if (!session) {
      throw new AuthNeededError("Kindle session not captured; PUT /kindle/session");
    }
    const sessionId = extractSessionId(session.cookie);
    if (!sessionId) {
      throw new AuthNeededError(
        "Kindle cookie is missing session-id; redo the /kindle/session capture with the full Cookie header",
      );
    }

    const deviceSessionToken = await fetchDeviceSessionToken(session.cookie, sessionId, fetchFn);
    const library = await fetchLibrary(session.cookie, sessionId, fetchFn);
    // Guarded against a nonsensical override (0, negative, or unparseable) producing a bogus,
    // inflated page count.
    const positionsPerPage = Math.max(1, Number(env.KINDLE_POSITIONS_PER_PAGE) || DEFAULT_POSITIONS_PER_PAGE);

    const currentPositions: Record<string, number> = {};
    const pageNumberMaps: Record<string, number[] | null> = {};
    const bookDiagnostics: KindleBookDiagnostic[] = [];
    let errorCount = 0;
    let lastBookError: Error | undefined;

    for (const item of library) {
      try {
        const reading = await fetchBookReading(item.asin, session.cookie, sessionId, deviceSessionToken, fetchFn);
        // A personal document, or a book never opened (position -1): nothing to track, silently.
        if (reading === null) continue;

        currentPositions[item.asin] = reading.position;
        pageNumberMaps[item.asin] = reading.pageNumberUrl
          ? await fetchPageNumberMap(reading.pageNumberUrl, fetchFn)
          : null;

        if (reading.metadataUrl) {
          const metadata = await fetchMetadata(reading.metadataUrl, fetchFn);
          const progress = metadata ? progressFraction(reading.position, metadata) : null;
          // A null progress means the metadata span wasn't positive — omit the book rather than
          // report a misleading 0%.
          if (progress !== null) {
            bookDiagnostics.push({ asin: item.asin, title: item.title, progress });
          }
        }
      } catch (error) {
        // A book failing individually doesn't fail the whole source — only the aggregate below
        // (every book failing) does.
        errorCount++;
        lastBookError = error instanceof Error ? error : new Error(String(error));
      }
    }

    if (library.length > 0 && errorCount === library.length) {
      throw lastBookError ?? new Error("Every Kindle book failed to sync");
    }

    const previous = await readJson<KindlePositions>(env.STATE, KINDLE_STATE_KEYS.positions);
    // A fresh local day starts the baseline empty, which — via the "no baseline yet" branch below —
    // records every current position as its own baseline and contributes 0, exactly like a book
    // seen for the first time mid-day. This single loop covers both cases.
    const mergedBaseline: Record<string, number> = previous && previous.date === today ? { ...previous.positions } : {};

    let total = 0;
    let anyEstimated = false;
    for (const [asin, position] of Object.entries(currentPositions)) {
      const pageNumberMap = pageNumberMaps[asin] ?? null;
      const baselinePosition = mergedBaseline[asin];
      if (baselinePosition === undefined) {
        // First time seen this local day: record the baseline now so the NEXT sync measures
        // progress from here, rather than from 0 forever. Contributes 0 to this sync's total, but
        // still reports whether this book has a real page map available, for a truthful status.
        mergedBaseline[asin] = position;
        if (!pageNumberMap) anyEstimated = true;
        continue;
      }
      const { pages, estimated } = pagesSinceBaseline(baselinePosition, position, pageNumberMap, positionsPerPage);
      total += pages;
      if (estimated) anyEstimated = true;
    }

    // Written on every sync (even when total is 0) so a mid-day first sighting's baseline is
    // actually persisted, and books absent from this run (transient failure, or removed from the
    // library) keep their existing baseline via the spread above, so a book that reappears later is
    // still measured from its original baseline rather than treated as newly seen.
    await writeJson(env.STATE, KINDLE_STATE_KEYS.positions, {
      date: today,
      positions: mergedBaseline,
      estimated: anyEstimated,
    } satisfies KindlePositions);

    const habitValue: HabitValue = {
      habitId: env.HABIT_ID_KINDLE!,
      value: Math.round(total),
      unit: "pages",
      diagnostics: { estimated: anyEstimated, books: bookDiagnostics },
    };
    return [habitValue];
  },

  routes: [
    { method: "PUT", path: "/kindle/session", auth: "admin", handler: handlePutSession },
    { method: "DELETE", path: "/kindle/session", auth: "admin", handler: handleDeleteSession },
  ],
};
