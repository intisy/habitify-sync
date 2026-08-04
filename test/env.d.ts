import type { Env } from "../src/sources/types";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}
