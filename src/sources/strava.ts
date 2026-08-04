import { readJson, STATE_KEYS, writeJson, type StravaTokens } from "../state";
import { localMidnightEpochSeconds } from "../time";
import { AuthNeededError, type Env, type HabitValue, type Source, type SourceContext } from "./types";

export const STRAVA_TOKEN_URL = "https://www.strava.com/oauth/token";
const STRAVA_ACTIVITIES_URL = "https://www.strava.com/api/v3/athlete/activities";

interface StravaTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_at: number;
}

// Strava rotates refresh tokens on every refresh, so the new one must be persisted.
async function refreshTokens(env: Env, fetchFn: typeof fetch, tokens: StravaTokens): Promise<StravaTokens> {
  const response = await fetchFn(STRAVA_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: env.STRAVA_CLIENT_ID,
      client_secret: env.STRAVA_CLIENT_SECRET,
      grant_type: "refresh_token",
      refresh_token: tokens.refreshToken,
    }),
  });
  if (response.status === 400 || response.status === 401) {
    throw new AuthNeededError("Strava refused the refresh token; re-run /strava/authorize");
  }
  if (!response.ok) {
    throw new Error(`Strava token refresh failed with status ${response.status}`);
  }
  const body = (await response.json()) as StravaTokenResponse;
  const refreshed: StravaTokens = {
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    expiresAt: body.expires_at,
  };
  await writeJson(env.STATE, STATE_KEYS.stravaTokens, refreshed);
  return refreshed;
}

export const stravaSource: Source = {
  name: "strava",

  enabled(env: Env): boolean {
    return Boolean(env.STRAVA_CLIENT_ID && env.STRAVA_CLIENT_SECRET && env.HABIT_ID_STRAVA);
  },

  async fetchToday(context: SourceContext): Promise<HabitValue[]> {
    const { env, timeZone, now, fetchFn } = context;
    let tokens = await readJson<StravaTokens>(env.STATE, STATE_KEYS.stravaTokens);
    if (!tokens) {
      throw new AuthNeededError("Strava is not authorized yet; open /strava/authorize");
    }
    const nowEpoch = Math.floor(now.getTime() / 1000);
    if (tokens.expiresAt <= nowEpoch + 60) {
      tokens = await refreshTokens(env, fetchFn, tokens);
    }
    const after = localMidnightEpochSeconds(timeZone, now);
    const response = await fetchFn(`${STRAVA_ACTIVITIES_URL}?after=${after}&per_page=100`, {
      headers: { Authorization: `Bearer ${tokens.accessToken}` },
    });
    if (response.status === 401) {
      throw new AuthNeededError("Strava rejected the access token; re-run /strava/authorize");
    }
    if (!response.ok) {
      throw new Error(`Strava activities request failed with status ${response.status}`);
    }
    const activities = (await response.json()) as { moving_time: number }[];
    const totalSeconds = activities.reduce((sum, activity) => sum + activity.moving_time, 0);
    return [{ habitId: env.HABIT_ID_STRAVA!, value: Math.round(totalSeconds / 60), unit: "min" }];
  },
};
