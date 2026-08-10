export function todayInTimeZone(timeZone: string, now: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

function timeZoneOffsetMinutes(timeZone: string, at: Date): number {
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
    // Intl emits "24" (not "00") for midnight when hour12 is false, so it must be wrapped back to 0.
    part("hour") % 24,
    part("minute"),
    part("second"),
  );
  return Math.round((asUtc - at.getTime()) / 60000);
}

function offsetMinutesAtLocalTime(timeZone: string, localIsoWithoutOffset: string): number {
  const estimateMs = Date.parse(`${localIsoWithoutOffset}Z`);
  const firstPass = timeZoneOffsetMinutes(timeZone, new Date(estimateMs));
  return timeZoneOffsetMinutes(timeZone, new Date(estimateMs - firstPass * 60000));
}

export function localMidnightEpochSeconds(timeZone: string, now: Date): number {
  const today = todayInTimeZone(timeZone, now);
  const utcMidnightMs = Date.parse(`${today}T00:00:00Z`);
  const offsetMinutes = offsetMinutesAtLocalTime(timeZone, `${today}T00:00:00`);
  return utcMidnightMs / 1000 - offsetMinutes * 60;
}

// The boundary for a timestamp that is ALREADY offset-shifted — naive local time rendered as an
// epoch, which is what Strava's web JSON emits as start_date_local_raw. Comparing such a value
// against localMidnightEpochSeconds above would be wrong by exactly the zone's UTC offset, silently
// dropping or admitting early-morning activities rather than failing.
export function naiveLocalMidnightEpochSeconds(timeZone: string, now: Date): number {
  return Date.parse(`${todayInTimeZone(timeZone, now)}T00:00:00Z`) / 1000;
}
