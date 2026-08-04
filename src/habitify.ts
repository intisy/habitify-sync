import type { HabitValue } from "./integrations/types";
import { todayInTimeZone } from "./time";

const HABITIFY_BASE_URL = "https://api.habitify.me/v2";

// The closed set of unit symbols Habitify v2 accepts on a goal, a log, or an undo body. Sending
// anything outside this list gets a 422 back from Habitify with little detail, so callers should
// validate against this list themselves before ever making the request.
export const HABITIFY_UNIT_SYMBOLS = [
  "m",
  "kM",
  "ft",
  "yd",
  "mi",
  "floor",
  "L",
  "mL",
  "fl oz",
  "cup",
  "sec",
  "min",
  "hr",
  "ms",
  "kg",
  "g",
  "mg",
  "oz",
  "lb",
  "mcg",
  "J",
  "kJ",
  "kCal",
  "cal",
  "rep",
  "step",
] as const;

export type HabitifyUnitSymbol = (typeof HABITIFY_UNIT_SYMBOLS)[number];

export function isHabitifyUnitSymbol(value: string): value is HabitifyUnitSymbol {
  return (HABITIFY_UNIT_SYMBOLS as readonly string[]).includes(value);
}

function assertHabitifyUnitSymbol(value: string): asserts value is HabitifyUnitSymbol {
  if (!isHabitifyUnitSymbol(value)) {
    throw new Error(
      `Invalid Habitify unitSymbol "${value}". Valid values are: ${HABITIFY_UNIT_SYMBOLS.join(", ")}`,
    );
  }
}

export interface HabitSummary {
  id: string;
  name?: string;
  unit?: string;
}

const GOAL_PERIODICITIES = ["daily", "weekly", "monthly", "yearly"] as const;
type GoalPeriodicity = (typeof GOAL_PERIODICITIES)[number];

export interface CreateHabitGoal {
  periodicity: GoalPeriodicity;
  value: number;
  unit: string;
}

export interface CreateHabitInput {
  name: string;
  type?: "good" | "bad";
  description?: string;
  goal?: CreateHabitGoal;
  occurrence?: unknown;
}

// Trims a single raw habit object (as returned by either GET /habits or the 201 body of
// POST /habits) down to { id, name, unit } — never the full raw object — so callers can't leak
// unrelated personal habit data (schedules, streaks, notes, etc.) through the API. Returns
// undefined for anything that isn't a usable habit object (i.e. lacks a string id).
function parseHabitSummary(habit: unknown): HabitSummary | undefined {
  if (typeof habit !== "object" || habit === null) return undefined;
  const record = habit as Record<string, unknown>;
  const id = record.id;
  if (typeof id !== "string" || id.length === 0) return undefined;
  const name = typeof record.name === "string" ? record.name : undefined;
  const goals = Array.isArray(record.goals) ? record.goals : [];
  const firstGoal = goals.length > 0 && typeof goals[0] === "object" && goals[0] !== null
    ? (goals[0] as Record<string, unknown>)
    : undefined;
  const unit = typeof firstGoal?.unit === "string" ? firstGoal.unit : undefined;
  return { id, name, unit };
}

// A distinct class (rather than a plain Error) lets callers like the POST /habits route
// distinguish "the input itself was invalid" (400, caught before any request left the worker)
// from "Habitify rejected or failed the request" (502) without resorting to string-matching on
// the error message.
export class HabitInputValidationError extends Error {}

// Validated entirely before any network call: a 422 from Habitify names the offending field far
// less clearly than a local check can, and there's no reason to spend a round trip discovering
// a mistake this function can catch for free.
function assertValidCreateHabitInput(input: CreateHabitInput): void {
  if (typeof input.name !== "string" || input.name.trim().length === 0) {
    throw new HabitInputValidationError("Habit name must be a non-empty string");
  }
  if (input.type !== undefined && input.type !== "good" && input.type !== "bad") {
    throw new HabitInputValidationError(`Invalid habit type "${input.type}". Valid values are: good, bad`);
  }
  if (input.goal !== undefined) {
    if (typeof input.goal !== "object" || input.goal === null) {
      throw new HabitInputValidationError("Goal must be an object with periodicity, value, and unit");
    }
    const { periodicity, value, unit } = input.goal;
    if (!(GOAL_PERIODICITIES as readonly string[]).includes(periodicity)) {
      throw new HabitInputValidationError(
        `Invalid goal periodicity "${periodicity}". Valid values are: ${GOAL_PERIODICITIES.join(", ")}`,
      );
    }
    if (!Number.isFinite(value) || value <= 0) {
      throw new HabitInputValidationError(`Invalid goal value ${value}. Must be a finite number greater than 0`);
    }
    if (!isHabitifyUnitSymbol(unit)) {
      throw new HabitInputValidationError(
        `Invalid Habitify unitSymbol "${unit}". Valid values are: ${HABITIFY_UNIT_SYMBOLS.join(", ")}`,
      );
    }
  }
}

