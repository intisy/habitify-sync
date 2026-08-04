import { describe, expect, it } from "vitest";
import { HabitifyClient, HabitInputValidationError } from "../src/habitify";

interface RecordedRequest {
  method: string;
  url: string;
  body: string | undefined;
  apiKey: string | null;
  authorization: string | null;
}

function recordingFetch(recorded: RecordedRequest[], status = 200): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    recorded.push({
      method: init?.method ?? "GET",
      url: String(input),
      body: init?.body === undefined ? undefined : String(init.body),
      apiKey: headers.get("X-API-Key"),
      authorization: headers.get("Authorization"),
    });
    return new Response(status >= 200 && status < 300 ? "{}" : "error", { status });
  }) as typeof fetch;
}

function jsonFetch(body: unknown, status = 200): typeof fetch {
  return (async () => new Response(JSON.stringify(body), { status })) as typeof fetch;
}

// Like recordingFetch, but its success body is a usable created-habit object (an id, at
// minimum) rather than "{}" — needed for createHabit tests, since createHabit parses its
// response body and throws if it can't find an id.
function recordingCreatedHabitFetch(recorded: RecordedRequest[], status = 201): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    recorded.push({
      method: init?.method ?? "GET",
      url: String(input),
      body: init?.body === undefined ? undefined : String(init.body),
      apiKey: headers.get("X-API-Key"),
      authorization: headers.get("Authorization"),
    });
    return new Response(
      status >= 200 && status < 300 ? JSON.stringify({ id: "habit-new", name: "Read", goals: [] }) : "error",
      { status },
    );
  }) as typeof fetch;
}

describe("HabitifyClient.upsertTodayLog", () => {
  // 2026-08-04T23:30 UTC is 2026-08-05T01:30 in Europe/Berlin (UTC+2 under DST) — past UTC
  // midnight but not yet past Berlin midnight, so this proves todayInTimeZone (local calendar
  // date) is used for targetDate, not a UTC-derived date, which would wrongly read 2026-08-04.
  const now = new Date("2026-08-04T23:30:00Z");

  it("undoes today's logs, then posts the new value, in that order", async () => {
    const recorded: RecordedRequest[] = [];
    const client = new HabitifyClient("api-key", recordingFetch(recorded), "https://habitify.example/v2");
    await client.upsertTodayLog({ habitId: "habit-1", value: 42, unit: "min" }, "Europe/Berlin", now);

    expect(recorded).toHaveLength(2);

    expect(recorded[0].method).toBe("POST");
    expect(recorded[0].url).toBe("https://habitify.example/v2/habits/habit-1/logs/undo");
    expect(recorded[0].apiKey).toBe("api-key");
    expect(recorded[0].authorization).toBeNull();
    expect(JSON.parse(recorded[0].body!)).toEqual({ targetDate: "2026-08-05" });

    expect(recorded[1].method).toBe("POST");
    expect(recorded[1].url).toBe("https://habitify.example/v2/habits/habit-1/logs");
    expect(recorded[1].apiKey).toBe("api-key");
    expect(recorded[1].authorization).toBeNull();
    expect(JSON.parse(recorded[1].body!)).toEqual({
      unitSymbol: "min",
      value: 42,
      targetDate: "2026-08-05",
    });
  });

  it("accepts a 201 from POST /logs", async () => {
    const client = new HabitifyClient("api-key", recordingFetch([], 201), "https://habitify.example/v2");
    await expect(
      client.upsertTodayLog({ habitId: "habit-1", value: 1, unit: "min" }, "Europe/Berlin", now),
    ).resolves.toBeUndefined();
  });

  it("throws on a non-ok response from the undo call", async () => {
    const client = new HabitifyClient("api-key", recordingFetch([], 401), "https://habitify.example/v2");
    await expect(
      client.upsertTodayLog({ habitId: "habit-1", value: 1, unit: "min" }, "Europe/Berlin", now),
    ).rejects.toThrow("Habitify POST /habits/habit-1/logs/undo failed with status 401");
  });

  it("throws on a non-ok response from the log-post call", async () => {
    let callCount = 0;
    const fetchFn = (async () => {
      callCount++;
      // Undo (1st call) succeeds; the log POST (2nd call) fails.
      return new Response(callCount === 1 ? "{}" : "error", { status: callCount === 1 ? 200 : 422 });
    }) as typeof fetch;
    const client = new HabitifyClient("api-key", fetchFn, "https://habitify.example/v2");
    await expect(
      client.upsertTodayLog({ habitId: "habit-1", value: 1, unit: "min" }, "Europe/Berlin", now),
    ).rejects.toThrow("Habitify POST /habits/habit-1/logs failed with status 422");
  });

  it("rejects an invalid unitSymbol before making any request", async () => {
    const recorded: RecordedRequest[] = [];
    const client = new HabitifyClient("api-key", recordingFetch(recorded), "https://habitify.example/v2");
    await expect(
      client.upsertTodayLog({ habitId: "habit-1", value: 1, unit: "pages" }, "Europe/Berlin", now),
    ).rejects.toThrow(/Invalid Habitify unitSymbol "pages"/);
    expect(recorded).toHaveLength(0);
  });
});

