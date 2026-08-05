// Regenerates scripts/settings-manifest.json from the live integration registry. This file is the
// ONLY writer of that manifest — never hand-edit settings-manifest.json itself.
//
// Run after declaring, renaming, or removing any integration's settings:
//   npm run generate:settings-manifest
//
// test/settings-manifest.test.ts (part of the normal `npm test` run) fails if the committed
// manifest ever drifts from what this would produce, so a forgotten regeneration is caught in CI
// rather than silently rotting scripts/preflight.mjs's validation.
//
// Named *.vitest.ts (not *.test.ts) so the default `npm test` sweep does not pick it up as a test
// — it must only run when explicitly invoked via the npm script above, since it writes a file
// rather than asserting anything.
import { writeFileSync } from "node:fs";
import { it } from "vitest";
import { INTEGRATIONS } from "../src/integrations/registry";
import { buildSettingsManifest } from "../src/settings";

it("writes scripts/settings-manifest.json from the live registry", () => {
  const manifest = buildSettingsManifest(INTEGRATIONS);
  // A relative path (resolved against the workers-pool process's cwd, the repo root — this
  // script is always invoked from there via the npm script) rather than a `new URL(import.meta.url)`
  // path, which the pool's Node.js fs compat shim mishandles on Windows.
  writeFileSync("scripts/settings-manifest.json", `${JSON.stringify(manifest, null, 2)}\n`);
});
