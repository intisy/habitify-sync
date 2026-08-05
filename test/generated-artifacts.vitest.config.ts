import { defineConfig } from "vitest/config";

// A separate, plain-Node config for the tests that check a generated artifact (see
// scripts/generators.vitest.config.ts) against what the live registry currently declares:
// test/settings-manifest.test.ts (scripts/settings-manifest.json) and
// test/readme-integrations.test.ts (README.md's generated integrations block). Both read a real
// file off disk — workerd's Node.js fs compat shim (used by the rest of the suite via
// vitest.config.ts's workers pool) is a virtualized, bundle-only filesystem with no access to the
// real project directory, so these need to run outside that pool entirely. See the matching
// exclude in vitest.config.ts and the "test" script in package.json, which runs both configs.
export default defineConfig({
  test: {
    include: ["test/settings-manifest.test.ts", "test/readme-integrations.test.ts"],
  },
});
