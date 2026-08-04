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

// Roughly one printed page of prose per Whispersync position unit; used only when neither a
// pageNumberUrl map nor book metadata is available. Overridable via the KINDLE_POSITIONS_PER_PAGE
// var since this constant is itself an estimate, not a documented Amazon value.
const DEFAULT_POSITIONS_PER_PAGE = 1400;

// This integration's own KV keys — not shared generic state.
export const KINDLE_STATE_KEYS = {
  session: "kindle:session",
  positions: "kindle:positions",
};

export interface KindleSession {
  cookie: string;
  deviceSerialNumber: string;
  deviceType: string;
  updatedAt: string;
}

export interface KindlePositions {
  date: string;
  pages: Record<string, number>;
  estimated: boolean;
}

interface LibraryItem {
  asin: string;
  title: string;
  percentageRead: number;
  resourceType: string;
  originType: string;
}

interface LibraryResponse {
  itemsList: LibraryItem[];
  libraryType: string;
  sortType: string;
}

interface StartReadingResponse {
  lastPageReadData?: { position: number; syncTime?: number; deviceName?: string };
  pageNumberUrl?: string;
  metadataUrl?: string;
  srl?: unknown;
  formatVersion?: unknown;
  contentVersion?: unknown;
}

function kindleHeaders(cookie: string): HeadersInit {
  return {
    Cookie: cookie,
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    Accept: "application/json",
    Referer: "https://read.amazon.com/kindle-library",
  };
}

// The field carrying the device session token is not confirmed by either reverse-engineering
// source used to write this integration; handle the documented name plus two plausible
// fallbacks, and refuse to guess further than that.
async function fetchDeviceSessionToken(session: KindleSession, fetchFn: typeof fetch): Promise<string> {
  const url = `${GET_DEVICE_TOKEN_URL}?serialNumber=${encodeURIComponent(session.deviceSerialNumber)}&deviceType=${encodeURIComponent(session.deviceType)}`;
  const response = await fetchFn(url, { headers: kindleHeaders(session.cookie) });
  if (response.status >= 400 && response.status < 500) {
    throw new AuthNeededError("Kindle device token capture looks stale; redo the /kindle/session capture");
  }
  if (!response.ok) {
    throw new Error(`Kindle getDeviceToken failed with status ${response.status}`);
  }
  const body = (await response.json()) as Record<string, unknown>;
  const token = body.deviceSessionToken ?? body.deviceToken ?? body.token;
  if (typeof token !== "string" || token.length === 0) {
    throw new AuthNeededError(
      "Kindle getDeviceToken response had no usable token field; the capture looks stale and must be redone",
    );
  }
  return token;
}

async function fetchLibrary(session: KindleSession, fetchFn: typeof fetch): Promise<LibraryItem[]> {
  const url = `${LIBRARY_URL}?query=&libraryType=BOOKS&sortType=recency&querySize=50`;
  const response = await fetchFn(url, { headers: kindleHeaders(session.cookie) });
  if (!response.ok) {
    throw new Error(`Kindle library request failed with status ${response.status}`);
  }
  const body = (await response.json()) as LibraryResponse;
  if (!Array.isArray(body.itemsList)) {
    throw new Error("Kindle library returned an unexpected payload shape");
  }
  return body.itemsList;
}

// pageNumberUrl's response schema is not documented by either reverse-engineering source; accept
// a bare array of positions (its index is the page number) or an object wrapping such an array
// under "pageNumbers" or "positions". Anything else is treated as unusable. This also assumes the
// array is monotonically non-decreasing (each entry's position >= the one before it), which is
// likewise unconfirmed — pageFromPositionMap's linear scan relies on that ordering.
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

