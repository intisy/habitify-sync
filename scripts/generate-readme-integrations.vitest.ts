// Regenerates the generated block in the root README.md (between the
// <!-- integrations:start --> / <!-- integrations:end --> markers) from the live integration
// registry. This is the ONLY writer of that block — never hand-edit the markdown between the
// markers; everything outside them is untouched.
//
// Run after declaring, renaming, or removing any integration or its settings:
//   npm run generate:readme-integrations
//
// test/readme-integrations.test.ts (part of the normal `npm test` run) fails if the committed
// block ever drifts from what this would produce, so a forgotten regeneration is caught in CI.
//
// Named *.vitest.ts (not *.test.ts) so the default `npm test` sweep does not pick it up — it must
// only run when explicitly invoked via the npm script above, since it writes a file rather than
// asserting anything. See scripts/generators.vitest.config.ts for why this runs outside the
// workers pool the rest of the suite uses.
import { readFileSync, writeFileSync } from "node:fs";
import { it } from "vitest";
import { INTEGRATIONS } from "../src/integrations/registry";
import { renderIntegrationsMarkdown, withIntegrationsBlock } from "../src/readme-integrations";

it("writes the generated integrations block into README.md", () => {
  const block = renderIntegrationsMarkdown(INTEGRATIONS);
  const readme = readFileSync("README.md", "utf8");
  writeFileSync("README.md", withIntegrationsBlock(readme, block));
});
