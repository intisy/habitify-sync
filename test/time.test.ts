import { describe, expect, it } from "vitest";
import { localMidnightEpochSeconds, naiveLocalMidnightEpochSeconds, todayInTimeZone } from "../src/time";

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

describe("naiveLocalMidnightEpochSeconds", () => {
  it("returns local midnight as a naive epoch, unshifted by the zone offset", () => {
    const now = new Date("2026-08-04T10:00:00Z");
    expect(naiveLocalMidnightEpochSeconds("Europe/Berlin", now)).toBe(Date.parse("2026-08-04T00:00:00Z") / 1000);
  });

  it("leads localMidnightEpochSeconds by the summer offset", () => {
    const now = new Date("2026-08-04T10:00:00Z");
    expect(naiveLocalMidnightEpochSeconds("Europe/Berlin", now) - localMidnightEpochSeconds("Europe/Berlin", now)).toBe(
      2 * 3600,
    );
  });

  it("leads localMidnightEpochSeconds by the winter offset", () => {
    const now = new Date("2026-01-15T10:00:00Z");
    expect(naiveLocalMidnightEpochSeconds("Europe/Berlin", now) - localMidnightEpochSeconds("Europe/Berlin", now)).toBe(
      3600,
    );
  });

  it("trails localMidnightEpochSeconds in a negative-offset zone", () => {
    const now = new Date("2026-08-04T16:00:00Z");
    expect(naiveLocalMidnightEpochSeconds("America/New_York", now)).toBe(Date.parse("2026-08-04T00:00:00Z") / 1000);
    expect(
      naiveLocalMidnightEpochSeconds("America/New_York", now) - localMidnightEpochSeconds("America/New_York", now),
    ).toBe(-4 * 3600);
  });
});
