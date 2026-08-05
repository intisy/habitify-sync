import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";
import { configDefaults } from "vitest/config";

export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: { wrangler: { configPath: "./wrangler.toml" } },
    },
    // These run under their own plain-Node config instead (see
    // test/generated-artifacts.vitest.config.ts and the "test" script in package.json) — both
    // read a real file off disk, which workerd's virtualized Node.js fs compat shim cannot do.
    exclude: [...configDefaults.exclude, "test/settings-manifest.test.ts", "test/readme-integrations.test.ts"],
  },
});
