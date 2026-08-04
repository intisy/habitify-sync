import { HabitifyClient } from "./habitify";
import { readJson, STATE_KEYS, writeJson, type SourceStatus } from "./state";
import { AuthNeededError, type Env, type Source, type SourceContext } from "./sources/types";
import { todayInTimeZone } from "./time";

const DEFAULT_TIME_ZONE = "Europe/Berlin";

export interface SyncResult {
  source: string;
  status: SourceStatus;
}

export async function runSync(
  env: Env,
  sources: Source[],
  now: Date,
  fetchFn: typeof fetch = fetch,
  onlySource?: string,
): Promise<SyncResult[]> {
  const timeZone = env.TIMEZONE || DEFAULT_TIME_ZONE;
  const context: SourceContext = { env, timeZone, today: todayInTimeZone(timeZone, now), now, fetchFn };
  const habitify = new HabitifyClient(env.HABITIFY_API_KEY, fetchFn);
  const results: SyncResult[] = [];

  for (const source of sources) {
    if (onlySource && source.name !== onlySource) continue;
    if (!source.enabled(env)) {
      const disabledStatus: SourceStatus = { state: "disabled" };
      await writeJson(env.STATE, STATE_KEYS.sourceStatus(source.name), disabledStatus);
      results.push({ source: source.name, status: disabledStatus });
      continue;
    }

    const previous = await readJson<SourceStatus>(env.STATE, STATE_KEYS.sourceStatus(source.name));
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
