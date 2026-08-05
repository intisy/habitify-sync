import type { HabitValue } from "./integrations/types";

export const STATE_KEYS = {
  sourceStatus: (sourceName: string) => `status:${sourceName}`,
};

// One habit's convergence-by-difference correction for a run, recorded so an operator can see
// exactly what was reasoned about and posted without needing to reconstruct it from logs: what
// Habitify already held for today (current), what the source wants it to be (target), the
// difference actually posted, and whether the negative-post fallback (undo, then post the full
// target) had to be used because Habitify rejected the direct negative post.
export interface HabitConvergence {
  habitId: string;
  target: number;
  current: number;
  difference: number;
  usedUndoFallback: boolean;
}

export interface SourceStatus {
  state: "ok" | "error" | "auth_needed" | "disabled";
  lastSuccessAt?: string;
  lastErrorAt?: string;
  lastError?: string;
  values?: HabitValue[];
  /** Human-readable notes recorded whenever a value's Habitify unit wasn't the habit's own configured unit. */
  unitFallbacks?: string[];
  /** Per-habit convergence diagnostics for this run — see HabitConvergence above. */
  convergence?: HabitConvergence[];
}

export async function readJson<T>(kv: KVNamespace, key: string): Promise<T | null> {
  const raw = await kv.get(key);
  return raw === null ? null : (JSON.parse(raw) as T);
}

export async function writeJson(kv: KVNamespace, key: string, value: unknown): Promise<void> {
  await kv.put(key, JSON.stringify(value));
}
