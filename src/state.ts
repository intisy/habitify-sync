import type { HabitValue } from "./integrations/types";

export const STATE_KEYS = {
  sourceStatus: (sourceName: string) => `status:${sourceName}`,
};

export interface SourceStatus {
  state: "ok" | "error" | "auth_needed" | "disabled";
  lastSuccessAt?: string;
  lastErrorAt?: string;
  lastError?: string;
  values?: HabitValue[];
  /** Human-readable notes recorded whenever a value's Habitify unit wasn't the habit's own configured unit. */
  unitFallbacks?: string[];
}

export async function readJson<T>(kv: KVNamespace, key: string): Promise<T | null> {
  const raw = await kv.get(key);
  return raw === null ? null : (JSON.parse(raw) as T);
}

export async function writeJson(kv: KVNamespace, key: string, value: unknown): Promise<void> {
  await kv.put(key, JSON.stringify(value));
}
