import { describe, expect, it } from "vitest";
import { totalMovingMinutes } from "./activities";

describe("totalMovingMinutes", () => {
  it("sums moving time and converts to whole minutes", () => {
    expect(totalMovingMinutes([{ movingTimeSeconds: 1800 }, { movingTimeSeconds: 900 }])).toBe(45);
  });

  it("rounds to the nearest minute rather than truncating", () => {
    expect(totalMovingMinutes([{ movingTimeSeconds: 100 }])).toBe(2);
    expect(totalMovingMinutes([{ movingTimeSeconds: 89 }])).toBe(1);
  });

  it("returns 0 for no activities", () => {
    expect(totalMovingMinutes([])).toBe(0);
  });
});
