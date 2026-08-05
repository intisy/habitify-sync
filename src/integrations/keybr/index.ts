import { todayInTimeZone } from "../../time";
import type { Env, HabitValue, Integration, SourceContext } from "../types";

const KEYBR_SYNC_DATA_URL = "https://www.keybr.com/_/sync/data";

// Confirmed from github.com/aradzie/keybr.com packages/keybr-result-io/lib/header.ts.
const HEADER_SIGNATURE = 0x4b455942; // ASCII "KEYB", written/read as a big-endian uint32.
const HEADER_VERSION = 2;
const HEADER_BYTE_LENGTH = 8; // two big-endian uint32s: signature, then version.

// Thrown only when the reader runs out of bytes mid-value. Kept distinct from a generic parse
// error (e.g. a malformed VLQ) so the record loop below can tell "the stream ended here" (a
// plausible truncated tail, handled gracefully) apart from "the bytes we read don't make sense"
// (a real corruption, which should still throw).
class UnexpectedEndOfDataError extends Error {}

// A minimal big-endian binary reader mirroring @keybr/binary's Reader
// (packages/keybr-binary/lib/io.ts), hand-written here — no npm dependency — to stay aligned with
// keybr's own wire format byte-for-byte.
class KeybrHistoryReader {
  private readonly view: DataView;
  private offset = 0;

  constructor(buffer: Uint8Array) {
    this.view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  }

  remaining(): number {
    return this.view.byteLength - this.offset;
  }

  private requireAvailable(byteLength: number): void {
    if (this.offset + byteLength > this.view.byteLength) {
      throw new UnexpectedEndOfDataError("Premature end of keybr history data");
    }
  }

  getUint8(): number {
    this.requireAvailable(1);
    const value = this.view.getUint8(this.offset);
    this.offset += 1;
    return value;
  }

  getUint32(): number {
    this.requireAvailable(4);
    const value = this.view.getUint32(this.offset, false);
    this.offset += 4;
    return value;
  }

  // Mirrors @keybr/binary's Reader#getUintVlq exactly: a big-endian, 7-bits-per-byte variable
  // length quantity, with the continuation bit (0x80) set on every byte but the last, up to 5
  // bytes for a full 32-bit value. The 5th byte's usable bits are constrained to 4 (0x0f) so the
  // combined 32 bits (7*4 + 4) fit a uint32 with no overflow. Getting this decoding wrong would
  // misalign every field after the first VLQ in a record — and every record after it.
  getUintVlq(): number {
    let value = 0;
    const b0 = this.getUint8();
    value = ((value << 7) | (b0 & 0x7f)) >>> 0;
    if ((b0 & 0x80) === 0) return value;
    const b1 = this.getUint8();
    value = ((value << 7) | (b1 & 0x7f)) >>> 0;
    if ((b1 & 0x80) === 0) return value;
    const b2 = this.getUint8();
    value = ((value << 7) | (b2 & 0x7f)) >>> 0;
    if ((b2 & 0x80) === 0) return value;
    const b3 = this.getUint8();
    value = ((value << 7) | (b3 & 0x7f)) >>> 0;
    if ((b3 & 0x80) === 0) return value;
    const b4 = this.getUint8();
    value = ((value << 7) | (b4 & 0x7f)) >>> 0;
    if ((b4 & 0x80) === 0) {
      if ((b0 & 0x7f) > 15) throw new Error("keybr history VLQ value has too many leading bits");
      return value;
    }
    throw new Error("keybr history VLQ value has too many trailing bits");
  }
}

interface KeybrRecord {
  timestampMs: number;
  activeTypingTimeMs: number;
  charactersTyped: number;
  errors: number;
}

// Reads one "Result" record, matching packages/keybr-result-io/lib/binary.ts's
// writeResult/readResult field order exactly:
//   1. layout id             (uint8)  - which keyboard layout was used; unused here
//   2. text type id          (uint8)  - which practice text type; unused here
//   3. timestamp             (uint32) - seconds since epoch (the source multiplies by 1000 to
//                                       get milliseconds on read; done the same way below)
//   4. active typing time    (VLQ)    - milliseconds, this is result.time
//   5. text length           (VLQ)    - characters typed, result.length
//   6. error count           (VLQ)    - result.errors
//   7. histogram sample count (VLQ)
//   8. per sample (repeated `histogram sample count` times): codePoint, hitCount, missCount,
//      timeToType, each a VLQ — a per-key histogram, not needed for this integration's metric, but
//      every field must still be consumed in order to keep the byte stream aligned for the record
//      (and every record) that follows.
function readRecord(reader: KeybrHistoryReader): KeybrRecord {
  reader.getUint8(); // layout id, unused
  reader.getUint8(); // text type id, unused
  const timestampSeconds = reader.getUint32();
  const activeTypingTimeMs = reader.getUintVlq();
  const charactersTyped = reader.getUintVlq();
  const errors = reader.getUintVlq();
  const histogramSampleCount = reader.getUintVlq();
  for (let sampleIndex = 0; sampleIndex < histogramSampleCount; sampleIndex++) {
    reader.getUintVlq(); // codePoint, unused
    reader.getUintVlq(); // hitCount, unused
    reader.getUintVlq(); // missCount, unused
    reader.getUintVlq(); // timeToType, unused
  }
  return { timestampMs: timestampSeconds * 1000, activeTypingTimeMs, charactersTyped, errors };
}

