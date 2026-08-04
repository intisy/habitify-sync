import type { Env } from "../src/integrations/types";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}
