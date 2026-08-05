import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { keybrIntegration } from "./index";
import type { Env, SourceContext } from "../types";

function makeContext(testEnv: Env, fetchFn: typeof fetch): SourceContext {
  return { env: testEnv, timeZone: "Europe/Berlin", today: "2026-08-04", now: new Date("2026-08-04T10:00:00Z"), fetchFn };
}

const HEADER_SIGNATURE = 0x4b455942;
const HEADER_VERSION = 2;

interface FixtureRecord {
  timestampSeconds: number;
  activeTypingTimeMs: number;
  charactersTyped: number;
  errors: number;
}

// A local binary writer mirroring @keybr/binary's Writer (packages/keybr-binary/lib/io.ts) and
// keybr-result-io's file/header/record layout exactly, so these synthetic fixtures are byte-for-byte
// what the real keybr sync endpoint would return. Kept separate from the production reader in
// index.ts so the tests exercise the real parser against independently-constructed bytes rather than
// its own inverse.
class FixtureWriter {
  private readonly bytes: number[] = [];

  putUint8(value: number): this {
    this.bytes.push(value & 0xff);
    return this;
  }

  putUint32(value: number): this {
    this.bytes.push((value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff);
    return this;
  }

  // Mirrors @keybr/binary's Writer#putUintVlq / #putVlq exactly: writes the value's most
  // significant 7-bit group first (only if the value is large enough to need it), setting the
  // continuation bit (0x80) on every byte but the last.
  putUintVlq(value: number): this {
    if (value > 266338304) this.putUint8(((value >>> 28) & 15) | 128);
    if (value > 2080768) this.putUint8(((value >>> 21) & 127) | 128);
    if (value > 16256) this.putUint8(((value >>> 14) & 127) | 128);
    if (value > 127) this.putUint8(((value >>> 7) & 127) | 128);
    this.putUint8(value & 127);
    return this;
  }

  header(): this {
    return this.putUint32(HEADER_SIGNATURE).putUint32(HEADER_VERSION);
  }

  record({ timestampSeconds, activeTypingTimeMs, charactersTyped, errors }: FixtureRecord): this {
    return this.putUint8(0) // layout id, unused by this integration
      .putUint8(0) // text type id, unused by this integration
      .putUint32(timestampSeconds)
      .putUintVlq(activeTypingTimeMs)
      .putUintVlq(charactersTyped)
      .putUintVlq(errors)
      .putUintVlq(0); // zero histogram samples
  }

  rawBytes(...values: number[]): this {
    for (const value of values) this.putUint8(value);
    return this;
  }

  buffer(): Uint8Array {
    return new Uint8Array(this.bytes);
  }
}

function fetchReturning(buffer: Uint8Array): typeof fetch {
  return (async () => new Response(buffer, { status: 200 })) as typeof fetch;
}

function berlinEpochSeconds(isoUtc: string): number {
  return Math.floor(new Date(isoUtc).getTime() / 1000);
}

describe("keybrIntegration", () => {
  it("is disabled unless both KEYBR_PUBLIC_ID and HABIT_ID_KEYBR are set", () => {
    expect(keybrIntegration.enabled({ ...env, KEYBR_PUBLIC_ID: undefined, HABIT_ID_KEYBR: "habit-k" })).toBe(false);
    expect(keybrIntegration.enabled({ ...env, KEYBR_PUBLIC_ID: "pub-123", HABIT_ID_KEYBR: undefined })).toBe(false);
    expect(keybrIntegration.enabled({ ...env, KEYBR_PUBLIC_ID: "pub-123", HABIT_ID_KEYBR: "" })).toBe(false);
    expect(keybrIntegration.enabled({ ...env, KEYBR_PUBLIC_ID: "pub-123", HABIT_ID_KEYBR: "habit-k" })).toBe(true);
  });

  it("requests the public id's sync data URL with no Authorization or Cookie header", async () => {
    const buffer = new FixtureWriter().header().buffer();
    const requested: string[] = [];
    let capturedInit: RequestInit | undefined;
    const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requested.push(String(input));
      capturedInit = init;
      return new Response(buffer, { status: 200 });
    }) as typeof fetch;

    const testEnv: Env = { ...env, KEYBR_PUBLIC_ID: "pub-abc123", HABIT_ID_KEYBR: "habit-k" };
    await keybrIntegration.fetchToday(makeContext(testEnv, fetchFn));

    expect(requested[0]).toBe("https://www.keybr.com/_/sync/data/pub-abc123");
    // This endpoint must stay unauthenticated: no Authorization header, no Cookie header, at all.
    const headers = new Headers(capturedInit?.headers);
    expect(headers.has("Authorization")).toBe(false);
    expect(headers.has("Cookie")).toBe(false);
  });

