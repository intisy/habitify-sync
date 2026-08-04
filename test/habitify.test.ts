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

function jsonFetch(body: unknown, status = 200): typeof fetch {
  return (async () => new Response(JSON.stringify(body), { status })) as typeof fetch;
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

describe("HabitifyClient.listHabits", () => {
  it("sends the correct URL and the raw-key Authorization header", async () => {
    const recorded: RecordedRequest[] = [];
    const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
      recorded.push({
        method: init?.method ?? "GET",
        url: String(input),
        body: init?.body === undefined ? undefined : String(init.body),
        authorization: new Headers(init?.headers).get("Authorization"),
      });
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    }) as typeof fetch;
    const client = new HabitifyClient("api-key", fetchFn, "https://habitify.example");
    await client.listHabits();

    expect(recorded).toHaveLength(1);
    expect(recorded[0].method).toBe("GET");
    expect(recorded[0].url).toBe("https://habitify.example/habits");
    expect(recorded[0].authorization).toBe("api-key");
  });

  it("parses a { data: [...] } response into trimmed summaries", async () => {
    const client = new HabitifyClient(
      "api-key",
      jsonFetch({ data: [{ id: "habit-1", name: "Read", unit_type: "pages", extra: "ignored" }] }),
      "https://habitify.example",
    );
    const habits = await client.listHabits();
    expect(habits).toEqual([{ id: "habit-1", name: "Read", unit: "pages" }]);
  });

  it("tolerates a bare array response", async () => {
    const client = new HabitifyClient(
      "api-key",
      jsonFetch([{ id: "habit-2", name: "Run", unit: "min" }]),
      "https://habitify.example",
    );
    const habits = await client.listHabits();
    expect(habits).toEqual([{ id: "habit-2", name: "Run", unit: "min" }]);
  });

  it("skips entries with no id", async () => {
    const client = new HabitifyClient(
      "api-key",
      jsonFetch({ data: [{ name: "No id" }, { id: "habit-3", name: "Has id" }] }),
      "https://habitify.example",
    );
    const habits = await client.listHabits();
    expect(habits).toEqual([{ id: "habit-3", name: "Has id", unit: undefined }]);
  });

  it("prefers unit_type over unit when both are present", async () => {
    const client = new HabitifyClient(
      "api-key",
      jsonFetch({ data: [{ id: "habit-4", unit_type: "pages", unit: "min" }] }),
      "https://habitify.example",
    );
    const habits = await client.listHabits();
    expect(habits[0].unit).toBe("pages");
  });

  it("falls back to unit when unit_type is absent", async () => {
    const client = new HabitifyClient(
      "api-key",
      jsonFetch({ data: [{ id: "habit-5", unit: "min" }] }),
      "https://habitify.example",
    );
    const habits = await client.listHabits();
    expect(habits[0].unit).toBe("min");
  });

  it("throws on a non-ok response", async () => {
    const client = new HabitifyClient("api-key", recordingFetch([], 401), "https://habitify.example");
    await expect(client.listHabits()).rejects.toThrow("Habitify GET /habits failed with status 401");
  });
});

// A plain vi.fn() mock is indifferent to its `this` binding, so it can't reproduce workerd's
// behavior: calling the native fetch with a `this` that isn't the global scope throws "Illegal
// invocation". These tests instead use a real, non-arrow `function` that records whatever `this`
// it was invoked with. If HabitifyClient ever regresses to calling `this.fetchFn(...)` (a
// property access, which makes the HabitifyClient instance the call's receiver), `this` inside the
// stub would be that instance. Called correctly — as a detached plain function — strict-mode ES
// modules give an unbound call `this === undefined`, which is what these tests assert.
describe("HabitifyClient fetchFn this-binding", () => {
  const now = new Date("2026-08-04T10:00:00Z");

  function makeThisRecordingFetch(responseBody: unknown): { fetchFn: typeof fetch; getRecordedThis: () => unknown } {
    let recordedThis: unknown = "fetchFn was never called";
    function thisRecordingFetch(this: unknown): Promise<Response> {
      recordedThis = this;
      return Promise.resolve(new Response(JSON.stringify(responseBody), { status: 200 }));
    }
    return { fetchFn: thisRecordingFetch as unknown as typeof fetch, getRecordedThis: () => recordedThis };
  }

  it("invokes fetchFn with this === undefined in upsertTodayLog, not the HabitifyClient instance", async () => {
    const { fetchFn, getRecordedThis } = makeThisRecordingFetch({});
    const client = new HabitifyClient("api-key", fetchFn, "https://habitify.example");
    await client.upsertTodayLog({ habitId: "habit-1", value: 1, unit: "min" }, "Europe/Berlin", now);
    expect(getRecordedThis()).toBeUndefined();
    expect(getRecordedThis()).not.toBe(client);
  });

  it("invokes fetchFn with this === undefined in listHabits, not the HabitifyClient instance", async () => {
    const { fetchFn, getRecordedThis } = makeThisRecordingFetch({ data: [] });
    const client = new HabitifyClient("api-key", fetchFn, "https://habitify.example");
    await client.listHabits();
    expect(getRecordedThis()).toBeUndefined();
    expect(getRecordedThis()).not.toBe(client);
  });
});
