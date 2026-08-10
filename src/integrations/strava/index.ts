import { totalMovingMinutes } from "./activities";
import { fetchApiActivities, stravaApiRoutes, STRAVA_API_STATE_KEYS } from "./api";
import { fetchWebActivities, readStravaSession, stravaWebRoutes, STRAVA_WEB_STATE_KEYS } from "./web";
import {
  AuthNeededError,
  type HabitValue,
  type Integration,
  type SettingDescriptor,
  type SourceContext,
} from "../types";

export { exchangeStravaCode, type StravaTokens } from "./api";
export { type StravaSession } from "./web";

// Neither credential is `required`: a deployment authenticating by captured web session configures
// no OAuth application at all, so requiring them would hold that deployment permanently "disabled".
// habitId alone therefore enables the integration, exactly as it does for kindle.
const STRAVA_SETTINGS: SettingDescriptor[] = [
  {
    key: "clientId",
    type: "string",
    secret: true,
    description:
      "Strava OAuth application client id, from strava.com/settings/api. Not needed when using a web session.",
  },
  {
    key: "clientSecret",
    type: "string",
    secret: true,
    description:
      "Strava OAuth application client secret, from strava.com/settings/api. Not needed when using a web session.",
  },
];

export const STRAVA_STATE_KEYS = { ...STRAVA_API_STATE_KEYS, ...STRAVA_WEB_STATE_KEYS };

export const stravaIntegration: Integration = {
  name: "strava",
  settings: STRAVA_SETTINGS,

  async fetchToday(context: SourceContext): Promise<HabitValue[]> {
    const { env, settings } = context;
    // Guaranteed present: fetchToday only runs once SettingsResolver.isEnabled() has confirmed
    // every required setting resolved non-empty (habitId is strava's only required setting).
    const habitId = await settings.getString("habitId");
    if (!habitId) {
      throw new Error("strava is enabled but habitId resolved empty; this should be unreachable");
    }

    // A captured session wins: capturing one is always a deliberate act, so it is what an operator
    // migrating off the paywalled API expects to take effect without touching any other setting.
    const session = await readStravaSession(env);
    if (session) {
      const { activities, diagnostics } = await fetchWebActivities(context, session);
      return [{ habitId, value: totalMovingMinutes(activities), unit: "min", diagnostics }];
    }

    const clientId = await settings.getString("clientId");
    const clientSecret = await settings.getString("clientSecret");
    if (!clientId || !clientSecret) {
      throw new AuthNeededError(
        "Strava has neither a web session nor API credentials; capture one with PUT /strava/session, or set STRAVA_CLIENT_ID and STRAVA_CLIENT_SECRET then open /strava/authorize",
      );
    }
    const activities = await fetchApiActivities(context, clientId, clientSecret);
    return [{ habitId, value: totalMovingMinutes(activities), unit: "min", diagnostics: { reader: "api" } }];
  },

  routes: [...stravaApiRoutes, ...stravaWebRoutes],
};
