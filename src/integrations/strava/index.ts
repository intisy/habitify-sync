import { totalMovingMinutes } from "./activities";
import { fetchApiActivities, stravaApiRoutes, STRAVA_API_STATE_KEYS } from "./api";
import { type HabitValue, type Integration, type SettingDescriptor, type SourceContext } from "../types";

export { exchangeStravaCode, type StravaTokens } from "./api";

const STRAVA_SETTINGS: SettingDescriptor[] = [
  {
    key: "clientId",
    type: "string",
    secret: true,
    required: true,
    description: "Strava OAuth application client id, from strava.com/settings/api.",
  },
  {
    key: "clientSecret",
    type: "string",
    secret: true,
    required: true,
    description: "Strava OAuth application client secret, from strava.com/settings/api.",
  },
];

export const STRAVA_STATE_KEYS = { ...STRAVA_API_STATE_KEYS };

export const stravaIntegration: Integration = {
  name: "strava",
  settings: STRAVA_SETTINGS,

  async fetchToday(context: SourceContext): Promise<HabitValue[]> {
    const { settings } = context;
    const clientId = await settings.getString("clientId");
    const clientSecret = await settings.getString("clientSecret");
    // Guaranteed present: fetchToday only runs once SettingsResolver.isEnabled() has confirmed
    // every required setting (both secrets included) resolved non-empty.
    const habitId = await settings.getString("habitId");
    if (!clientId || !clientSecret || !habitId) {
      throw new Error("strava is enabled but a required setting resolved empty; this should be unreachable");
    }
    const activities = await fetchApiActivities(context, clientId, clientSecret);
    return [{ habitId, value: totalMovingMinutes(activities), unit: "min" }];
  },

  routes: [...stravaApiRoutes],
};
