import type { Integration } from "./integrations/types";
import { buildSettingsManifest, type ManifestSettingEntry } from "./settings";

// Markers delimiting the generated block in the root README.md — everything between them is
// rewritten wholesale by scripts/generate-readme-integrations.vitest.ts; everything outside them
// (the surrounding prose) is left untouched.
export const README_INTEGRATIONS_START = "<!-- integrations:start -->";
export const README_INTEGRATIONS_END = "<!-- integrations:end -->";

function renderSettingsTable(entries: ManifestSettingEntry[]): string {
  const header = "| Key | Derived variable | Type | Required | Secret | Default | Description |";
  const divider = "|---|---|---|---|---|---|---|";
  const rows = entries.map((entry) => {
    const defaultCell = entry.default !== undefined ? `\`${entry.default}\`` : "—";
    return `| \`${entry.key}\` | \`${entry.variableName}\` | ${entry.type} | ${entry.required ? "yes" : "no"} | ${
      entry.secret ? "yes" : "no"
    } | ${defaultCell} | ${entry.description} |`;
  });
  return [header, divider, ...rows].join("\n");
}

// Renders the markdown placed between README_INTEGRATIONS_START/END: one section per registered
// integration, a link to its own README, and its full settings table derived straight from the
// registry (via the same buildSettingsManifest scripts/settings-manifest.json uses). This is the
// only place the root README lists an integration's settings — descriptive prose (what it logs,
// setup steps, gotchas) stays hand-written in that integration's own README, which the link here
// points to.
export function renderIntegrationsMarkdown(integrations: readonly Pick<Integration, "name" | "settings">[]): string {
  const manifest = buildSettingsManifest(integrations);
  return integrations
    .map((integration) => {
      const entries = manifest[integration.name];
      return `### [${integration.name}](src/integrations/${integration.name}/README.md)\n\n${renderSettingsTable(entries)}`;
    })
    .join("\n\n");
}

// Replaces the content between the start/end markers in `readmeText` with `block`, leaving
// everything else untouched. Throws if the markers are missing rather than silently skipping the
// replacement — a hand-deleted marker should fail loudly, not quietly stop updating.
export function withIntegrationsBlock(readmeText: string, block: string): string {
  const startIndex = readmeText.indexOf(README_INTEGRATIONS_START);
  const endIndex = readmeText.indexOf(README_INTEGRATIONS_END);
  if (startIndex === -1 || endIndex === -1 || endIndex < startIndex) {
    throw new Error(`README.md is missing the ${README_INTEGRATIONS_START} / ${README_INTEGRATIONS_END} markers`);
  }
  const before = readmeText.slice(0, startIndex + README_INTEGRATIONS_START.length);
  const after = readmeText.slice(endIndex);
  return `${before}\n\n${block}\n\n${after}`;
}
