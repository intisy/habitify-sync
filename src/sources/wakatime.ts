import type { Env, HabitValue, Source, SourceContext } from "./types";

interface WakatimeSummaries {
  data: { grand_total: { total_seconds: number } }[];
}

export const wakatimeSource: Source = {
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
    const totalSeconds = summaries.data.reduce((sum, day) => sum + day.grand_total.total_seconds, 0);
    return [{ habitId: env.HABIT_ID_WAKATIME!, value: Math.round(totalSeconds / 60), unit: "min" }];
  },
};
