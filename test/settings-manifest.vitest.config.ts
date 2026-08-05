import { defineConfig } from "vitest/config";

// A separate, plain-Node config for test/settings-manifest.test.ts only. That test reads
// scripts/settings-manifest.json off the real filesystem to compare it against the live
// registry — workerd's Node.js fs compat shim (used by the rest of the suite via
// vitest.config.ts's workers pool) is a virtualized, bundle-only filesystem with no access to the
// real project directory, so this one test needs to run outside that pool entirely. See the
// matching exclude in vitest.config.ts and the "test" script in package.json, which runs both.
export default defineConfig({
  test: {
    include: ["test/settings-manifest.test.ts"],
  },
});