  it("sums only today's records, using the context timezone rather than UTC", async () => {
    const writer = new FixtureWriter().header();
    // A different, earlier day entirely — must not contribute.
    writer.record({
      timestampSeconds: berlinEpochSeconds("2026-08-01T12:00:00Z"),
      activeTypingTimeMs: 999_000,
      charactersTyped: 500,
      errors: 50,
    });
    // Just after Berlin local midnight (2026-08-04T01:30 CEST = 2026-08-03T23:30Z): its UTC
    // calendar date is 2026-08-03, but its Berlin local date is 2026-08-04 — proving the boundary
    // follows the timezone, not the UTC date.
    writer.record({
      timestampSeconds: berlinEpochSeconds("2026-08-03T23:30:00Z"),
      activeTypingTimeMs: 60_000,
      charactersTyped: 100,
      errors: 1,
    });
    // Just before Berlin local midnight (2026-08-04T23:30 CEST = 2026-08-04T21:30Z): still today.
    writer.record({
      timestampSeconds: berlinEpochSeconds("2026-08-04T21:30:00Z"),
      activeTypingTimeMs: 120_000,
      charactersTyped: 200,
      errors: 2,
    });
    // Just after the FOLLOWING Berlin local midnight (2026-08-05T00:30 CEST = 2026-08-04T22:30Z):
    // its UTC calendar date is still 2026-08-04, but its Berlin local date is 2026-08-05 — must
    // NOT contribute. A UTC-date implementation would incorrectly include this one.
    writer.record({
      timestampSeconds: berlinEpochSeconds("2026-08-04T22:30:00Z"),
      activeTypingTimeMs: 888_000,
      charactersTyped: 800,
      errors: 80,
    });

    const testEnv: Env = { ...env, KEYBR_PUBLIC_ID: "pub-abc123", HABIT_ID_KEYBR: "habit-k" };
    const values = await keybrIntegration.fetchToday(makeContext(testEnv, fetchReturning(writer.buffer())));

    // Only the two Berlin-local-today records contribute: 60_000 + 120_000 = 180_000ms = 3 minutes.
    expect(values).toEqual([
      {
        habitId: "habit-k",
        value: 3,
        unit: "min",
        diagnostics: {
          lessons: 2,
          charactersTyped: 300,
          errors: 3,
          millisecondsPracticed: 180_000,
          totalRecords: 4,
          truncated: false,
        },
      },
    ]);
  });

  it("round-trips a multi-byte VLQ time value requiring continuation bytes", async () => {
    // 2_000_000ms exceeds the single-byte (127) and two-byte (16_256) VLQ thresholds, so encoding
    // it requires 3 continuation bytes worth of groups to round-trip correctly.
    const largeTimeMs = 2_000_000;
    const writer = new FixtureWriter().header().record({
      timestampSeconds: berlinEpochSeconds("2026-08-04T10:00:00Z"),
      activeTypingTimeMs: largeTimeMs,
      charactersTyped: 4000,
      errors: 10,
    });

    const testEnv: Env = { ...env, KEYBR_PUBLIC_ID: "pub-abc123", HABIT_ID_KEYBR: "habit-k" };
    const values = await keybrIntegration.fetchToday(makeContext(testEnv, fetchReturning(writer.buffer())));

    expect(values[0].value).toBe(Math.round(largeTimeMs / 60000));
    expect(values[0].diagnostics?.millisecondsPracticed).toBe(largeTimeMs);
  });

  it("rounds only once, after summing, not per record", async () => {
    // Three records at 25_000ms each sum to 75_000ms = 1.25 minutes, which rounds to 1. Rounding
    // each record individually first would give round(25_000 / 60_000) = 0 for every record,
    // summing to 0 — a materially different, wrong answer.
    const writer = new FixtureWriter().header();
    for (let i = 0; i < 3; i++) {
      writer.record({
        timestampSeconds: berlinEpochSeconds("2026-08-04T10:00:00Z"),
        activeTypingTimeMs: 25_000,
        charactersTyped: 40,
        errors: 0,
      });
    }

    const testEnv: Env = { ...env, KEYBR_PUBLIC_ID: "pub-abc123", HABIT_ID_KEYBR: "habit-k" };
    const values = await keybrIntegration.fetchToday(makeContext(testEnv, fetchReturning(writer.buffer())));

    expect(values[0].value).toBe(1);
    expect(values[0].diagnostics?.millisecondsPracticed).toBe(75_000);
  });

  it("treats an empty history (header only) as zero, not an error", async () => {
    const buffer = new FixtureWriter().header().buffer();
    const testEnv: Env = { ...env, KEYBR_PUBLIC_ID: "pub-abc123", HABIT_ID_KEYBR: "habit-k" };
    const values = await keybrIntegration.fetchToday(makeContext(testEnv, fetchReturning(buffer)));

    expect(values).toEqual([
      {
        habitId: "habit-k",
        value: 0,
        unit: "min",
        diagnostics: {
          lessons: 0,
          charactersTyped: 0,
          errors: 0,
          millisecondsPracticed: 0,
          totalRecords: 0,
          truncated: false,
        },
      },
    ]);
  });

