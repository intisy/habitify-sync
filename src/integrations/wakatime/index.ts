import type { Env, HabitValue, Integration, SourceContext } from "../types";

interface WakatimeSummaries {
  data: { grand_total: { total_seconds: number } }[];
}

export const wakatimeIntegration: Integration = {
  name: "wakatime",

  enabled(env: Env): boolean {
    return Boolean(env.WAKATIME_API_KEY && env.HABIT_ID_WAKATIME);
  },

  async fetchToday(context: SourceContext): Promise<HabitValue[]> {
    const { env, today, fetchFn } = context;
    const url = `https://wakatime.com/api/v1/users/current/summaries?start=${today}&end=${today}`;
    const response = await fetchFn(url, {
      headers: { Authorization: `Basic ${btoa(env.WAKATIME_API_KEY!)}` },
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
    return [{ habitId: env.HABIT_ID_WAKATIME!, value: Math.round(totalSeconds / 60), unit: "min" }];
  },
};