interface KeybrHistory {
  records: KeybrRecord[];
  truncated: boolean;
}

// Parses the full practice history blob keybr's sync endpoint returns: an 8-byte header
// (signature + version, packages/keybr-result-io/lib/header.ts) followed by records packed
// back-to-back with no length prefix or footer (packages/keybr-result-io/lib/file.ts), read until
// the buffer is exhausted.
function parseKeybrHistory(buffer: Uint8Array): KeybrHistory {
  if (buffer.byteLength < HEADER_BYTE_LENGTH) {
    throw new Error(
      `keybr history body is ${buffer.byteLength} bytes, shorter than the ${HEADER_BYTE_LENGTH}-byte header`,
    );
  }
  const reader = new KeybrHistoryReader(buffer);
  const signature = reader.getUint32();
  if (signature !== HEADER_SIGNATURE) {
    throw new Error(
      `keybr history has signature 0x${signature.toString(16)}, expected 0x${HEADER_SIGNATURE.toString(16)}`,
    );
  }
  const version = reader.getUint32();
  if (version !== HEADER_VERSION) {
    throw new Error(`keybr history has version ${version}, expected ${HEADER_VERSION}`);
  }

  const records: KeybrRecord[] = [];
  let truncated = false;
  while (reader.remaining() > 0) {
    try {
      records.push(readRecord(reader));
    } catch (error) {
      // The server's history file is append-only, so a partial final record is plausible if this
      // request happened to land mid-write. Every record parsed so far is still valid; only the
      // incomplete tail is discarded rather than failing the whole sync.
      if (error instanceof UnexpectedEndOfDataError) {
        truncated = true;
        break;
      }
      throw error;
    }
  }
  return { records, truncated };
}

export const keybrIntegration: Integration = {
  name: "keybr",

  enabled(env: Env): boolean {
    return Boolean(env.KEYBR_PUBLIC_ID && env.HABIT_ID_KEYBR);
  },

  async fetchToday(context: SourceContext): Promise<HabitValue[]> {
    const { env, timeZone, today, fetchFn } = context;
    const url = `${KEYBR_SYNC_DATA_URL}/${encodeURIComponent(env.KEYBR_PUBLIC_ID!)}`;
    // Deliberately no Authorization or Cookie header: this endpoint is completely unauthenticated
    // (verified against the live site and the linked source) — see the integration's README.
    const response = await fetchFn(url);
    if (!response.ok) {
      if (response.status === 404) {
        // There is no credential here to expire, so a 404 is almost certainly a bad id rather than
        // an auth problem — hence a plain Error (not AuthNeededError) naming the likely cause.
        throw new Error(`keybr sync data request returned 404; KEYBR_PUBLIC_ID "${env.KEYBR_PUBLIC_ID}" looks wrong`);
      }
      throw new Error(`keybr sync data request failed with status ${response.status}`);
    }
    const buffer = new Uint8Array(await response.arrayBuffer());
    const { records, truncated } = parseKeybrHistory(buffer);

    let millisecondsPracticed = 0;
    let charactersTyped = 0;
    let errors = 0;
    let lessons = 0;
    for (const record of records) {
      // keybr's own "Statistics for Today" panel groups records by the BROWSER's local date. We
      // deliberately use the worker's configured TIMEZONE instead (via todayInTimeZone, the same
      // helper every other integration uses for "today"), so the two can disagree by a few hours
      // near midnight if the account's timezone doesn't match TIMEZONE — that's expected, and
      // consistent with the rest of this worker rather than a bug.
      if (todayInTimeZone(timeZone, new Date(record.timestampMs)) !== today) continue;
      lessons += 1;
      millisecondsPracticed += record.activeTypingTimeMs;
      charactersTyped += record.charactersTyped;
      errors += record.errors;
    }

    const habitValue: HabitValue = {
      habitId: env.HABIT_ID_KEYBR!,
      // Rounded once, at the end, from the summed milliseconds — never per record.
      value: Math.round(millisecondsPracticed / 60000),
      unit: "min",
      diagnostics: {
        lessons,
        charactersTyped,
        errors,
        millisecondsPracticed,
        totalRecords: records.length,
        truncated,
      },
    };
    return [habitValue];
  },
};
