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
      if (typeof habit !== "object" || habit === null) continue;
      const record = habit as Record<string, unknown>;
      const id = record.id;
      if (typeof id !== "string" || id.length === 0) continue;
      const name = typeof record.name === "string" ? record.name : undefined;
      const goals = Array.isArray(record.goals) ? record.goals : [];
      const firstGoal = goals.length > 0 && typeof goals[0] === "object" && goals[0] !== null
        ? (goals[0] as Record<string, unknown>)
        : undefined;
      const unit = typeof firstGoal?.unit === "string" ? firstGoal.unit : undefined;
      summaries.push({ id, name, unit });
    }
    return summaries;
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
