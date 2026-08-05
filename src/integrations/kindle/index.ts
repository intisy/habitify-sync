import { readJson, writeJson } from "../../state";
import type { SettingsResolver } from "../../settings";
import {
  AuthNeededError,
  type HabitValue,
  type Integration,
  type RouteContext,
  type SettingDescriptor,
  type SourceContext,
} from "../types";

const GET_DEVICE_TOKEN_URL = "https://read.amazon.com/service/web/register/getDeviceToken";
const LIBRARY_URL = "https://read.amazon.com/kindle-library/search";
const START_READING_URL = "https://read.amazon.com/service/mobile/reader/startReading";
const WORD_COUNT_URL = "https://read.amazon.com/renderer/wordCount";
const PRODUCT_PAGE_URL = "https://www.amazon.com/dp";

// A negative page-count lookup (Amazon blocked the request, or the page had no parseable print
// length) is retried at most once per day, rather than on every hourly sync, so a book that
// genuinely has no discoverable print length doesn't cost a product-page fetch every run.
const PAGE_COUNT_NEGATIVE_CACHE_TTL_SECONDS = 86400;

// A printed page count that would obviously be a mis-parse (e.g. picking up a stray number from
// unrelated page markup) rather than a real book's print length.
const MAX_PLAUSIBLE_PRINTED_PAGE_COUNT = 100000;

// The Kindle Cloud Reader's own device identity, verified live against a real account. It is a
// constant for every account and every book — NOT a per-user value — so it is used as both the
// serialNumber and deviceType query params and the user never captures or supplies one.
const KINDLE_DEVICE_ID = "A2CTZ977SKFQZY";

// Last-resort estimate for a book whose Amazon word count is unavailable this sync (network
// failure, unparseable response, or no contentVersion/karamelToken to call wordCount with at all).
// Grounded in three verified books: Deep Work worked out to ~1500 positions/page, C Programming
// Language to ~2070, and the dense, small-print ESV Bible to ~5600. 1800 splits the difference for
// normal prose while accepting that dense reference books will over-count pages.
const DEFAULT_POSITIONS_PER_PAGE = 1800;

// Standard publishing-industry convention for words per printed page in a typical trade
// paperback. Used only when a book has no entry in KINDLE_PAGE_COUNTS, i.e. no real printed page
// count to divide the exact word count by.
const DEFAULT_WORDS_PER_PAGE = 250;

const KINDLE_SETTINGS: SettingDescriptor[] = [
  {
    key: "wordsPerPage",
    type: "number",
    default: String(DEFAULT_WORDS_PER_PAGE),
    description: "Words per printed page, used only when no printed page count is available at all.",
  },
  {
    key: "pageCounts",
    type: "json",
    description:
      "Optional override mapping asin -> printed page count, for a book whose printed page count Amazon's own product page won't yield.",
  },
  {
    key: "positionsPerPage",
    type: "number",
    default: String(DEFAULT_POSITIONS_PER_PAGE),
    description: "Whispersync positions per printed page, a last-resort fallback when a book's word count is unavailable.",
  },
];

// This integration's own KV keys — not shared generic state.
export const KINDLE_STATE_KEYS = {
  session: "kindle:session",
  positions: "kindle:positions",
  // Keyed by asin AND contentVersion: a new revision (Amazon reflowing the book) is simply a
  // different key, so the cache is invalidated by construction rather than by comparison.
  totalWords: (asin: string, contentVersion: string) => `kindle:totalWords:${asin}:${contentVersion}`,
  // Keyed by asin ONLY, unlike totalWords: a printed page count is a property of the print
  // edition, not of a specific Kindle content revision, so it never needs to be re-derived when
  // Amazon reflows the ebook.
  pageCount: (asin: string) => `kindle:pageCount:${asin}`,
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
  metadataUrl?: string;
  // The revision to pass to wordCount, and the token to render it. contentVersion is a plain
  // string when present. karamelToken's shape is only partly confirmed live — seen as a plain
  // object with a `.token` string — so it's typed `unknown` and unwrapped defensively in
  // extractRenderingToken rather than assumed.
  contentVersion?: string;
  karamelToken?: unknown;
}

interface BookMetadata {
  startPosition: number;
  endPosition: number;
}

