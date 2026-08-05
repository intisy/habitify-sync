import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";
import { configDefaults } from "vitest/config";

export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: { wrangler: { configPath: "./wrangler.toml" } },
    },
    // test/settings-manifest.test.ts runs under its own plain-Node config instead (see
    // test/settings-manifest.vitest.config.ts and the "test" script in package.json) — it reads a
    // real file off disk, which workerd's virtualized Node.js fs compat shim cannot do.
    exclude: [...configDefaults.exclude, "test/settings-manifest.test.ts"],
  },
});
