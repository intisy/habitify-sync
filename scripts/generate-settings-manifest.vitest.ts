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
  // A relative path, resolved against this process's cwd (the repo root — the npm script always
  // invokes vitest from there). This file deliberately runs under the plain-Node config
  // (scripts/generators.vitest.config.ts), not the workers pool the rest of the suite uses —
  // workerd's Node.js fs compat shim is a virtualized, bundle-only mount with no access to the
  // real project directory, so a write like this fails there no matter what path is given
  // (confirmed by hand). Plain Node has real disk access, which is the whole reason this file
  // runs under that separate config instead of the default one.
  writeFileSync("scripts/settings-manifest.json", `${JSON.stringify(manifest, null, 2)}\n`);
});