// The only shape GET /habits/journal's optional `date` query parameter accepts, per the
// Habitify v2 docs. Checked locally so a malformed date surfaces as a 400 naming the expected
// format rather than a 502 built from whatever Habitify's own validation error looks like.
const JOURNAL_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export class HabitifyClient {
  constructor(
    private readonly apiKey: string,
    private readonly fetchFn: typeof fetch = fetch,
    private readonly baseUrl: string = HABITIFY_BASE_URL,
  ) {}

  private async request(method: string, path: string, body?: unknown): Promise<void> {
    // Detach fetchFn from `this` before calling it. workerd's native fetch throws "Illegal
    // invocation" if called with a `this` that isn't the global scope, and `this.fetchFn(...)`
    // does exactly that — the property access makes `this` (the HabitifyClient instance) the
    // receiver of the call.
    const performFetch = this.fetchFn;
    const response = await performFetch(`${this.baseUrl}${path}`, {
      method,
      headers: { "X-API-Key": this.apiKey, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    // POST /logs returns 201, not 200, so `response.ok` (2xx) is checked rather than an exact
    // status code.
    if (!response.ok) {
      throw new Error(`Habitify ${method} ${path} failed with status ${response.status}: ${await response.text()}`);
    }
  }

  // Returns only id/name/unit for each habit — never the full raw habit object — so this
  // discovery route can't leak unrelated personal habit data (schedules, streaks, notes, etc.)
  // through the API. The exact shape of Habitify's list response is only partly confirmed from
  // their docs, so this parsing is deliberately defensive: it accepts either `{ data: [...] }`
  // or a bare array, and skips any entry that lacks an id. A habit's unit comes from its FIRST
  // goal's `unit` (see the Goal schema) — a habit with no goals configured has no unit at all.
  async listHabits(): Promise<HabitSummary[]> {
    // Same detach-before-call reasoning as in request() above: calling this.fetchFn(...) directly
    // would pass the HabitifyClient instance as `this` to the native fetch, which workerd rejects.
    const performFetch = this.fetchFn;
    const response = await performFetch(`${this.baseUrl}/habits`, {
      method: "GET",
      headers: { "X-API-Key": this.apiKey },
    });
    if (!response.ok) {
      throw new Error(`Habitify GET /habits failed with status ${response.status}: ${await response.text()}`);
    }
    const payload = (await response.json()) as unknown;
    const habits = Array.isArray(payload) ? payload : (payload as { data?: unknown[] })?.data ?? [];
    const summaries: HabitSummary[] = [];
    for (const habit of habits) {
      const summary = parseHabitSummary(habit);
      if (summary) summaries.push(summary);
    }
    return summaries;
  }

  // Returns the GET /habits response body completely untouched, deliberately bypassing the
  // trimming listHabits performs above — this is a diagnostic escape hatch for cases where the
  // trimmed { id, name, unit } shape hides the field that explains unexpected behavior (e.g. a
  // habit's scheduling, area, time-of-day assignment, archived flag, or created timestamp).
  async listHabitsRaw(): Promise<unknown> {
    // Same detach-before-call reasoning as in request() and listHabits() above.
    const performFetch = this.fetchFn;
    const response = await performFetch(`${this.baseUrl}/habits`, {
      method: "GET",
      headers: { "X-API-Key": this.apiKey },
    });
    if (!response.ok) {
      throw new Error(`Habitify GET /habits failed with status ${response.status}: ${await response.text()}`);
    }
    return (await response.json()) as unknown;
  }

  // Returns the GET /habits/journal response body completely untouched — the day-by-day view
  // Habitify's own app renders for a given date (completion status and progress per habit) — so
  // it can be compared against listHabits/listHabitsRaw to diagnose a habit that exists via the
  // API but doesn't appear as expected in the app. Also a diagnostic escape hatch, same as
  // listHabitsRaw above.
  async getJournalRaw(date?: string): Promise<unknown> {
    if (date !== undefined && !JOURNAL_DATE_PATTERN.test(date)) {
      throw new HabitInputValidationError(`Invalid journal date "${date}". Expected format: YYYY-MM-DD`);
    }
    const path = date === undefined ? "/habits/journal" : `/habits/journal?date=${date}`;
    // Same detach-before-call reasoning as in request() and listHabits() above.
    const performFetch = this.fetchFn;
    const response = await performFetch(`${this.baseUrl}${path}`, {
      method: "GET",
      headers: { "X-API-Key": this.apiKey },
    });
    if (!response.ok) {
      throw new Error(
        `Habitify GET /habits/journal failed with status ${response.status}: ${await response.text()}`,
      );
    }
    return (await response.json()) as unknown;
  }

  // Creates a new Habitify habit so an operator can provision one to log into without ever
  // handling HABITIFY_API_KEY locally. Defaults mirror the simplest possible habit: a "good"
  // habit that occurs every day. Optional fields are omitted from the request body entirely
  // (rather than sent as null) since Habitify's schema treats their absence and null
  // differently for some fields.
  async createHabit(input: CreateHabitInput): Promise<HabitSummary> {
    assertValidCreateHabitInput(input);
    const body: Record<string, unknown> = {
      name: input.name,
      type: input.type ?? "good",
      occurrence: input.occurrence ?? { type: "daily" },
    };
    if (input.description !== undefined) body.description = input.description;
    if (input.goal !== undefined) body.goal = input.goal;

    // Same detach-before-call reasoning as in request() and listHabits() above.
    const performFetch = this.fetchFn;
    const response = await performFetch(`${this.baseUrl}/habits`, {
      method: "POST",
      headers: { "X-API-Key": this.apiKey, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    // The success code for a creation is 201, not 200, so `response.ok` (2xx) is checked rather
    // than an exact status code.
    if (!response.ok) {
      throw new Error(`Habitify POST /habits failed with status ${response.status}: ${await response.text()}`);
    }

    const responseBody = (await response.json()) as unknown;
    const direct = parseHabitSummary(responseBody);
    if (direct) return direct;

    // The 201 body's shape isn't confirmed to match a GET /habits list entry — it may be wrapped
    // one level under `data`. Try that unwrap before giving up on parsing the response directly.
    if (typeof responseBody === "object" && responseBody !== null && "data" in responseBody) {
      const unwrapped = parseHabitSummary((responseBody as Record<string, unknown>).data);
      if (unwrapped) return unwrapped;
    }

    // The write already succeeded at this point — Habitify created the habit, it just returned a
    // body this client can't parse (a bare confirmation message, a shape missing goals, etc.).
    // Creating a habit is NOT idempotent: throwing here would report a successful write as a
    // failure and invite the caller to retry, which would create a duplicate habit. So instead of
    // throwing, fall back to re-reading the habit list and matching by the name just requested.
    const habits = await this.listHabits();
    const matchesByName = habits.filter((habit) => habit.name === input.name);
    if (matchesByName.length > 0) {
      // A newly created habit is the most recently added one, i.e. the last match in list order.
      return matchesByName[matchesByName.length - 1];
    }

    throw new Error(
      `Habitify POST /habits succeeded (status ${response.status}) but its response body could not be parsed, ` +
        `and no habit named "${input.name}" was found via GET /habits. The habit was probably created despite ` +
        `this error — check GET /habits before retrying, since retrying risks creating a duplicate habit.`,
    );
  }

  // Habitify v2 has no range-delete endpoint for logs (only per-log DELETE by id, and there's no
  // GET to discover log ids), so `POST /logs/undo` — which clears every log for the habit on a
  // given day — is the idempotency primitive instead: undo today's logs, then post the fresh
  // total. Rerunning the same hour with the same source data converges to the same result.
  async upsertTodayLog(habit: HabitValue, timeZone: string, now: Date): Promise<void> {
    assertHabitifyUnitSymbol(habit.unit);
    const targetDate = todayInTimeZone(timeZone, now);
    await this.request("POST", `/habits/${habit.habitId}/logs/undo`, { targetDate });
    // List fields explicitly here — never spread a HabitValue into the body. HabitValue can carry
    // a `diagnostics` object meant only for GET /status, and it must never leave for this
    // third-party API.
    await this.request("POST", `/habits/${habit.habitId}/logs`, {
      unitSymbol: habit.unit,
      value: habit.value,
      targetDate,
    });
  }
}
