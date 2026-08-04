export interface Env {
  STATE: KVNamespace;
  HABITIFY_API_KEY: string;
  ADMIN_TOKEN: string;
  TIMEZONE?: string;
  HABIT_ID_STRAVA?: string;
  HABIT_ID_WAKATIME?: string;
  STRAVA_CLIENT_ID?: string;
  STRAVA_CLIENT_SECRET?: string;
  WAKATIME_API_KEY?: string;
}

export interface HabitValue {
  habitId: string;
  value: number;
  unit: string;
}

export interface SourceContext {
  env: Env;
  timeZone: string;
  today: string;
  now: Date;
  fetchFn: typeof fetch;
}

export interface Source {
  name: string;
  enabled(env: Env): boolean;
  fetchToday(context: SourceContext): Promise<HabitValue[]>;
}

export class AuthNeededError extends Error {}
