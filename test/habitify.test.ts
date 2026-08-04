import { describe, expect, it } from "vitest";
import { HabitifyClient } from "../src/habitify";

interface RecordedRequest {
  method: string;
  url: string;
  body: string | undefined;
  authorization: string | null;
}

function recordingFetch(recorded: RecordedRequest[], status = 200): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    recorded.push({
      method: init?.method ?? "GET",
      url: String(input),
      body: init?.body === undefined ? undefined : String(init.body),
      authorization: new Headers(init?.headers).get("Authorization"),
    });
    return new Response(status === 200 ? "{}" : "error", { status });
  }) as typeof fetch;
}

describe("HabitifyClient.upsertTodayLog", () => {
  const now = new Date("2026-08-04T10:00:00Z");

  it("deletes today's logs then posts the new value", async () => {
    const recorded: RecordedRequest[] = [];
    const client = new HabitifyClient("api-key", recordingFetch(recorded), "https://habitify.example");
    await client.upsertTodayLog({ habitId: "habit-1", value: 42, unit: "min" }, "Europe/Berlin", now);

    expect(recorded).toHaveLength(2);
    expect(recorded[0].method).toBe("DELETE");
    expect(recorded[0].url).toBe(
      "https://habitify.example/logs/habit-1?from=2026-08-04T00%3A00%3A00%2B02%3A00&to=2026-08-04T23%3A59%3A59%2B02%3A00",
    );
    expect(recorded[0].authorization).toBe("api-key");
    expect(recorded[1].method).toBe("POST");
    expect(recorded[1].url).toBe("https://habitify.example/logs/habit-1");
    expect(JSON.parse(recorded[1].body!)).toEqual({
      unit_type: "min",
      value: 42,
      target_date: "2026-08-04T00:00:00+02:00",
    });
  });

  it("throws on a non-ok response", async () => {
    const client = new HabitifyClient("api-key", recordingFetch([], 401), "https://habitify.example");
    await expect(
      client.upsertTodayLog({ habitId: "habit-1", value: 1, unit: "min" }, "Europe/Berlin", now),
    ).rejects.toThrow("Habitify DELETE");
  });
});