interface BookReading {
  position: number;
  metadataUrl?: string;
  contentVersion?: string;
  renderingToken?: string;
}

// Which tier produced a book's page contribution this sync, most exact first. Carried into
// diagnostics so GET /status shows, per book, whether its figure is exact or estimated.
// "not-measured" is distinct from "positions-fallback": it means nothing was attempted at all
// (no baseline yet, or the position hasn't advanced), not that wordCount was tried and failed.
type PageDerivation = "print-pages" | "words-per-page" | "positions-fallback" | "not-measured";

// Where a book's printed page count (the print-pages tier's exact divisor) came from, if any was
// found at all. "none" covers both "never looked up" (book didn't contribute this sync) and
// "looked up and nothing usable was found" (cached negative, a failed fetch, or unparseable HTML).
type PageCountSource = "override" | "lookup" | "none";

// Diagnostic, per-book progress — carried on the returned HabitValue's `diagnostics` field purely
// so GET /status is useful for a human to sanity-check; not used in any math here, and never sent
// to Habitify (see the comment above the POST body in habitify.ts).
interface KindleBookDiagnostic {
  asin: string;
  title: string;
  progress: number;
  wordsRead: number;
  derivation: PageDerivation;
  pages: number;
  pageCountSource: PageCountSource;
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
  return {
    position: body.lastPageReadData.position,
    metadataUrl: body.metadataUrl,
    contentVersion: typeof body.contentVersion === "string" ? body.contentVersion : undefined,
    renderingToken: extractRenderingToken(body.karamelToken),
  };
}

// karamelToken's shape is only partly confirmed live: seen as a plain object with a `.token`
// string field. Amazon's own clients are known to pass tokens as bare strings elsewhere, so both
// shapes are accepted defensively rather than assuming the object form.
function extractRenderingToken(karamelToken: unknown): string | undefined {
  if (typeof karamelToken === "string" && karamelToken.length > 0) {
    return karamelToken;
  }
  if (karamelToken && typeof karamelToken === "object") {
    const token = (karamelToken as Record<string, unknown>).token;
    if (typeof token === "string" && token.length > 0) {
      return token;
    }
  }
  return undefined;
}

