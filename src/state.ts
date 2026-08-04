import type { HabitValue } from "./sources/types";

export const STATE_KEYS = {
  stravaTokens: "strava:tokens",
  stravaOauthState: "strava:oauth_state",
  amazonCookies: "kindle:amazon_cookies",
  sourceStatus: (sourceName: string) => `status:${sourceName}`,
};

export interface StravaTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

export interface AmazonCookies {
  cookie: string;
  updatedAt: string;
}

export interface SourceStatus {
  state: "ok" | "error" | "auth_needed" | "disabled";
  lastSuccessAt?: string;
  lastErrorAt?: string;
  lastError?: string;
  values?: HabitValue[];
}

export async function readJson<T>(kv: KVNamespace, key: string): Promise<T | null> {
  const raw = await kv.get(key);
  return raw === null ? null : (JSON.parse(raw) as T);
}

export async function writeJson(kv: KVNamespace, key: string, value: unknown, ttlSeconds?: number): Promise<void> {
  await kv.put(key, JSON.stringify(value), ttlSeconds === undefined ? undefined : { expirationTtl: ttlSeconds });
}
