import { readJson, writeJson } from "../../state";
import { naiveLocalMidnightEpochSeconds } from "../../time";
import {
  AuthNeededError,
  type Env,
  type IntegrationRoute,
  type RouteContext,
  type SourceContext,
} from "../types";
import type { StravaActivity } from "./activities";

const TRAINING_ACTIVITIES_URL = "https://www.strava.com/athlete/training_activities";

// One page is months of activity for even a heavy user, and the response is newest-first, so a
// single day is covered with an enormous margin and pagination would only add failure modes.
const TRAINING_ACTIVITIES_PER_PAGE = 100;

// This reader's own KV keys — not shared generic state.
export const STRAVA_WEB_STATE_KEYS = {
  session: "strava:session",
};

export interface StravaSession {
  cookie: string;
  updatedAt: string;
}

// Strava's web JSON is undocumented and unversioned, so each field is read through an ordered list
// of names it has been observed under, most current first.
const MOVING_TIME_FIELDS = ["moving_time_raw", "moving_time"] as const;
const STARTED_AT_FIELDS = ["start_date_local_raw", "start_date_local"] as const;

export interface WebReadResult {
  activities: StravaActivity[];
  diagnostics: {
    reader: "web";
    activitiesSeen: number;
    activitiesCounted: number;
    fieldsMatched: { movingTime: string | null; startedAt: string | null };
  };
}

function readNumericField(
  model: Record<string, unknown>,
  names: readonly string[],
): { value: number; field: string } | null {
  for (const name of names) {
    const raw = model[name];
    const value = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
    if (Number.isFinite(value)) {
      return { value, field: name };
    }
  }
  return null;
}

function webHeaders(cookie: string): HeadersInit {
  return {
    Cookie: cookie,
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    Accept: "text/javascript, application/json, text/plain, */*",
    "X-Requested-With": "XMLHttpRequest",
    Referer: "https://www.strava.com/athlete/training",
  };
}

export async function readStravaSession(env: Env): Promise<StravaSession | null> {
  return readJson<StravaSession>(env.STATE, STRAVA_WEB_STATE_KEYS.session);
}

export async function fetchWebActivities(context: SourceContext, session: StravaSession): Promise<WebReadResult> {
  const { timeZone, now, fetchFn } = context;
  const response = await fetchFn(`${TRAINING_ACTIVITIES_URL}?page=1&per_page=${TRAINING_ACTIVITIES_PER_PAGE}`, {
    headers: webHeaders(session.cookie),
  });
  if (response.status === 401 || response.status === 403) {
    throw new AuthNeededError("Strava rejected the stored web session; redo the PUT /strava/session capture");
  }
  if (!response.ok) {
    throw new Error(`Strava training activities request failed with status ${response.status}`);
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    // A bot challenge answers 200 with HTML. Naming the content type is what tells an operator they
    // were challenged, rather than leaving an opaque JSON parse error.
    throw new Error(
      `Strava training activities returned non-JSON (content-type: ${response.headers.get("Content-Type") ?? "none"})`,
    );
  }
  const models = (body as { models?: unknown } | null)?.models;
  if (!Array.isArray(models)) {
    throw new Error("Strava returned an unexpected payload shape");
  }

  const since = naiveLocalMidnightEpochSeconds(timeZone, now);
  const activities: StravaActivity[] = [];
  const fieldsMatched: WebReadResult["diagnostics"]["fieldsMatched"] = { movingTime: null, startedAt: null };

  for (const model of models) {
    if (!model || typeof model !== "object") continue;
    const record = model as Record<string, unknown>;
    const movingTime = readNumericField(record, MOVING_TIME_FIELDS);
    const startedAt = readNumericField(record, STARTED_AT_FIELDS);
    // Skipped, never counted as zero: an unparseable model means the payload shape moved, and a
    // zero-minute activity would disguise that as a plausibly quiet day.
    if (!movingTime || !startedAt) continue;
    fieldsMatched.movingTime ??= movingTime.field;
    fieldsMatched.startedAt ??= startedAt.field;
    if (startedAt.value < since) continue;
    activities.push({ movingTimeSeconds: movingTime.value });
  }

  return {
    activities,
    diagnostics: { reader: "web", activitiesSeen: models.length, activitiesCounted: activities.length, fieldsMatched },
  };
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
  const session: StravaSession = { cookie, updatedAt: new Date().toISOString() };
  await writeJson(context.env.STATE, STRAVA_WEB_STATE_KEYS.session, session);
  return new Response(null, { status: 204 });
}

async function handleDeleteSession(_request: Request, context: RouteContext): Promise<Response> {
  await context.env.STATE.delete(STRAVA_WEB_STATE_KEYS.session);
  return new Response(null, { status: 204 });
}

export const stravaWebRoutes: IntegrationRoute[] = [
  { method: "PUT", path: "/strava/session", auth: "admin", handler: handlePutSession },
  { method: "DELETE", path: "/strava/session", auth: "admin", handler: handleDeleteSession },
];
