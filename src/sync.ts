import { HabitifyClient, isHabitifyUnitSymbol, type HabitifyUnitSymbol } from "./habitify";
import { readJson, STATE_KEYS, writeJson, type HabitConvergence, type SourceStatus } from "./state";
import { AuthNeededError, type Env, type HabitValue, type Integration, type SourceContext } from "./integrations/types";
import { SettingsResolver } from "./settings";
import { todayInTimeZone } from "./time";

const DEFAULT_TIME_ZONE = "Europe/Berlin";

export interface SyncResult {
  source: string;
  status: SourceStatus;
}

// Resolves the Habitify unit symbol actually sent for one value. The habit's OWN configured unit
// (from Habitify itself) is authoritative over the integration's declared unit: integrations
// describe a semantic unit ("pages", "min") that may not even be a valid Habitify symbol (Kindle's
// "pages" is not), so trusting whatever the human configured on the habit is what keeps every
// write valid without requiring the integration and the habit to agree on a unit string. The
// integration's declared unit is only a fallback for when Habitify has no unit for that habit (or
// its habit lookup failed), and "rep" — the generic count unit — is the last resort when neither
// is a valid Habitify symbol.
function resolveHabitifyUnit(
  value: HabitValue,
  habitUnitsById: ReadonlyMap<string, string>,
): { unit: HabitifyUnitSymbol; fallbackReason?: string } {
  const habitUnit = habitUnitsById.get(value.habitId);
  if (habitUnit !== undefined && isHabitifyUnitSymbol(habitUnit)) {
    return { unit: habitUnit };
  }
  if (isHabitifyUnitSymbol(value.unit)) {
    return {
      unit: value.unit,
      fallbackReason:
        habitUnit === undefined
          ? `habit ${value.habitId} has no configured unit; using integration's unit "${value.unit}"`
          : `habit ${value.habitId}'s configured unit "${habitUnit}" is not a valid Habitify unit; using integration's unit "${value.unit}"`,
    };
  }
  return {
    unit: "rep",
    fallbackReason: `habit ${value.habitId} has no valid unit from Habitify or the integration (integration declared "${value.unit}"); falling back to "rep"`,
  };
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
  const today = todayInTimeZone(timeZone, now);
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

  // Once per run (not once per habit): look up every habit's own configured unit, so each value
  // below can defer to it instead of the integration's possibly-invalid declared unit. This costs
  // one extra API call per run, trivial against Habitify's 500/min rate limit.
  const habitUnitsById = new Map<string, string>();
  let habitUnitLookupError: string | undefined;
  try {
    for (const habit of await habitify.listHabits()) {
      if (habit.unit !== undefined) habitUnitsById.set(habit.id, habit.unit);
    }
  } catch (error) {
    // A transient failure to list habits must not block writes for this run — every value just
    // falls back to its integration-declared unit (or "rep"), the same as a habit Habitify has no
    // configured unit for.
    habitUnitLookupError = error instanceof Error ? error.message : String(error);
  }

  // Read once per run, not once per habit: this is the single source of truth every value below
  // converges toward by posting a DIFFERENCE rather than a total (see
  // HabitifyClient.writeTodayValue). Unlike the unit lookup above, a failure here is NOT tolerated
  // with a silent fallback — falling back to posting the full total on a failed read is exactly
  // the accumulation bug being fixed, so a failed journal read fails every write for this run
  // instead (see the per-source handling below).
  let currentValuesById = new Map<string, number>();
  let journalLookupError: string | undefined;
  try {
    currentValuesById = await habitify.getCurrentValuesByHabitId(today);
  } catch (error) {
    journalLookupError = error instanceof Error ? error.message : String(error);
  }

  for (const source of sources) {
    if (onlySource && source.name !== onlySource) continue;
    const previous = await readJson<SourceStatus>(env.STATE, STATE_KEYS.sourceStatus(source.name));
    const settings = new SettingsResolver(env, env.STATE, source.name, source.settings);
    if (!(await settings.isEnabled())) {
      // Carry lastSuccessAt forward so unsetting a secret doesn't erase when the source last worked.
      const disabledStatus: SourceStatus = { state: "disabled", lastSuccessAt: previous?.lastSuccessAt };
      await writeJson(env.STATE, STATE_KEYS.sourceStatus(source.name), disabledStatus);
      results.push({ source: source.name, status: disabledStatus });
      continue;
    }

    let status: SourceStatus;
    if (journalLookupError !== undefined) {
      // Nothing is written this run: a missed hour self-corrects the next time the journal read
      // succeeds, but writing without knowing today's true current value risks re-inflating
      // exactly what convergence-by-difference exists to prevent.
      status = {
        state: "error",
        lastSuccessAt: previous?.lastSuccessAt,
        lastErrorAt: now.toISOString(),
        lastError: `Could not read today's Habitify journal, so nothing was written this run: ${journalLookupError}`,
      };
      await writeJson(env.STATE, STATE_KEYS.sourceStatus(source.name), status);
      results.push({ source: source.name, status });
      continue;
    }

    const context: SourceContext = { env, timeZone, today, now, fetchFn, settings };
    try {
      const values = await source.fetchToday(context);
      const unitFallbacks: string[] = habitUnitLookupError
        ? [`could not look up Habitify habit units (${habitUnitLookupError}); using each value's integration-declared unit`]
        : [];
      const convergence: HabitConvergence[] = [];
      for (const value of values) {
        const { unit, fallbackReason } = resolveHabitifyUnit(value, habitUnitsById);
        if (fallbackReason && !habitUnitLookupError) unitFallbacks.push(fallbackReason);
        // A habit absent from the journal (no measurable log yet today) is treated as current 0,
        // so its full target gets posted.
        const current = currentValuesById.get(value.habitId) ?? 0;
        const { difference, usedUndoFallback } = await habitify.writeTodayValue(
          value,
          unit,
          value.value,
          current,
          timeZone,
          now,
        );
        convergence.push({ habitId: value.habitId, target: value.value, current, difference, usedUndoFallback });
      }
      status = {
        state: "ok",
        lastSuccessAt: now.toISOString(),
        values,
        ...(unitFallbacks.length > 0 ? { unitFallbacks } : {}),
        ...(convergence.length > 0 ? { convergence } : {}),
      };
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
