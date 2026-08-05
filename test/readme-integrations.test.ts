import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { INTEGRATIONS } from "../src/integrations/registry";
import { README_INTEGRATIONS_END, README_INTEGRATIONS_START, renderIntegrationsMarkdown } from "../src/readme-integrations";

// Relative to this config's root (the repo root — see test/generated-artifacts.vitest.config.ts).
const README_PATH = "README.md";

describe("README.md generated integrations block", () => {
  it("matches what the live registry currently declares", () => {
    const current = renderIntegrationsMarkdown(INTEGRATIONS);
    const readme = readFileSync(README_PATH, "utf8");
    const startIndex = readme.indexOf(README_INTEGRATIONS_START);
    const endIndex = readme.indexOf(README_INTEGRATIONS_END);
    if (startIndex === -1 || endIndex === -1 || endIndex < startIndex) {
      throw new Error(`README.md is missing the ${README_INTEGRATIONS_START} / ${README_INTEGRATIONS_END} markers`);
    }
    const onDisk = readme.slice(startIndex + README_INTEGRATIONS_START.length, endIndex).trim();
    // Normalize line endings before comparing: a checkout with Git's core.autocrlf can give CRLF
    // line endings on disk while the freshly generated string here always uses LF, which would
    // otherwise fail this comparison on every line despite no real content difference.
    const normalize = (text: string) => text.replace(/\r\n/g, "\n");
    // A mismatch here means an integration (or its settings) changed without regenerating
    // README.md — run `npm run generate:readme-integrations` and commit the result.
    expect(normalize(onDisk)).toBe(normalize(current.trim()));
  });
});