  it("throws a descriptive error for a body shorter than the header", async () => {
    const buffer = new Uint8Array([0x4b, 0x45, 0x59]); // 3 bytes, header needs 8
    const testEnv: Env = { ...env, KEYBR_PUBLIC_ID: "pub-abc123", HABIT_ID_KEYBR: "habit-k" };
    await expect(keybrIntegration.fetchToday(makeContext(testEnv, fetchReturning(buffer)))).rejects.toThrow(
      /shorter than the 8-byte header/,
    );
  });

  it("throws a descriptive error for a bad signature", async () => {
    const buffer = new FixtureWriter().putUint32(0xdeadbeef).putUint32(HEADER_VERSION).buffer();
    const testEnv: Env = { ...env, KEYBR_PUBLIC_ID: "pub-abc123", HABIT_ID_KEYBR: "habit-k" };
    await expect(keybrIntegration.fetchToday(makeContext(testEnv, fetchReturning(buffer)))).rejects.toThrow(
      /signature 0xdeadbeef/,
    );
  });

  it("throws a descriptive error for an unsupported version", async () => {
    const buffer = new FixtureWriter().putUint32(HEADER_SIGNATURE).putUint32(99).buffer();
    const testEnv: Env = { ...env, KEYBR_PUBLIC_ID: "pub-abc123", HABIT_ID_KEYBR: "habit-k" };
    await expect(keybrIntegration.fetchToday(makeContext(testEnv, fetchReturning(buffer)))).rejects.toThrow(
      /version 99, expected 2/,
    );
  });

  it("ignores a truncated trailing record, counts earlier records, and reports truncated: true", async () => {
    const writer = new FixtureWriter().header().record({
      timestampSeconds: berlinEpochSeconds("2026-08-04T10:00:00Z"),
      activeTypingTimeMs: 30_000,
      charactersTyped: 50,
      errors: 1,
    });
    // A partial next record: layout id, text type id, and only 2 of the 4 timestamp bytes, then
    // nothing more — simulating a fetch that landed mid-write on keybr's append-only file.
    writer.rawBytes(0, 0, 0x00, 0x01);

    const testEnv: Env = { ...env, KEYBR_PUBLIC_ID: "pub-abc123", HABIT_ID_KEYBR: "habit-k" };
    const values = await keybrIntegration.fetchToday(makeContext(testEnv, fetchReturning(writer.buffer())));

    expect(values[0].value).toBe(1); // 30_000ms rounds to 1 minute
    expect(values[0].diagnostics).toMatchObject({ lessons: 1, totalRecords: 1, truncated: true });
  });

  it("throws naming KEYBR_PUBLIC_ID on a 404", async () => {
    const fetchFn = (async () => new Response("not found", { status: 404 })) as typeof fetch;
    const testEnv: Env = { ...env, KEYBR_PUBLIC_ID: "pub-wrong", HABIT_ID_KEYBR: "habit-k" };
    await expect(keybrIntegration.fetchToday(makeContext(testEnv, fetchFn))).rejects.toThrow(/KEYBR_PUBLIC_ID/);
  });

  it("throws naming the status on another non-ok response", async () => {
    const fetchFn = (async () => new Response("boom", { status: 500 })) as typeof fetch;
    const testEnv: Env = { ...env, KEYBR_PUBLIC_ID: "pub-abc123", HABIT_ID_KEYBR: "habit-k" };
    await expect(keybrIntegration.fetchToday(makeContext(testEnv, fetchFn))).rejects.toThrow(/status 500/);
  });

  it("carries lessons, charactersTyped, errors, and totalRecords in diagnostics", async () => {
    const writer = new FixtureWriter().header();
    writer.record({
      timestampSeconds: berlinEpochSeconds("2026-08-04T10:00:00Z"),
      activeTypingTimeMs: 45_000,
      charactersTyped: 120,
      errors: 3,
    });
    writer.record({
      timestampSeconds: berlinEpochSeconds("2026-08-04T11:00:00Z"),
      activeTypingTimeMs: 30_000,
      charactersTyped: 80,
      errors: 2,
    });
    // An old record, outside today, still counts toward totalRecords (whole-history size) but not
    // toward lessons/charactersTyped/errors.
    writer.record({
      timestampSeconds: berlinEpochSeconds("2026-01-01T10:00:00Z"),
      activeTypingTimeMs: 999_000,
      charactersTyped: 999,
      errors: 99,
    });

    const testEnv: Env = { ...env, KEYBR_PUBLIC_ID: "pub-abc123", HABIT_ID_KEYBR: "habit-k" };
    const values = await keybrIntegration.fetchToday(makeContext(testEnv, fetchReturning(writer.buffer())));

    expect(values[0].diagnostics).toMatchObject({
      lessons: 2,
      charactersTyped: 200,
      errors: 5,
      totalRecords: 3,
    });
  });
});
