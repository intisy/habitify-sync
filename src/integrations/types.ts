import type { SettingsResolver } from "../settings";

export interface Env {
  STATE: KVNamespace;
  HABITIFY_API_KEY: string;
  ADMIN_TOKEN: string;
  TIMEZONE?: string;
  // Every per-integration variable (HABIT_ID_<NAME>, and each declared setting's derived name) is
  // read through this index signature rather than a named field — see src/settings.ts. This is
  // what keeps Env from growing a field every time an integration declares a setting.
  [derivedVariableName: string]: unknown;
}

// One setting an integration accepts, e.g. { key: "clientId", type: "string", secret: true,
// required: true, description: "..." }. The environment variable it resolves from is never
// written down separately — see deriveVariableName in src/settings.ts, which derives it from
// this descriptor's key and the owning integration's name.
export interface SettingDescriptor {
  /** Integration-local camelCase name, e.g. "wordsPerPage". */
  key: string;
  type: "string" | "number" | "json";
  /** Required settings gate the derived enabled() — see src/settings.ts. Every integration implicitly requires habitId. */
  required?: boolean;
  /** Lives only in Cloudflare secrets: never returned by GET /config, never settable via PUT, never read from KV. */
  secret?: boolean;
  default?: string;
  /** One line, shown by GET /config. */
  description: string;
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
  // Scoped to this integration alone: `settings.getString("clientId")` resolves STRAVA_CLIENT_ID
  // for strava but would throw for any other integration. See src/settings.ts.
  settings: SettingsResolver;
}

export class AuthNeededError extends Error {}

// Carries what a route handler needs beyond the request itself: env bindings/secrets and an
// injectable fetch, so handlers stay testable the same way fetchToday implementations are.
export interface RouteContext {
  env: Env;
  fetchFn: typeof fetch;
  // Scoped to the integration that owns this route (see the route-ownership map built in
  // src/index.ts). A core route not owned by any integration gets a resolver with no declared
  // settings, which is never read.
  settings: SettingsResolver;
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
  // The settings this integration declares, excluding the implicit `habitId` every integration
  // gets automatically (see src/settings.ts). enabled() is no longer authored here at all — it's
  // derived generically from these declarations plus habitId.
  settings: SettingDescriptor[];
  fetchToday(context: SourceContext): Promise<HabitValue[]>;
  routes?: IntegrationRoute[];
}