// Amazon's wordCount endpoint is range-based over the book's position units: startPosition is
// required, endPosition optional. Omitting endPosition returns the count from startPosition
// through the end of the book, so startPosition=0 with no endPosition is the whole book's word
// count. Verified live against asin B009ZUZ9FW (revision e2e02ac4): wordCount(0, 238526) = 43090,
// wordCount(238526) with no endPosition = 55560, and wordCount(0) with no endPosition = 98651 —
// 43090 + 55560 = 98650 ≈ 98651, confirming the range semantics are additive and consistent.
async function fetchWordCount(
  asin: string,
  revision: string,
  startPosition: number,
  endPosition: number | undefined,
  cookie: string,
  sessionId: string,
  renderingToken: string,
  fetchFn: typeof fetch,
): Promise<number | null> {
  const params = new URLSearchParams({
    asin,
    revision,
    contentType: "FullBook",
    startPosition: String(startPosition),
  });
  if (endPosition !== undefined) {
    params.set("endPosition", String(endPosition));
  }
  try {
    const response = await fetchFn(`${WORD_COUNT_URL}?${params.toString()}`, {
      headers: { ...kindleHeaders(cookie, sessionId), "x-amz-rendering-token": renderingToken },
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { wordCount?: unknown };
    return typeof body.wordCount === "number" ? body.wordCount : null;
  } catch {
    return null;
  }
}

// KINDLE_PAGE_COUNTS maps asin -> printed page count. It is an OPTIONAL OVERRIDE, not the primary
// mechanism: printed page counts are normally discovered automatically from each book's Amazon
// product page (see resolvePageCount below). This map exists only to rescue a book for which that
// discovery fails (e.g. Amazon blocks the Worker's product-page request), so it requires no
// day-to-day maintenance. Parsed defensively: invalid JSON (a SettingsResolver.getJson syntax
// error), a non-object body (e.g. an array), or an individual entry that isn't a positive finite
// number is dropped — per-entry for the bad-value case, entirely for a malformed top-level body —
// so a typo degrades that book (or every book) to the dynamic lookup (or, failing that, the
// words-per-page estimate) rather than throwing.
async function resolvePrintPageCountOverrides(settings: SettingsResolver): Promise<Record<string, number>> {
  let parsed: unknown;
  try {
    parsed = await settings.getJson("pageCounts");
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {};
  }
  const result: Record<string, number> = {};
  for (const [asin, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      result[asin] = value;
    }
  }
  return result;
}

// KINDLE_PAGE_COUNTS entries are keyed by asin only (see resolvePrintPageCountOverrides above);
// the same asin keying is used for the dynamic lookup's cache below, since a printed page count
// belongs to the print edition, not to any one Kindle content revision.

// Cached in KV per asin. `pages: number` is a confirmed printed page count, cached permanently —
// it cannot change. `pages: null` is a negative marker: the lookup was already attempted and
// found nothing (blocked, non-2xx, or unparseable), cached with a short TTL so it's retried at
// most once a day rather than on every hourly sync. Wrapping the number in an object (rather than
// storing it bare) is what lets a cached negative (`{ pages: null }`) be told apart from "never
// looked up at all" (no KV entry, so `readJson` returns `null` for the whole entry).
interface PageCountCacheEntry {
  pages: number | null;
}

// Ordered, most-specific-first: Amazon's English product pages label the field "Print length";
// German-locale pages use "Seitenzahl der Print-Ausgabe" for the same field; a handful of pages
// carry it instead (or additionally) as a "numberOfPages" JSON/attribute value. The first pattern
// to match a plausible value wins.
const PRINTED_PAGE_COUNT_PATTERNS: RegExp[] = [
  /Print length[:\s]*([0-9,]+)\s*pages/i,
  /Seitenzahl der Print-Ausgabe[:\s]*([0-9,]+)\s*Seiten/i,
  /"numberOfPages"\s*:\s*"?([0-9,]+)/i,
];

// Extracts a printed page count from a book's Amazon product-page HTML, trying each label variant
// in turn and rejecting anything that isn't a plausible positive page count (a stray "0", a
// non-numeric capture, or an absurdly large number that's more likely a mis-parse than a real
// print length) rather than trusting the first regex match blindly.
function parsePrintedPageCount(html: string): number | null {
  for (const pattern of PRINTED_PAGE_COUNT_PATTERNS) {
    const match = html.match(pattern);
    if (!match) continue;
    const value = Number(match[1].replace(/,/g, ""));
    if (Number.isInteger(value) && value > 0 && value <= MAX_PLAUSIBLE_PRINTED_PAGE_COUNT) {
      return value;
    }
  }
  return null;
}

// Fetches the book's public Amazon product page to discover its printed page count. Deliberately
// sends NO Cookie header: this is a public page that doesn't need (or want) the Amazon session —
// sending it would needlessly expose the captured session to an endpoint that works fine without
// it, and would make the response vary per-session instead of being a plain, cacheable public
// page. Only a browser User-Agent and Accept-Language are sent, matching a logged-out browser.
async function fetchPageCountFromProductPage(asin: string, fetchFn: typeof fetch): Promise<number | null> {
  try {
    const response = await fetchFn(`${PRODUCT_PAGE_URL}/${encodeURIComponent(asin)}`, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Accept-Language": "en-US,en;q=0.9",
      },
    });
    if (!response.ok) return null;
    return parsePrintedPageCount(await response.text());
  } catch {
    return null;
  }
}

// Resolves a book's printed page count, most exact first: an operator-supplied
// KINDLE_PAGE_COUNTS override (rescuing books Amazon blocks the Worker's own request for), else
// the cached or freshly-discovered product-page value. The override short-circuits before ever
// touching the cache or making a request, since it exists specifically to bypass the lookup.
async function resolvePageCount(
  asin: string,
  overridePageCount: number | undefined,
  kv: KVNamespace,
  fetchFn: typeof fetch,
): Promise<{ pageCount: number | undefined; source: PageCountSource }> {
  if (overridePageCount !== undefined) {
    return { pageCount: overridePageCount, source: "override" };
  }

  const cacheKey = KINDLE_STATE_KEYS.pageCount(asin);
  const cached = await readJson<PageCountCacheEntry>(kv, cacheKey);
  if (cached !== null) {
    return cached.pages !== null
      ? { pageCount: cached.pages, source: "lookup" }
      : { pageCount: undefined, source: "none" };
  }

  const discovered = await fetchPageCountFromProductPage(asin, fetchFn);
  if (discovered !== null) {
    // Permanent: a printed page count doesn't change, so there's no reason to ever re-fetch it.
    await writeJson(kv, cacheKey, { pages: discovered } satisfies PageCountCacheEntry);
    return { pageCount: discovered, source: "lookup" };
  }

  // Negative marker, short-lived: see the rationale on PageCountCacheEntry and
  // PAGE_COUNT_NEGATIVE_CACHE_TTL_SECONDS above.
  await kv.put(cacheKey, JSON.stringify({ pages: null } satisfies PageCountCacheEntry), {
    expirationTtl: PAGE_COUNT_NEGATIVE_CACHE_TTL_SECONDS,
  });
  return { pageCount: undefined, source: "none" };
}

