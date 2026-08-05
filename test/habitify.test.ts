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

describe("HabitifyClient.writeTodayValue", () => {
  // 2026-08-04T23:30 UTC is 2026-08-05T01:30 in Europe/Berlin (UTC+2 under DST) — past UTC
  // midnight but not yet past Berlin midnight, so this proves todayInTimeZone (local calendar
  // date) is used for targetDate, not a UTC-derived date, which would wrongly read 2026-08-04.
  const now = new Date("2026-08-04T23:30:00Z");
  const habit = { habitId: "habit-1", value: 0, unit: "min" };

  it("posts the positive difference when target > current, and makes no undo call", async () => {
    const recorded: RecordedRequest[] = [];
    const client = new HabitifyClient("api-key", recordingFetch(recorded), "https://habitify.example/v2");
    const result = await client.writeTodayValue(habit, "min", 42, 10, "Europe/Berlin", now);

    expect(recorded).toHaveLength(1);
    expect(recorded[0].method).toBe("POST");
    expect(recorded[0].url).toBe("https://habitify.example/v2/habits/habit-1/logs");
    expect(recorded[0].apiKey).toBe("api-key");
    expect(recorded[0].authorization).toBeNull();
    expect(JSON.parse(recorded[0].body!)).toEqual({
      unitSymbol: "min",
      value: 32,
      targetDate: "2026-08-05",
    });
    expect(result).toEqual({ difference: 32, usedUndoFallback: false });
  });

  // This is the case that fixes the live inflation bug: Pages read stood at 104 with a true
  // target of 8, and posting -96 is what brings it back down without ever calling the broken
  // undo endpoint.
  it("posts the negative difference when target < current", async () => {
    const recorded: RecordedRequest[] = [];
    const client = new HabitifyClient("api-key", recordingFetch(recorded), "https://habitify.example/v2");
    const result = await client.writeTodayValue(habit, "rep", 8, 104, "Europe/Berlin", now);

    expect(recorded).toHaveLength(1);
    expect(recorded[0].url).toBe("https://habitify.example/v2/habits/habit-1/logs");
    expect(JSON.parse(recorded[0].body!)).toEqual({
      unitSymbol: "rep",
      value: -96,
      targetDate: "2026-08-05",
    });
    expect(result).toEqual({ difference: -96, usedUndoFallback: false });
  });

  it("makes no request at all when target equals current", async () => {
    const recorded: RecordedRequest[] = [];
    const client = new HabitifyClient("api-key", recordingFetch(recorded), "https://habitify.example/v2");
    const result = await client.writeTodayValue(habit, "min", 10, 10, "Europe/Berlin", now);

    expect(recorded).toHaveLength(0);
    expect(result).toEqual({ difference: 0, usedUndoFallback: false });
  });

  it("makes no request when the difference is within the convergence epsilon", async () => {
    const recorded: RecordedRequest[] = [];
    const client = new HabitifyClient("api-key", recordingFetch(recorded), "https://habitify.example/v2");
    const result = await client.writeTodayValue(habit, "min", 10.003, 10, "Europe/Berlin", now);

    expect(recorded).toHaveLength(0);
    expect(result.usedUndoFallback).toBe(false);
  });

  it("throws on a non-ok response from the log-post call when the difference is positive", async () => {
    const client = new HabitifyClient("api-key", recordingFetch([], 422), "https://habitify.example/v2");
    await expect(
      client.writeTodayValue(habit, "min", 42, 10, "Europe/Berlin", now),
    ).rejects.toThrow("Habitify POST /habits/habit-1/logs failed with status 422");
  });

  it("falls back to undo-then-post-total when a negative post is rejected with a 4xx", async () => {
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
      // 1st call: the direct negative post, rejected with a 422. 2nd call: undo (best-effort,
      // succeeds but is assumed a no-op). 3rd call: the full-total post, succeeds.
      if (callCount === 1) return new Response("rejected", { status: 422 });
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    const client = new HabitifyClient("api-key", fetchFn, "https://habitify.example/v2");

    const result = await client.writeTodayValue(habit, "rep", 8, 104, "Europe/Berlin", now);

    expect(recorded).toHaveLength(3);
    expect(recorded[0].url).toBe("https://habitify.example/v2/habits/habit-1/logs");
    expect(JSON.parse(recorded[0].body!).value).toBe(-96);
    expect(recorded[1].url).toBe("https://habitify.example/v2/habits/habit-1/logs/undo");
    expect(JSON.parse(recorded[1].body!)).toEqual({ targetDate: "2026-08-05" });
    expect(recorded[2].url).toBe("https://habitify.example/v2/habits/habit-1/logs");
    expect(JSON.parse(recorded[2].body!)).toEqual({ unitSymbol: "rep", value: 8, targetDate: "2026-08-05" });
    expect(result).toEqual({ difference: -96, usedUndoFallback: true });
  });

  it("does not fall back when a positive difference is rejected with a 4xx", async () => {
    const recorded: RecordedRequest[] = [];
    const client = new HabitifyClient("api-key", recordingFetch(recorded, 422), "https://habitify.example/v2");
    await expect(client.writeTodayValue(habit, "rep", 20, 5, "Europe/Berlin", now)).rejects.toThrow(
      "failed with status 422",
    );
    // Only the single rejected attempt — no undo, no second post.
    expect(recorded).toHaveLength(1);
  });

  it("does not fall back when a negative difference is rejected with a 5xx", async () => {
    const recorded: RecordedRequest[] = [];
    const client = new HabitifyClient("api-key", recordingFetch(recorded, 500), "https://habitify.example/v2");
    await expect(client.writeTodayValue(habit, "rep", 8, 104, "Europe/Berlin", now)).rejects.toThrow(
      "failed with status 500",
    );
    // A 5xx is treated as a transient outage, not a rejection of the negative value — no fallback.
    expect(recorded).toHaveLength(1);
  });

  it("rejects an invalid unitSymbol before making any request", async () => {
    const recorded: RecordedRequest[] = [];
    const client = new HabitifyClient("api-key", recordingFetch(recorded), "https://habitify.example/v2");
    await expect(
      client.writeTodayValue(habit, "pages", 42, 10, "Europe/Berlin", now),
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

describe("HabitifyClient.listHabitsRaw", () => {
  it("sends the correct /v2/habits URL and the X-API-Key header, not Authorization", async () => {
    const recorded: RecordedRequest[] = [];
    const client = new HabitifyClient("api-key", recordingFetch(recorded), "https://habitify.example/v2");
    await client.listHabitsRaw();

    expect(recorded).toHaveLength(1);
    expect(recorded[0].method).toBe("GET");
    expect(recorded[0].url).toBe("https://habitify.example/v2/habits");
    expect(recorded[0].apiKey).toBe("api-key");
    expect(recorded[0].authorization).toBeNull();
  });

  it("returns the response body verbatim, including fields the trimmed parser drops", async () => {
    const rawBody = {
      data: [
        {
          id: "habit-1",
          name: "Read",
          icon: "book",
          colorHex: "#ffffff",
          type: "good",
          description: "Read every day",
          occurrence: { type: "daily" },
          area: "personal",
          timeOfDay: "anytime",
          archived: false,
          startDate: "2026-01-01T00:00:00Z",
          createdAt: "2026-01-01T00:00:00Z",
          goals: [{ id: "goal-1", periodicity: "daily", value: 1, unit: "rep" }],
        },
      ],
    };
    const client = new HabitifyClient("api-key", jsonFetch(rawBody), "https://habitify.example/v2");
    const result = await client.listHabitsRaw();
    expect(result).toEqual(rawBody);
  });

  it("throws on a non-ok response", async () => {
    const client = new HabitifyClient("api-key", recordingFetch([], 401), "https://habitify.example/v2");
    await expect(client.listHabitsRaw()).rejects.toThrow("Habitify GET /habits failed with status 401");
  });
});

describe("HabitifyClient.getJournalRaw", () => {
  it("requests /v2/habits/journal with no query string when no date is given", async () => {
    const recorded: RecordedRequest[] = [];
    const client = new HabitifyClient("api-key", recordingFetch(recorded), "https://habitify.example/v2");
    await client.getJournalRaw();

    expect(recorded).toHaveLength(1);
    expect(recorded[0].method).toBe("GET");
    expect(recorded[0].url).toBe("https://habitify.example/v2/habits/journal");
    expect(recorded[0].apiKey).toBe("api-key");
    expect(recorded[0].authorization).toBeNull();
  });

  it("appends ?date=<date> when a date is given", async () => {
    const recorded: RecordedRequest[] = [];
    const client = new HabitifyClient("api-key", recordingFetch(recorded), "https://habitify.example/v2");
    await client.getJournalRaw("2026-08-05");

    expect(recorded).toHaveLength(1);
    expect(recorded[0].url).toBe("https://habitify.example/v2/habits/journal?date=2026-08-05");
  });

  it("rejects a malformed date before making any request", async () => {
    const recorded: RecordedRequest[] = [];
    const client = new HabitifyClient("api-key", recordingFetch(recorded), "https://habitify.example/v2");
    await expect(client.getJournalRaw("not-a-date")).rejects.toThrow(HabitInputValidationError);
    await expect(client.getJournalRaw("not-a-date")).rejects.toThrow(/YYYY-MM-DD/);
    expect(recorded).toHaveLength(0);
  });

  it("returns the response body verbatim", async () => {
    const rawBody = {
      data: [{ id: "habit-1", name: "Read", status: "completed", progress: { current: 1, target: 1 } }],
    };
    const client = new HabitifyClient("api-key", jsonFetch(rawBody), "https://habitify.example/v2");
    const result = await client.getJournalRaw("2026-08-05");
    expect(result).toEqual(rawBody);
  });

  it("throws on a non-ok response", async () => {
    const client = new HabitifyClient("api-key", recordingFetch([], 401), "https://habitify.example/v2");
    await expect(client.getJournalRaw()).rejects.toThrow("Habitify GET /habits/journal failed with status 401");
  });
});

describe("HabitifyClient.getCurrentValuesByHabitId", () => {
  it("parses a { data: [...] } journal into habitId -> progress.current", async () => {
    const client = new HabitifyClient(
      "api-key",
      jsonFetch({
        data: [
          { id: "habit-1", name: "Pages read", progress: { current: 104, target: 8 } },
          { id: "habit-2", name: "Coding time", progress: { current: 1683, target: 187 } },
        ],
      }),
      "https://habitify.example/v2",
    );
    const currentValuesById = await client.getCurrentValuesByHabitId("2026-08-05");
    expect(currentValuesById.get("habit-1")).toBe(104);
    expect(currentValuesById.get("habit-2")).toBe(1683);
  });

  it("tolerates a bare array response", async () => {
    const client = new HabitifyClient(
      "api-key",
      jsonFetch([{ id: "habit-1", progress: { current: 5 } }]),
      "https://habitify.example/v2",
    );
    const currentValuesById = await client.getCurrentValuesByHabitId("2026-08-05");
    expect(currentValuesById.get("habit-1")).toBe(5);
  });

  it("omits an entry with no id, or no numeric progress.current", async () => {
    const client = new HabitifyClient(
      "api-key",
      jsonFetch({
        data: [
          { name: "No id", progress: { current: 1 } },
          { id: "habit-checkin-only", name: "Check-in habit" },
          { id: "habit-bad-progress", progress: { current: "not-a-number" } },
          { id: "habit-good", progress: { current: 3 } },
        ],
      }),
      "https://habitify.example/v2",
    );
    const currentValuesById = await client.getCurrentValuesByHabitId("2026-08-05");
    expect(currentValuesById.size).toBe(1);
    expect(currentValuesById.get("habit-good")).toBe(3);
  });

  it("propagates a failed journal read", async () => {
    const client = new HabitifyClient("api-key", recordingFetch([], 401), "https://habitify.example/v2");
    await expect(client.getCurrentValuesByHabitId("2026-08-05")).rejects.toThrow(
      "Habitify GET /habits/journal failed with status 401",
    );
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

  it("invokes fetchFn with this === undefined in writeTodayValue, not the HabitifyClient instance", async () => {
    const { fetchFn, getRecordedThis } = makeThisRecordingFetch({});
    const client = new HabitifyClient("api-key", fetchFn, "https://habitify.example/v2");
    await client.writeTodayValue({ habitId: "habit-1", value: 0, unit: "min" }, "min", 42, 10, "Europe/Berlin", now);
    expect(getRecordedThis()).toBeUndefined();
    expect(getRecordedThis()).not.toBe(client);
  });

  it("invokes fetchFn with this === undefined in getCurrentValuesByHabitId, not the HabitifyClient instance", async () => {
    const { fetchFn, getRecordedThis } = makeThisRecordingFetch({ data: [] });
    const client = new HabitifyClient("api-key", fetchFn, "https://habitify.example/v2");
    await client.getCurrentValuesByHabitId("2026-08-05");
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

  it("invokes fetchFn with this === undefined in listHabitsRaw, not the HabitifyClient instance", async () => {
    const { fetchFn, getRecordedThis } = makeThisRecordingFetch({ data: [] });
    const client = new HabitifyClient("api-key", fetchFn, "https://habitify.example/v2");
    await client.listHabitsRaw();
    expect(getRecordedThis()).toBeUndefined();
    expect(getRecordedThis()).not.toBe(client);
  });

  it("invokes fetchFn with this === undefined in getJournalRaw, not the HabitifyClient instance", async () => {
    const { fetchFn, getRecordedThis } = makeThisRecordingFetch({ data: [] });
    const client = new HabitifyClient("api-key", fetchFn, "https://habitify.example/v2");
    await client.getJournalRaw();
    expect(getRecordedThis()).toBeUndefined();
    expect(getRecordedThis()).not.toBe(client);
  });
});
