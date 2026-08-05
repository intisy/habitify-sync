import type { HabitValue, Integration, SettingDescriptor, SourceContext } from "../types";

const WAKATIME_SETTINGS: SettingDescriptor[] = [
  {
    key: "apiKey",
    type: "string",
    secret: true,
    required: true,
    description: "WakaTime API key, from wakatime.com/settings/api-key.",
  },
];

interface WakatimeSummaries {
  data: { grand_total: { total_seconds: number } }[];
}

export const wakatimeIntegration: Integration = {
  name: "wakatime",
  settings: WAKATIME_SETTINGS,

  async fetchToday(context: SourceContext): Promise<HabitValue[]> {
    const { today, fetchFn, settings } = context;
    const apiKey = await settings.getString("apiKey");
    const habitId = await settings.getString("habitId");
    // Guaranteed present: fetchToday only runs once SettingsResolver.isEnabled() has confirmed
    // every required setting resolved non-empty.
    if (!apiKey || !habitId) {
      throw new Error("wakatime is enabled but a required setting resolved empty; this should be unreachable");
    }
    const url = `https://wakatime.com/api/v1/users/current/summaries?start=${today}&end=${today}`;
    const response = await fetchFn(url, {
      headers: { Authorization: `Basic ${btoa(apiKey)}` },
    });
    if (!response.ok) {
      throw new Error(`WakaTime summaries request failed with status ${response.status}`);
    }
    const summaries = (await response.json()) as WakatimeSummaries;
    // WakaTime can return 202 (still computing) with a body that isn't the expected shape,
    // which passes response.ok but would otherwise throw a cryptic TypeError below.
    if (!Array.isArray(summaries.data)) {
      throw new Error("WakaTime returned an unexpected payload shape");
    }
    const totalSeconds = summaries.data.reduce((sum, day) => sum + day.grand_total.total_seconds, 0);
    return [{ habitId, value: Math.round(totalSeconds / 60), unit: "min" }];
  },
};
