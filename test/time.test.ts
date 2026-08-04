import { describe, expect, it } from "vitest";
import { isoDayRange, localMidnightEpochSeconds, todayInTimeZone } from "../src/time";

describe("todayInTimeZone", () => {
  it("returns the local date for Europe/Berlin", () => {
    expect(todayInTimeZone("Europe/Berlin", new Date("2026-08-04T10:00:00Z"))).toBe("2026-08-04");
  });

  it("rolls to the next day when local time crosses midnight before UTC", () => {
    expect(todayInTimeZone("Europe/Berlin", new Date("2026-08-04T23:30:00Z"))).toBe("2026-08-05");
  });
});

describe("localMidnightEpochSeconds", () => {
  it("returns 22:00 UTC of the previous day during Berlin summer time", () => {
    const epoch = localMidnightEpochSeconds("Europe/Berlin", new Date("2026-08-04T10:00:00Z"));
    expect(epoch).toBe(Date.parse("2026-08-03T22:00:00Z") / 1000);
  });

  it("returns 23:00 UTC of the previous day during Berlin winter time", () => {
    const epoch = localMidnightEpochSeconds("Europe/Berlin", new Date("2026-01-15T10:00:00Z"));
    expect(epoch).toBe(Date.parse("2026-01-14T23:00:00Z") / 1000);
  });

  it("returns correct offset on spring-forward DST transition day", () => {
    const epoch = localMidnightEpochSeconds("Europe/Berlin", new Date("2026-03-29T10:00:00Z"));
    expect(epoch).toBe(Date.parse("2026-03-28T23:00:00Z") / 1000);
  });

  it("returns correct offset on fall-back DST transition day", () => {
    const epoch = localMidnightEpochSeconds("Europe/Berlin", new Date("2026-10-25T12:00:00Z"));
    expect(epoch).toBe(Date.parse("2026-10-24T22:00:00Z") / 1000);
  });
});

describe("isoDayRange", () => {
  it("returns start and end of day with the local offset", () => {
    const range = isoDayRange("Europe/Berlin", new Date("2026-08-04T10:00:00Z"));
    expect(range.start).toBe("2026-08-04T00:00:00+02:00");
    expect(range.end).toBe("2026-08-04T23:59:59+02:00");
  });

  it("handles spring-forward DST transition with different start and end offsets", () => {
    const range = isoDayRange("Europe/Berlin", new Date("2026-03-29T10:00:00Z"));
    expect(range.start).toBe("2026-03-29T00:00:00+01:00");
    expect(range.end).toBe("2026-03-29T23:59:59+02:00");
  });
});
