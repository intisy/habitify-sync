export function todayInTimeZone(timeZone: string, now: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

export function timeZoneOffsetMinutes(timeZone: string, at: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(at);
  const part = (type: string) => Number(parts.find((candidate) => candidate.type === type)!.value);
  const asUtc = Date.UTC(
    part("year"),
    part("month") - 1,
    part("day"),
    part("hour") % 24,
    part("minute"),
    part("second"),
  );
  return Math.round((asUtc - at.getTime()) / 60000);
}

export function localMidnightEpochSeconds(timeZone: string, now: Date): number {
  const today = todayInTimeZone(timeZone, now);
  const utcMidnightMs = Date.parse(`${today}T00:00:00Z`);
  // Offset sampled at noon local date avoids ambiguity on DST switch days.
  const offsetMinutes = timeZoneOffsetMinutes(timeZone, new Date(utcMidnightMs + 12 * 3600 * 1000));
  return utcMidnightMs / 1000 - offsetMinutes * 60;
}

function offsetSuffix(offsetMinutes: number): string {
  const sign = offsetMinutes < 0 ? "-" : "+";
  const absolute = Math.abs(offsetMinutes);
  const hours = String(Math.floor(absolute / 60)).padStart(2, "0");
  const minutes = String(absolute % 60).padStart(2, "0");
  return `${sign}${hours}:${minutes}`;
}

export function isoDayRange(timeZone: string, now: Date): { start: string; end: string } {
  const today = todayInTimeZone(timeZone, now);
  const noonUtc = new Date(Date.parse(`${today}T12:00:00Z`));
  const suffix = offsetSuffix(timeZoneOffsetMinutes(timeZone, noonUtc));
  return {
    start: `${today}T00:00:00${suffix}`,
    end: `${today}T23:59:59${suffix}`,
  };
}
