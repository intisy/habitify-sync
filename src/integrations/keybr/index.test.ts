import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { keybrIntegration } from "./index";
import { SettingsResolver } from "../../settings";
import type { Env, SourceContext } from "../types";

function makeSettings(testEnv: Env): SettingsResolver {
  return new SettingsResolver(testEnv, testEnv.STATE, "keybr", keybrIntegration.settings);
}

function makeContext(testEnv: Env, fetchFn: typeof fetch): SourceContext {
  return {
    env: testEnv,
    timeZone: "Europe/Berlin",
    today: "2026-08-04",
    now: new Date("2026-08-04T10:00:00Z"),
    fetchFn,
    settings: makeSettings(testEnv),
  };
}

const HEADER_SIGNATURE = 0x4b455942;
const HEADER_VERSION = 2;

interface FixtureHistogramSample {
  codePoint: number;
  hitCount: number;
  missCount: number;
  timeToType: number;
}

interface FixtureRecord {
  timestampSeconds: number;
  activeTypingTimeMs: number;
  charactersTyped: number;
  errors: number;
  samples?: FixtureHistogramSample[];
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

  record({ timestampSeconds, activeTypingTimeMs, charactersTyped, errors, samples = [] }: FixtureRecord): this {
    this.putUint8(0) // layout id, unused by this integration
      .putUint8(0) // text type id, unused by this integration
      .putUint32(timestampSeconds)
      .putUintVlq(activeTypingTimeMs)
      .putUintVlq(charactersTyped)
      .putUintVlq(errors)
      .putUintVlq(samples.length);
    for (const sample of samples) {
      this.putUintVlq(sample.codePoint).putUintVlq(sample.hitCount).putUintVlq(sample.missCount).putUintVlq(sample.timeToType);
    }
    return this;
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
  it("is disabled unless both KEYBR_PUBLIC_ID and HABIT_ID_KEYBR are set", async () => {
    expect(await makeSettings({ ...env, KEYBR_PUBLIC_ID: undefined, HABIT_ID_KEYBR: "habit-k" }).isEnabled()).toBe(false);
    expect(await makeSettings({ ...env, KEYBR_PUBLIC_ID: "pub-123", HABIT_ID_KEYBR: undefined }).isEnabled()).toBe(false);
    expect(await makeSettings({ ...env, KEYBR_PUBLIC_ID: "pub-123", HABIT_ID_KEYBR: "" }).isEnabled()).toBe(false);
    expect(await makeSettings({ ...env, KEYBR_PUBLIC_ID: "pub-123", HABIT_ID_KEYBR: "habit-k" }).isEnabled()).toBe(true);
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

  it("treats a completely empty (0-byte) body as an empty history, not an error", async () => {
    // Upstream's own readStructuredContent treats reader.remaining() === 0 as a legitimate empty
    // case, distinct from a body that's merely too short for the header (1-7 bytes, still an
    // error). A 0-byte body is what a brand new keybr account with zero completed exercises
    // would plausibly return.
    const buffer = new Uint8Array(0);
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

  it("skips a non-empty histogram sample list exactly, keeping the next record aligned", async () => {
    const writer = new FixtureWriter().header();
    writer.record({
      timestampSeconds: berlinEpochSeconds("2026-08-04T09:00:00Z"),
      activeTypingTimeMs: 40_000,
      charactersTyped: 90,
      errors: 4,
      samples: [
        { codePoint: 97, hitCount: 12, missCount: 1, timeToType: 180 },
        // A multi-byte VLQ sample value, to exercise the continuation-byte path inside the
        // histogram skip itself, not just in the top-level record fields.
        { codePoint: 98, hitCount: 200_000, missCount: 0, timeToType: 2_000_000 },
        { codePoint: 99, hitCount: 3, missCount: 2, timeToType: 240 },
      ],
    });
    writer.record({
      timestampSeconds: berlinEpochSeconds("2026-08-04T10:00:00Z"),
      activeTypingTimeMs: 55_000,
      charactersTyped: 130,
      errors: 6,
    });

    const testEnv: Env = { ...env, KEYBR_PUBLIC_ID: "pub-abc123", HABIT_ID_KEYBR: "habit-k" };
    const values = await keybrIntegration.fetchToday(makeContext(testEnv, fetchReturning(writer.buffer())));

    // If the histogram skip consumed the wrong number of bytes, the second record's fields would
    // be read from the wrong offset — producing garbage totals (or a thrown parse error) instead
    // of two clean lessons summing exactly 95_000ms and 220 characters. This is the proof that the
    // skip consumed precisely the right number of bytes for a non-trivial sample count.
    expect(values[0].diagnostics).toMatchObject({
      lessons: 2,
      charactersTyped: 220,
      errors: 10,
      millisecondsPracticed: 95_000,
      totalRecords: 2,
      truncated: false,
    });
  });

  it("uses a DST-aware 23-hour window on Berlin's spring-forward day, not a naive +86400s window", async () => {
    // Europe/Berlin's local day for 2026-03-29 runs from 2026-03-28T23:00:00Z (local midnight,
    // still CET/UTC+1) to 2026-03-29T22:00:00Z (the FOLLOWING local midnight, already CEST/UTC+2)
    // — only 23 hours, because clocks jump forward an hour during this day (see
    // test/time.test.ts's own spring-forward cases for the same boundary). A naive
    // `start + 86400 seconds` window would instead end an hour too late, at 2026-03-29T23:00:00Z.
    const writer = new FixtureWriter().header();
    // Exactly at the true window's start — must be included (inclusive boundary, nothing dropped).
    writer.record({
      timestampSeconds: berlinEpochSeconds("2026-03-28T23:00:00Z"),
      activeTypingTimeMs: 60_000,
      charactersTyped: 100,
      errors: 1,
    });
    // Within the true window, close to its true end.
    writer.record({
      timestampSeconds: berlinEpochSeconds("2026-03-29T21:30:00Z"),
      activeTypingTimeMs: 120_000,
      charactersTyped: 200,
      errors: 2,
    });
    // Past the TRUE end (2026-03-29T22:00:00Z) but still before a naive +86400s end
    // (2026-03-29T23:00:00Z): this record already belongs to the NEXT local day (2026-03-30) and
    // must be excluded. A naive fixed-seconds window would wrongly double-count it as today.
    writer.record({
      timestampSeconds: berlinEpochSeconds("2026-03-29T22:30:00Z"),
      activeTypingTimeMs: 999_000,
      charactersTyped: 900,
      errors: 90,
    });

    const testEnv: Env = { ...env, KEYBR_PUBLIC_ID: "pub-abc123", HABIT_ID_KEYBR: "habit-k" };
    const context: SourceContext = {
      env: testEnv,
      timeZone: "Europe/Berlin",
      today: "2026-03-29",
      now: new Date("2026-03-29T10:00:00Z"),
      fetchFn: fetchReturning(writer.buffer()),
      settings: makeSettings(testEnv),
    };
    const values = await keybrIntegration.fetchToday(context);

    // Only the first two records fall in the true 23-hour window: 60_000 + 120_000 = 180_000ms =
    // 3 minutes, 2 lessons. Against a naive +86400s window the third record would also be
    // counted, giving 3 lessons and a much larger, wrong total — so this assertion would fail
    // under that naive implementation.
    expect(values[0].value).toBe(3);
    expect(values[0].diagnostics).toMatchObject({ lessons: 2, totalRecords: 3 });
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