// pageNumberUrl and metadataUrl are presigned URLs fetched without cookies; both are best-effort
// per the design doc, so any failure here falls back to the next page-derivation strategy rather
// than failing the book.
async function fetchPageNumberMap(url: string, fetchFn: typeof fetch): Promise<number[] | null> {
  try {
    const response = await fetchFn(url);
    if (!response.ok) return null;
    return parsePageNumberMap(await response.json());
  } catch {
    return null;
  }
}

// metadataUrl may return JSONP (a bare function-call wrapper around the JSON body). The wrapper's
// callback name is not documented, so it's stripped generically: a leading identifier plus "(",
// and a trailing ")" with an optional ";".
function parseMetadataResponse(text: string): { startPosition: number; endPosition: number } | null {
  const trimmed = text.trim();
  const jsonpMatch = trimmed.match(/^[A-Za-z0-9_$]+\((.*)\);?$/s);
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

async function fetchMetadata(
  url: string,
  fetchFn: typeof fetch,
): Promise<{ startPosition: number; endPosition: number } | null> {
  try {
    const response = await fetchFn(url);
    if (!response.ok) return null;
    return parseMetadataResponse(await response.text());
  } catch {
    return null;
  }
}

// Three-tier page derivation, most to least authoritative:
//   1. pageNumberUrl map — a real printed-page lookup, when the book exposes one.
//   2. percentage x known page count — metadata's endPosition is used to estimate a total page
//      count (endPosition / positionsPerPage), which Amazon's own percentageRead then scales.
//      Neither reverse-engineering source specifies where a "known page count" would otherwise
//      come from, so this is an inferred reading of the design doc's tier 2, not a confirmed one.
//   3. position / positionsPerPage — a rough estimate with no book-specific grounding at all.
// Tiers 2 and 3 are marked `estimated: true`; only tier 1 is not.
function derivePage(input: {
  position: number;
  pageNumberMap: number[] | null;
  metadata: { startPosition: number; endPosition: number } | null;
  percentageRead: number;
  positionsPerPage: number;
}): { page: number; estimated: boolean } {
  if (input.pageNumberMap) {
    const mapped = pageFromPositionMap(input.pageNumberMap, input.position);
    if (mapped !== null) return { page: mapped, estimated: false };
  }
  if (input.metadata && input.metadata.endPosition > input.metadata.startPosition && Number.isFinite(input.percentageRead)) {
    const estimatedTotalPages = Math.max(1, Math.round(input.metadata.endPosition / input.positionsPerPage));
    return { page: Math.round((input.percentageRead / 100) * estimatedTotalPages), estimated: true };
  }
  return { page: Math.floor(input.position / input.positionsPerPage), estimated: true };
}

async function fetchBookPage(
  item: LibraryItem,
  session: KindleSession,
  deviceSessionToken: string,
  positionsPerPage: number,
  fetchFn: typeof fetch,
): Promise<{ page: number; estimated: boolean }> {
  const url = `${START_READING_URL}?asin=${encodeURIComponent(item.asin)}&clientVersion=20000100`;
  const response = await fetchFn(url, {
    headers: { ...kindleHeaders(session.cookie), "x-adp-session-token": deviceSessionToken },
  });
  if (!response.ok) {
    throw new Error(`Kindle startReading failed for ${item.asin} with status ${response.status}`);
  }
  const body = (await response.json()) as StartReadingResponse;
  const position = body.lastPageReadData?.position;
  if (typeof position !== "number") {
    throw new Error(`Kindle startReading for ${item.asin} had no reading position`);
  }
  const pageNumberMap = body.pageNumberUrl ? await fetchPageNumberMap(body.pageNumberUrl, fetchFn) : null;
  const metadata = body.metadataUrl ? await fetchMetadata(body.metadataUrl, fetchFn) : null;
  return derivePage({ position, pageNumberMap, metadata, percentageRead: item.percentageRead, positionsPerPage });
}

async function handlePutSession(request: Request, context: RouteContext): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "malformed JSON body" }, { status: 400 });
  }
  const candidate = body as Record<string, unknown> | null;
  const isValid =
    candidate !== null &&
    typeof candidate === "object" &&
    typeof candidate.cookie === "string" &&
    candidate.cookie.length > 0 &&
    typeof candidate.deviceSerialNumber === "string" &&
    candidate.deviceSerialNumber.length > 0 &&
    typeof candidate.deviceType === "string" &&
    candidate.deviceType.length > 0;
  if (!isValid) {
    return Response.json(
      { error: "expected { cookie, deviceSerialNumber, deviceType } as non-empty strings" },
      { status: 400 },
    );
  }
  const session: KindleSession = {
    cookie: candidate.cookie as string,
    deviceSerialNumber: candidate.deviceSerialNumber as string,
    deviceType: candidate.deviceType as string,
    updatedAt: new Date().toISOString(),
  };
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

    const deviceSessionToken = await fetchDeviceSessionToken(session, fetchFn);
    const library = await fetchLibrary(session, fetchFn);
    const positionsPerPage = Number(env.KINDLE_POSITIONS_PER_PAGE) || DEFAULT_POSITIONS_PER_PAGE;

    const currentPages: Record<string, number> = {};
    let anyEstimated = false;
    let lastBookError: Error | undefined;

    for (const item of library) {
      try {
        const { page, estimated } = await fetchBookPage(item, session, deviceSessionToken, positionsPerPage, fetchFn);
        currentPages[item.asin] = page;
        if (estimated) anyEstimated = true;
      } catch (error) {
        // A book failing individually doesn't fail the whole source — only the aggregate below
        // (every book failing) does.
        lastBookError = error instanceof Error ? error : new Error(String(error));
      }
    }

    if (library.length > 0 && Object.keys(currentPages).length === 0) {
      throw lastBookError ?? new Error("Every Kindle book failed to sync");
    }

    const previous = await readJson<KindlePositions>(env.STATE, KINDLE_STATE_KEYS.positions);
    let total = 0;
    if (!previous || previous.date !== today) {
      // New local day: the baseline resets to today's current readings, so today's value starts
      // at 0 rather than retroactively inventing progress.
      await writeJson(env.STATE, KINDLE_STATE_KEYS.positions, {
        date: today,
        pages: currentPages,
        estimated: anyEstimated,
      } satisfies KindlePositions);
    } else {
      // Same local day: compare against the baseline captured at the first sync of the day, not
      // against the previous sync, so the reported value is cumulative for the whole day. A book
      // with no baseline entry (first seen mid-day) records its current page as its baseline right
      // now — contributing 0 to this sync's total — so that the NEXT sync measures its progress
      // from here, rather than from 0 forever. Existing baselines are never moved forward here;
      // only a book that has never had a baseline this local day gets one. Books absent from this
      // run's library fetch (a transient failure, or removed from the library) keep their stored
      // baseline via the spread below, so a book that reappears later is still measured from its
      // original baseline rather than treated as newly seen.
      const mergedBaseline: Record<string, number> = { ...previous.pages };
      for (const [asin, page] of Object.entries(currentPages)) {
        const baselinePage = mergedBaseline[asin];
        if (baselinePage === undefined) {
          mergedBaseline[asin] = page;
          continue;
        }
        total += Math.max(0, page - baselinePage);
      }
      // Written on every sync (even when total is 0) so a mid-day first sighting's baseline is
      // actually persisted, not just computed and discarded.
      await writeJson(env.STATE, KINDLE_STATE_KEYS.positions, {
        date: today,
        pages: mergedBaseline,
        estimated: anyEstimated,
      } satisfies KindlePositions);
    }

    return [{ habitId: env.HABIT_ID_KINDLE!, value: total, unit: "pages" }];
  },

  routes: [
    { method: "PUT", path: "/kindle/session", auth: "admin", handler: handlePutSession },
    { method: "DELETE", path: "/kindle/session", auth: "admin", handler: handleDeleteSession },
  ],
};
