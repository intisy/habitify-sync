import { HabitifyClient } from "./habitify";
import { readJson, STATE_KEYS, writeJson, type SourceStatus } from "./state";
import { AuthNeededError, type Env, type Integration, type SourceContext } from "./integrations/types";
import { todayInTimeZone } from "./time";

const DEFAULT_TIME_ZONE = "Europe/Berlin";

export interface SyncResult {
  source: string;
  status: SourceStatus;
}

export async function runSync(
  env: Env,
  sources: Integration[],
  now: Date,
  // Bound to globalThis as a defensive invariant: every call site here (and inside
  // HabitifyClient, see habitify.ts) already treats fetchFn as a plain function, but a pre-bound
  // function keeps working correctly even if that invariant is ever broken by future code that
  // calls it as `something.fetchFn(...)` instead.
  fetchFn: typeof fetch = fetch.bind(globalThis),
  onlySource?: string,
): Promise<SyncResult[]> {
  const timeZone = env.TIMEZONE || DEFAULT_TIME_ZONE;
  const context: SourceContext = { env, timeZone, today: todayInTimeZone(timeZone, now), now, fetchFn };
  const results: SyncResult[] = [];

  // Without this, a missing key would make every enabled source fail with a 401 buried in
  // lastError, hourly, forever. Fail fast with one clear message per source instead.
  if (!env.HABITIFY_API_KEY) {
    for (const source of sources) {
      if (onlySource && source.name !== onlySource) continue;
      const previous = await readJson<SourceStatus>(env.STATE, STATE_KEYS.sourceStatus(source.name));
      const status: SourceStatus = {
        state: "error",
        lastSuccessAt: previous?.lastSuccessAt,
        lastErrorAt: now.toISOString(),
        lastError: "HABITIFY_API_KEY is not configured",
      };
      await writeJson(env.STATE, STATE_KEYS.sourceStatus(source.name), status);
      results.push({ source: source.name, status });
    }
    return results;
  }

  const habitify = new HabitifyClient(env.HABITIFY_API_KEY, fetchFn);

  for (const source of sources) {
    if (onlySource && source.name !== onlySource) continue;
    const previous = await readJson<SourceStatus>(env.STATE, STATE_KEYS.sourceStatus(source.name));
    if (!source.enabled(env)) {
      // Carry lastSuccessAt forward so unsetting a secret doesn't erase when the source last worked.
      const disabledStatus: SourceStatus = { state: "disabled", lastSuccessAt: previous?.lastSuccessAt };
      await writeJson(env.STATE, STATE_KEYS.sourceStatus(source.name), disabledStatus);
      results.push({ source: source.name, status: disabledStatus });
      continue;
    }

    let status: SourceStatus;
    try {
      const values = await source.fetchToday(context);
      for (const value of values) {
        await habitify.upsertTodayLog(value, timeZone, now);
      }
      status = { state: "ok", lastSuccessAt: now.toISOString(), values };
    } catch (error) {
      status = {
        state: error instanceof AuthNeededError ? "auth_needed" : "error",
        lastSuccessAt: previous?.lastSuccessAt,
        lastErrorAt: now.toISOString(),
        lastError: error instanceof Error ? error.message : String(error),
      };
    }
    await writeJson(env.STATE, STATE_KEYS.sourceStatus(source.name), status);
    results.push({ source: source.name, status });
  }

  return results;
}