describe("HabitifyClient.listHabits", () => {
  it("sends the correct /v2/habits URL and the X-API-Key header, not Authorization", async () => {
    const recorded: RecordedRequest[] = [];
    const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      recorded.push({
        method: init?.method ?? "GET",
        url: String(input),
        body: init?.body === undefined ? undefined : String(init.body),
        apiKey: headers.get("X-API-Key"),
        authorization: headers.get("Authorization"),
      });
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    }) as typeof fetch;
    const client = new HabitifyClient("api-key", fetchFn, "https://habitify.example/v2");
    await client.listHabits();

    expect(recorded).toHaveLength(1);
    expect(recorded[0].method).toBe("GET");
    expect(recorded[0].url).toBe("https://habitify.example/v2/habits");
    expect(recorded[0].apiKey).toBe("api-key");
    expect(recorded[0].authorization).toBeNull();
  });

  it("parses a { data: [...] } response, taking the unit from the first goal", async () => {
    const client = new HabitifyClient(
      "api-key",
      jsonFetch({
        data: [
          {
            id: "habit-1",
            name: "Read",
            goals: [{ id: "goal-1", createdAt: "2026-01-01T00:00:00Z", periodicity: "daily", value: 1, unit: "rep" }],
            extra: "ignored",
          },
        ],
      }),
      "https://habitify.example/v2",
    );
    const habits = await client.listHabits();
    expect(habits).toEqual([{ id: "habit-1", name: "Read", unit: "rep" }]);
  });

  it("tolerates a bare array response", async () => {
    const client = new HabitifyClient(
      "api-key",
      jsonFetch([{ id: "habit-2", name: "Run", goals: [{ unit: "min" }] }]),
      "https://habitify.example/v2",
    );
    const habits = await client.listHabits();
    expect(habits).toEqual([{ id: "habit-2", name: "Run", unit: "min" }]);
  });

  it("yields an undefined unit for a habit with no goals", async () => {
    const client = new HabitifyClient(
      "api-key",
      jsonFetch({ data: [{ id: "habit-3", name: "No goals", goals: [] }] }),
      "https://habitify.example/v2",
    );
    const habits = await client.listHabits();
    expect(habits).toEqual([{ id: "habit-3", name: "No goals", unit: undefined }]);
  });

  it("takes the unit from only the FIRST goal when multiple are present", async () => {
    const client = new HabitifyClient(
      "api-key",
      jsonFetch({
        data: [{ id: "habit-4", goals: [{ unit: "kg" }, { unit: "min" }] }],
      }),
      "https://habitify.example/v2",
    );
    const habits = await client.listHabits();
    expect(habits[0].unit).toBe("kg");
  });

  it("skips entries with no id", async () => {
    const client = new HabitifyClient(
      "api-key",
      jsonFetch({ data: [{ name: "No id" }, { id: "habit-5", name: "Has id", goals: [] }] }),
      "https://habitify.example/v2",
    );
    const habits = await client.listHabits();
    expect(habits).toEqual([{ id: "habit-5", name: "Has id", unit: undefined }]);
  });

  it("throws on a non-ok response", async () => {
    const client = new HabitifyClient("api-key", recordingFetch([], 401), "https://habitify.example/v2");
    await expect(client.listHabits()).rejects.toThrow("Habitify GET /habits failed with status 401");
  });
});

