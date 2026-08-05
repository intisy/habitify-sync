import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { INTEGRATIONS } from "../src/integrations/registry";
import { buildSettingsManifest } from "../src/settings";

// Relative to this config's root (the repo root — see test/settings-manifest.vitest.config.ts).
const MANIFEST_PATH = "scripts/settings-manifest.json";

describe("scripts/settings-manifest.json", () => {
  it("matches what the live registry currently declares", () => {
    const current = buildSettingsManifest(INTEGRATIONS);
    let onDisk: unknown;
    try {
      onDisk = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
    } catch (cause) {
      throw new Error(
        `Cannot read scripts/settings-manifest.json (${(cause as Error).message}). ` +
          "Generate it with: npm run generate:settings-manifest",
      );
    }
    // A mismatch here means an integration's settings changed without regenerating the manifest
    // scripts/preflight.mjs reads — run `npm run generate:settings-manifest` and commit the result.
    expect(onDisk).toEqual(current);
  });
});
