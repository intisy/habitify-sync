import type { HabitValue } from "./integrations/types";
import { isoDayRange } from "./time";

const HABITIFY_BASE_URL = "https://api.habitify.me";

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
      headers: { Authorization: this.apiKey, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) {
      throw new Error(`Habitify ${method} ${path} failed with status ${response.status}: ${await response.text()}`);
    }
  }

  // Returns only id/name/unit for each habit — never the full raw habit object — so this
  // discovery route can't leak unrelated personal habit data (schedules, streaks, notes, etc.)
  // through the API. The exact shape of Habitify's list response is only partly confirmed from
  // their docs, so this parsing is deliberately defensive: it accepts either `{ data: [...] }`
  // or a bare array, and tolerates either `unit_type` (the field the existing upsert writes) or
  // `unit` for the unit, skipping any entry that lacks an id.
  async listHabits(): Promise<HabitSummary[]> {
    // Same detach-before-call reasoning as in request() above: calling this.fetchFn(...) directly
    // would pass the HabitifyClient instance as `this` to the native fetch, which workerd rejects.
    const performFetch = this.fetchFn;
    const response = await performFetch(`${this.baseUrl}/habits`, {
      method: "GET",
      headers: { Authorization: this.apiKey },
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
      const unit = typeof record.unit_type === "string" ? record.unit_type : typeof record.unit === "string" ? record.unit : undefined;
      summaries.push({ id, name, unit });
    }
    return summaries;
  }

  // Habitify appends logs, so an idempotent write is delete-today-then-post.
  async upsertTodayLog(habit: HabitValue, timeZone: string, now: Date): Promise<void> {
    const { start, end } = isoDayRange(timeZone, now);
    const range = `?from=${encodeURIComponent(start)}&to=${encodeURIComponent(end)}`;
    await this.request("DELETE", `/logs/${habit.habitId}${range}`);
    // List fields explicitly here — never spread a HabitValue into the body. HabitValue can carry
    // a `diagnostics` object meant only for GET /status, and it must never leave for this
    // third-party API.
    await this.request("POST", `/logs/${habit.habitId}`, {
      unit_type: habit.unit,
      value: habit.value,
      target_date: start,
    });
  }
}
