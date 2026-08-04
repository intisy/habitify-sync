import { stravaSource } from "./strava";
import type { Source } from "./types";
import { wakatimeSource } from "./wakatime";

// Adding a new integration: implement Source in a new file here and add it to this list.
export const SOURCES: Source[] = [stravaSource, wakatimeSource];
