import { stravaSource } from "../sources/strava";
import type { Integration } from "./types";
import { wakatimeIntegration } from "./wakatime";

// Adding a new integration: implement Integration in a new directory here and add it to this list.
export const INTEGRATIONS: Integration[] = [stravaSource, wakatimeIntegration];
