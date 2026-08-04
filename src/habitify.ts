import type { HabitValue } from "./integrations/types";
import { isoDayRange } from "./time";

const HABITIFY_BASE_URL = "https://api.habitify.me";

export class HabitifyClient {
  constructor(
    private readonly apiKey: string,
    private readonly fetchFn: typeof fetch = fetch,
    private readonly baseUrl: string = HABITIFY_BASE_URL,
  ) {}

  private async request(method: string, path: string, body?: unknown): Promise<void> {
    const response = await this.fetchFn(`${this.baseUrl}${path}`, {
      method,
      headers: { Authorization: this.apiKey, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) {
      throw new Error(`Habitify ${method} ${path} failed with status ${response.status}: ${await response.text()}`);
    }
  }

  // Habitify appends logs, so an idempotent write is delete-today-then-post.
  async upsertTodayLog(habit: HabitValue, timeZone: string, now: Date): Promise<void> {
    const { start, end } = isoDayRange(timeZone, now);
    const range = `?from=${encodeURIComponent(start)}&to=${encodeURIComponent(end)}`;
    await this.request("DELETE", `/logs/${habit.habitId}${range}`);
    await this.request("POST", `/logs/${habit.habitId}`, {
      unit_type: habit.unit,
      value: habit.value,
      target_date: start,
    });
  }
}