describe("HabitifyClient.createHabit", () => {
  function createdHabitFetch(status = 201): typeof fetch {
    return (async () =>
      new Response(
        JSON.stringify({
          id: "habit-new",
          name: "Read 10 pages",
          goals: [{ id: "goal-1", periodicity: "daily", value: 10, unit: "rep" }],
        }),
        { status },
      )) as typeof fetch;
  }

  it("sends the correct /v2/habits URL, the X-API-Key header (not Authorization), and defaults", async () => {
    const recorded: RecordedRequest[] = [];
    const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      recorded.push({
        method: init?.method ?? "GET",
        url: String(input),
        body: init?.body === undefined ? undefined : String(init.body),
        apiKey: headers.get("X-API-Key"),
        authorization: headers.get("Authorization"),
      });
      return new Response(JSON.stringify({ id: "habit-new", name: "Read", goals: [] }), { status: 201 });
    }) as typeof fetch;
    const client = new HabitifyClient("api-key", fetchFn, "https://habitify.example/v2");
    await client.createHabit({ name: "Read" });

    expect(recorded).toHaveLength(1);
    expect(recorded[0].method).toBe("POST");
    expect(recorded[0].url).toBe("https://habitify.example/v2/habits");
    expect(recorded[0].apiKey).toBe("api-key");
    expect(recorded[0].authorization).toBeNull();
    expect(JSON.parse(recorded[0].body!)).toEqual({
      name: "Read",
      type: "good",
      occurrence: { type: "daily" },
    });
  });

  it("omits optional fields entirely rather than sending them as null", async () => {
    const recorded: RecordedRequest[] = [];
    const client = new HabitifyClient("api-key", recordingCreatedHabitFetch(recorded), "https://habitify.example/v2");
    await client.createHabit({ name: "Read" });
    const body = JSON.parse(recorded[0].body!);
    expect("description" in body).toBe(false);
    expect("goal" in body).toBe(false);
    expect("areaIds" in body).toBe(false);
    expect("timeOfDayIds" in body).toBe(false);
  });

  it("passes goal through verbatim when given", async () => {
    const recorded: RecordedRequest[] = [];
    const client = new HabitifyClient("api-key", recordingCreatedHabitFetch(recorded), "https://habitify.example/v2");
    await client.createHabit({
      name: "Read",
      type: "good",
      description: "Read every day",
      goal: { periodicity: "daily", value: 10, unit: "rep" },
      occurrence: { type: "weekDays", days: [1, 2, 3, 4, 5] },
    });
    const body = JSON.parse(recorded[0].body!);
    expect(body).toEqual({
      name: "Read",
      type: "good",
      description: "Read every day",
      goal: { periodicity: "daily", value: 10, unit: "rep" },
      occurrence: { type: "weekDays", days: [1, 2, 3, 4, 5] },
    });
  });

  it("parses the 201 body into { id, name, unit }, taking unit from the first goal", async () => {
    const client = new HabitifyClient("api-key", createdHabitFetch(), "https://habitify.example/v2");
    const created = await client.createHabit({ name: "Read 10 pages", goal: { periodicity: "daily", value: 10, unit: "rep" } });
    expect(created).toEqual({ id: "habit-new", name: "Read 10 pages", unit: "rep" });
  });

  it("throws on a non-ok response", async () => {
    const client = new HabitifyClient("api-key", recordingFetch([], 422), "https://habitify.example/v2");
    await expect(client.createHabit({ name: "Read" })).rejects.toThrow("Habitify POST /habits failed with status 422");
  });

  it("parses a { data: {...} } wrapped 201 body via the unwrap path", async () => {
    const fetchFn = (async () =>
      new Response(
        JSON.stringify({ data: { id: "habit-wrapped", name: "Read", goals: [{ unit: "rep" }] } }),
        { status: 201 },
      )) as typeof fetch;
    const client = new HabitifyClient("api-key", fetchFn, "https://habitify.example/v2");
    const created = await client.createHabit({ name: "Read" });
    expect(created).toEqual({ id: "habit-wrapped", name: "Read", unit: "rep" });
  });

  it("falls back to listHabits when the 201 body can't be parsed, returning the habit matching the requested name", async () => {
    const recorded: RecordedRequest[] = [];
    let callCount = 0;
    const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
      callCount++;
      const headers = new Headers(init?.headers);
      recorded.push({
        method: init?.method ?? "GET",
        url: String(input),
        body: init?.body === undefined ? undefined : String(init.body),
        apiKey: headers.get("X-API-Key"),
        authorization: headers.get("Authorization"),
      });
      if (callCount === 1) {
        // The unparseable 201 body: a bare confirmation message, no id anywhere.
        return new Response(JSON.stringify({ message: "Habit created successfully" }), { status: 201 });
      }
      return new Response(
        JSON.stringify({
          data: [
            { id: "habit-a", name: "Other habit", goals: [] },
            { id: "habit-b", name: "Pages read", goals: [{ unit: "rep" }] },
          ],
        }),
        { status: 200 },
      );
    }) as typeof fetch;
    const client = new HabitifyClient("api-key", fetchFn, "https://habitify.example/v2");
    const created = await client.createHabit({ name: "Pages read" });

    expect(created).toEqual({ id: "habit-b", name: "Pages read", unit: "rep" });
    expect(recorded).toHaveLength(2);
    expect(recorded[0].method).toBe("POST");
    expect(recorded[0].url).toBe("https://habitify.example/v2/habits");
    expect(recorded[1].method).toBe("GET");
    expect(recorded[1].url).toBe("https://habitify.example/v2/habits");
  });

  it("returns the last match, in list order, when several habits share the requested name", async () => {
    let callCount = 0;
    const fetchFn = (async () => {
      callCount++;
      if (callCount === 1) {
        return new Response(JSON.stringify({ message: "created" }), { status: 201 });
      }
      return new Response(
        JSON.stringify({
          data: [
            { id: "habit-first", name: "Pages read", goals: [] },
            { id: "habit-second", name: "Pages read", goals: [] },
            { id: "habit-third", name: "Pages read", goals: [] },
          ],
        }),
        { status: 200 },
      );
    }) as typeof fetch;
    const client = new HabitifyClient("api-key", fetchFn, "https://habitify.example/v2");
    const created = await client.createHabit({ name: "Pages read" });
    expect(created.id).toBe("habit-third");
  });

  it("throws mentioning the habit was probably created when the fallback lookup finds no match, making no further requests after that", async () => {
    let callCount = 0;
    const fetchFn = (async () => {
      callCount++;
      if (callCount === 1) {
        return new Response(JSON.stringify({ message: "created" }), { status: 201 });
      }
      return new Response(
        JSON.stringify({ data: [{ id: "habit-x", name: "Something else entirely", goals: [] }] }),
        { status: 200 },
      );
    }) as typeof fetch;
    const client = new HabitifyClient("api-key", fetchFn, "https://habitify.example/v2");
    await expect(client.createHabit({ name: "Pages read" })).rejects.toThrow(
      /probably created[\s\S]*GET \/habits/,
    );
    // Exactly the create POST and the fallback GET — no retry of either.
    expect(callCount).toBe(2);
  });

  it("rejects an empty name before making any request", async () => {
    const recorded: RecordedRequest[] = [];
    const client = new HabitifyClient("api-key", recordingFetch(recorded, 201), "https://habitify.example/v2");
    await expect(client.createHabit({ name: "   " })).rejects.toThrow(HabitInputValidationError);
    expect(recorded).toHaveLength(0);
  });

  it("rejects an invalid type before making any request", async () => {
    const recorded: RecordedRequest[] = [];
    const client = new HabitifyClient("api-key", recordingFetch(recorded, 201), "https://habitify.example/v2");
    await expect(
      client.createHabit({ name: "Read", type: "neutral" as unknown as "good" }),
    ).rejects.toThrow(/Invalid habit type "neutral"/);
    expect(recorded).toHaveLength(0);
  });

  it("rejects an invalid goal periodicity before making any request", async () => {
    const recorded: RecordedRequest[] = [];
    const client = new HabitifyClient("api-key", recordingFetch(recorded, 201), "https://habitify.example/v2");
    await expect(
      client.createHabit({ name: "Read", goal: { periodicity: "hourly" as unknown as "daily", value: 1, unit: "rep" } }),
    ).rejects.toThrow(/Invalid goal periodicity "hourly"/);
    expect(recorded).toHaveLength(0);
  });

  it("rejects a non-positive goal value before making any request", async () => {
    const recorded: RecordedRequest[] = [];
    const client = new HabitifyClient("api-key", recordingFetch(recorded, 201), "https://habitify.example/v2");
    await expect(
      client.createHabit({ name: "Read", goal: { periodicity: "daily", value: 0, unit: "rep" } }),
    ).rejects.toThrow(/Invalid goal value 0/);
    expect(recorded).toHaveLength(0);
  });

  it("rejects a non-finite goal value before making any request", async () => {
    const recorded: RecordedRequest[] = [];
    const client = new HabitifyClient("api-key", recordingFetch(recorded, 201), "https://habitify.example/v2");
    await expect(
      client.createHabit({ name: "Read", goal: { periodicity: "daily", value: Infinity, unit: "rep" } }),
    ).rejects.toThrow(/Invalid goal value Infinity/);
    expect(recorded).toHaveLength(0);
  });

  it("rejects an invalid goal unit before making any request", async () => {
    const recorded: RecordedRequest[] = [];
    const client = new HabitifyClient("api-key", recordingFetch(recorded, 201), "https://habitify.example/v2");
    await expect(
      client.createHabit({ name: "Read", goal: { periodicity: "daily", value: 10, unit: "pages" } }),
    ).rejects.toThrow(/Invalid Habitify unitSymbol "pages"/);
    expect(recorded).toHaveLength(0);
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
    const client = new HabitifyClient("api-key", fetchFn, "https://habitify.example/v2");
    await client.upsertTodayLog({ habitId: "habit-1", value: 1, unit: "min" }, "Europe/Berlin", now);
    expect(getRecordedThis()).toBeUndefined();
    expect(getRecordedThis()).not.toBe(client);
  });

  it("invokes fetchFn with this === undefined in listHabits, not the HabitifyClient instance", async () => {
    const { fetchFn, getRecordedThis } = makeThisRecordingFetch({ data: [] });
    const client = new HabitifyClient("api-key", fetchFn, "https://habitify.example/v2");
    await client.listHabits();
    expect(getRecordedThis()).toBeUndefined();
    expect(getRecordedThis()).not.toBe(client);
  });

  it("invokes fetchFn with this === undefined in createHabit, not the HabitifyClient instance", async () => {
    const { fetchFn, getRecordedThis } = makeThisRecordingFetch({ id: "habit-new", name: "Read", goals: [] });
    const client = new HabitifyClient("api-key", fetchFn, "https://habitify.example/v2");
    await client.createHabit({ name: "Read" });
    expect(getRecordedThis()).toBeUndefined();
    expect(getRecordedThis()).not.toBe(client);
  });
});
