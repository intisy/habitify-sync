// What both readers produce. Only moving time is shared: each reader narrows to today in its own
// frame before returning (the API filters server-side via `after=`, the web reader filters on an
// offset-shifted local timestamp), so a start time here would be dead weight on one of them.
export interface StravaActivity {
  movingTimeSeconds: number;
}

export function totalMovingMinutes(activities: readonly StravaActivity[]): number {
  return Math.round(activities.reduce((sum, activity) => sum + activity.movingTimeSeconds, 0) / 60);
}