// Fetches a book's whole-book word count (the exact denominator for the print-pages derivation),
// cached in KV per asin+contentVersion so it's spent once per book, not once per sync.
async function getTotalWordsInBook(
  asin: string,
  contentVersion: string,
  renderingToken: string,
  cookie: string,
  sessionId: string,
  kv: KVNamespace,
  fetchFn: typeof fetch,
): Promise<number | null> {
  const key = KINDLE_STATE_KEYS.totalWords(asin, contentVersion);
  const cached = await readJson<number>(kv, key);
  if (cached !== null) return cached;

  const total = await fetchWordCount(asin, contentVersion, 0, undefined, cookie, sessionId, renderingToken, fetchFn);
  if (total !== null) {
    await writeJson(kv, key, total);
  }
  return total;
}

interface PageDerivationResult {
  pages: number;
  wordsRead: number;
  derivation: PageDerivation;
  pageCountSource: PageCountSource;
}

// The waterfall for one book's page contribution since its baseline, most exact first. Every tier
// degrades to the next on any failure — a wordCount call failing (network error, non-2xx,
// unparseable body) or a book missing contentVersion/karamelToken never fails the book, let alone
// the whole sync; it just falls all the way back to the position estimate.
async function derivePagesSinceBaseline(
  asin: string,
  baselinePosition: number,
  currentPosition: number,
  reading: BookReading,
  overridePageCount: number | undefined,
  wordsPerPage: number,
  positionsPerPage: number,
  cookie: string,
  sessionId: string,
  kv: KVNamespace,
  fetchFn: typeof fetch,
): Promise<PageDerivationResult> {
  const positionsFallback = (): PageDerivationResult => ({
    pages: Math.max(0, (currentPosition - baselinePosition) / positionsPerPage),
    wordsRead: 0,
    derivation: "positions-fallback",
    // Never attempted: a page-count lookup is only worth spending on a book whose wordCount call
    // actually succeeded (see the efficiency note below), which never happened on this path.
    pageCountSource: "none",
  });

  if (!reading.contentVersion || !reading.renderingToken) {
    return positionsFallback();
  }
  // Bound to local consts so their non-undefined-ness survives the awaits below.
  const contentVersion = reading.contentVersion;
  const renderingToken = reading.renderingToken;

  const wordsRead = await fetchWordCount(
    asin,
    contentVersion,
    baselinePosition,
    currentPosition,
    cookie,
    sessionId,
    renderingToken,
    fetchFn,
  );
  if (wordsRead === null) {
    return positionsFallback();
  }

  // Only reached once wordsRead is known good — this is the one book this sync that actually
  // contributed, so it's the only one worth the cost of a page-count lookup (cached or not).
  const { pageCount, source } = await resolvePageCount(asin, overridePageCount, kv, fetchFn);

  if (pageCount !== undefined) {
    const totalWords = await getTotalWordsInBook(asin, contentVersion, renderingToken, cookie, sessionId, kv, fetchFn);
    if (totalWords !== null && totalWords > 0) {
      return { pages: (wordsRead / totalWords) * pageCount, wordsRead, derivation: "print-pages", pageCountSource: source };
    }
    // totalWordsInBook unavailable (fetch failed, or degenerately 0) — fall through to the
    // words-per-page estimate below, still using the wordsRead already fetched.
  }

  return { pages: wordsRead / wordsPerPage, wordsRead, derivation: "words-per-page", pageCountSource: source };
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
  settings: KINDLE_SETTINGS,

  async fetchToday(context: SourceContext): Promise<HabitValue[]> {
    const { env, today, fetchFn, settings } = context;
    // Guaranteed present: fetchToday only runs once SettingsResolver.isEnabled() has confirmed
    // every required setting resolved non-empty (habitId is kindle's only required setting).
    const habitId = await settings.getString("habitId");
    if (!habitId) {
      throw new Error("kindle is enabled but habitId resolved empty; this should be unreachable");
    }
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
    // inflated (or negative) page count, for both the fallback divisor and the estimate divisor.
    const positionsPerPage = Math.max(1, (await settings.getNumber("positionsPerPage")) ?? DEFAULT_POSITIONS_PER_PAGE);
    const wordsPerPage = Math.max(1, (await settings.getNumber("wordsPerPage")) ?? DEFAULT_WORDS_PER_PAGE);
    const printPageCounts = await resolvePrintPageCountOverrides(settings);

    interface ProcessedBook {
      title: string;
      reading: BookReading;
      progress: number | null;
    }
    const processedBooks: Record<string, ProcessedBook> = {};
    let errorCount = 0;
    let lastBookError: Error | undefined;

    for (const item of library) {
      try {
        const reading = await fetchBookReading(item.asin, session.cookie, sessionId, deviceSessionToken, fetchFn);
        // A personal document, or a book never opened (position -1): nothing to track, silently.
        if (reading === null) continue;

        let progress: number | null = null;
        if (reading.metadataUrl) {
          const metadata = await fetchMetadata(reading.metadataUrl, fetchFn);
          // A null progress means the metadata span wasn't positive — omit the book from
          // diagnostics below rather than report a misleading 0%.
          progress = metadata ? progressFraction(reading.position, metadata) : null;
        }
        processedBooks[item.asin] = { title: item.title, reading, progress };
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
    const bookDiagnostics: KindleBookDiagnostic[] = [];

    for (const [asin, book] of Object.entries(processedBooks)) {
      const position = book.reading.position;
      const baselinePosition = mergedBaseline[asin];

      let pages = 0;
      let wordsRead = 0;
      let derivation: PageDerivation = "not-measured";
      // "none" until proven otherwise: a book that never reaches the lookup (not-measured, or a
      // wordCount failure) never had a page count sourced from anywhere.
      let pageCountSource: PageCountSource = "none";

      if (baselinePosition === undefined) {
        // First time seen this local day: record the baseline now so the NEXT sync measures
        // progress from here, rather than from 0 forever. Contributes 0 to this sync's total; no
        // derivation was attempted (not even a failed one), so "not-measured" rather than
        // "positions-fallback" — and it must not poison the top-level estimated flag, which is
        // about whether the books that actually contributed pages were exact.
        mergedBaseline[asin] = position;
      } else if (position - baselinePosition <= 0) {
        // Never negative — a book re-read from an earlier position doesn't subtract from the
        // day's total — and not worth a wordCount call to prove what's already 0. Same reasoning
        // as above: nothing was attempted, so this can't be "positions-fallback" and must not
        // affect the estimated flag.
      } else {
        try {
          const result = await derivePagesSinceBaseline(
            asin,
            baselinePosition,
            position,
            book.reading,
            printPageCounts[asin],
            wordsPerPage,
            positionsPerPage,
            session.cookie,
            sessionId,
            env.STATE,
            fetchFn,
          );
          pages = result.pages;
          wordsRead = result.wordsRead;
          derivation = result.derivation;
          pageCountSource = result.pageCountSource;
        } catch {
          // Defense in depth: derivePagesSinceBaseline's own steps already degrade internally on
          // failure, but an unexpected throw still must not fail the whole sync. This book WAS
          // attempted (delta > 0), so it's "positions-fallback", not "not-measured".
          pages = Math.max(0, (position - baselinePosition) / positionsPerPage);
          derivation = "positions-fallback";
        }
        total += pages;
        if (derivation !== "print-pages") anyEstimated = true;
      }

      if (book.progress !== null) {
        bookDiagnostics.push({
          asin,
          title: book.title,
          progress: book.progress,
          wordsRead,
          derivation,
          pages,
          pageCountSource,
        });
      }
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
      habitId,
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
