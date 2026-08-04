import type { Env } from "./sources/types";

export default {
  async scheduled(_event: ScheduledEvent, env: Env): Promise<void> {
    console.log("Worker triggered", { env });
  },
};
