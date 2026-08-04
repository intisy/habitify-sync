export interface Env {
  STATE: KVNamespace;
  HABITIFY_API_KEY: string;
  ADMIN_TOKEN: string;
  TIMEZONE?: string;
  HABIT_ID_STRAVA?: string;
  HABIT_ID_WAKATIME?: string;
  HABIT_ID_KINDLE?: string;
  STRAVA_CLIENT_ID?: string;
  STRAVA_CLIENT_SECRET?: string;
  WAKATIME_API_KEY?: string;
  KINDLE_POSITIONS_PER_PAGE?: string;
}

export interface HabitValue {
  habitId: string;
  value: number;
  unit: string;
  /** Integration-specific diagnostics surfaced via GET /status. Never sent to Habitify. */
  diagnostics?: Record<string, unknown>;
}

export interface SourceContext {
  env: Env;
  timeZone: string;
  today: string;
  now: Date;
  fetchFn: typeof fetch;
}

export class AuthNeededError extends Error {}

// Carries what a route handler needs beyond the request itself: env bindings/secrets and an
// injectable fetch, so handlers stay testable the same way fetchToday implementations are.
export interface RouteContext {
  env: Env;
  fetchFn: typeof fetch;
}

export type AuthMode =
  | "admin" // requires `Authorization: Bearer <ADMIN_TOKEN>`
  | "admin-or-query-token" // additionally accepts `?token=`, for routes opened in a browser
  | "public"; // no admin token; the handler authenticates by other means

export interface IntegrationRoute {
  method: string;
  path: string;
  auth: AuthMode;
  handler(request: Request, context: RouteContext): Promise<Response>;
}

export interface Integration {
  name: string; // registry key, also the status key suffix
  enabled(env: Env): boolean; // true when its secrets/vars are set
  fetchToday(context: SourceContext): Promise<HabitValue[]>;
  routes?: IntegrationRoute[];
}
