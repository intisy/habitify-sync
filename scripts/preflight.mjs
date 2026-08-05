#!/usr/bin/env node
/**
 * Validates wrangler.toml before a deploy, so misconfiguration surfaces here
 * rather than as a rejected deploy or a "disabled"/"error" source at the next
 * hourly sync.
 *
 * Reads wrangler.toml as text and matches the handful of keys it cares about,
 * which keeps this dependency-free — a TOML parser would be the project's
 * only dependency and would earn its place only if this grew a lot more
 * checks.
 *
 * Per-integration settings are validated generically, off
 * scripts/settings-manifest.json — a generated snapshot of every integration's
 * declared settings (key, derived variable name, type, required, secret),
 * kept fresh by test/settings-manifest.test.ts (part of `npm test`) failing
 * whenever it drifts from the live registry in src/integrations/registry.ts.
 * This file is a plain Node script with none of the TypeScript/Workers
 * tooling `npm test` has available, so it cannot import the registry
 * directly: this project's modules use extensionless/directory import
 * specifiers throughout (TypeScript's "bundler" resolution, the same style
 * wrangler/vitest/esbuild all support), which plain Node's ESM resolver
 * rejects even under `--experimental-strip-types` — confirmed by hand against
 * this exact codebase. The generated manifest is what lets preflight validate
 * every integration's settings without ever hand-listing them here again.
 *
 * Exit 0 = safe to deploy (warnings may still be printed), exit 1 = fix first.
 */
import { readFileSync } from "node:fs";

const CONFIG_PATH = new URL("../wrangler.toml", import.meta.url);
const MANIFEST_PATH = new URL("./settings-manifest.json", import.meta.url);
const PLACEHOLDER_KV_ID = "0000000000000000000000000000000000000000";

const errors = [];
const warnings = [];
const notes = [];

let config;
try {
  config = readFileSync(CONFIG_PATH, "utf8");
} catch (cause) {
  console.error(`Cannot read wrangler.toml: ${cause.message}`);
  process.exit(1);
}

/** Reads a top-level `key = "value"` pair, ignoring commented-out lines. */
function readString(key) {
  const match = config.match(new RegExp(`^\\s*${key}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "m"));
  if (!match) return undefined;
  return match[1] ?? match[2] ?? "";
}

// --- KV namespace ---------------------------------------------------------
const kvBlock = config.match(/\[\[kv_namespaces\]\][\s\S]*?(?=\n\[|$)/);
if (!kvBlock) {
  errors.push("No [[kv_namespaces]] block found — the worker needs its STATE binding.");
} else {
  const kvId = kvBlock[0].match(/^\s*id\s*=\s*"([^"]*)"/m)?.[1];
  if (!kvId) {
    errors.push("The STATE kv_namespace has no id. Run: npx wrangler kv namespace create STATE");
  } else if (kvId === PLACEHOLDER_KV_ID || /^0+$/.test(kvId)) {
    errors.push(
      `The STATE kv_namespace id is still the placeholder (${kvId}). ` +
        "Run: npx wrangler kv namespace create STATE  and paste the returned id into wrangler.toml.",
    );
  }
}

// --- TIMEZONE -------------------------------------------------------------
// An invalid zone throws a bare RangeError on the first sync, which surfaces as
// an opaque error on every source at once.
const timeZone = readString("TIMEZONE");
if (timeZone) {
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone });
  } catch {
    errors.push(`TIMEZONE "${timeZone}" is not a zone Intl recognises (expected e.g. "Europe/Berlin").`);
  }
} else {
  notes.push('TIMEZONE is unset; the worker falls back to its built-in default.');
}

// --- Per-integration settings ----------------------------------------------
// Driven entirely by scripts/settings-manifest.json (see the file header above) rather than a
// hand-maintained integration list — adding an integration here means regenerating the manifest,
// not editing this script.
let manifest;
try {
  manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
} catch (cause) {
  errors.push(
    `Cannot read scripts/settings-manifest.json (${cause.message}). ` +
      "Generate it with: npm run generate:settings-manifest",
  );
  manifest = {};
}

const configuredIntegrations = [];
for (const [integrationName, descriptors] of Object.entries(manifest)) {
  const rawByKey = {};
  for (const descriptor of descriptors) {
    rawByKey[descriptor.key] = readString(descriptor.variableName);
  }

  // Type validation only applies to what preflight can actually see — secrets live only in
  // Cloudflare, never in a file preflight can read, so they're validated for pairing below but
  // never for type.
  for (const descriptor of descriptors) {
    const raw = rawByKey[descriptor.key];
    if (descriptor.secret || !raw) continue;
    if (descriptor.type === "number" && !Number.isFinite(Number(raw))) {
      errors.push(`${descriptor.variableName} must be a number, got "${raw}".`);
    } else if (descriptor.type === "json") {
      try {
        JSON.parse(raw);
      } catch (cause) {
        errors.push(`${descriptor.variableName} is not valid JSON: ${cause.message}`);
      }
    }
  }

  // Pairing: every integration needs its habitId plus every other required (non-secret) setting
  // set together, or it stays "disabled" and silently logs nothing — worth a warning either way.
  const habitIdDescriptor = descriptors.find((descriptor) => descriptor.key === "habitId");
  const habitIdSet = Boolean(habitIdDescriptor && rawByKey.habitId);
  const requiredNonSecret = descriptors.filter((descriptor) => descriptor.required && !descriptor.secret && descriptor.key !== "habitId");
  const missingRequired = requiredNonSecret.filter((descriptor) => !rawByKey[descriptor.key]);
  const configuredNonHabit = descriptors.filter((descriptor) => descriptor.key !== "habitId" && rawByKey[descriptor.key]);

  if (!habitIdSet) {
    if (configuredNonHabit.length > 0) {
      warnings.push(
        `${integrationName}: ${configuredNonHabit.map((descriptor) => descriptor.variableName).join(", ")} is set but ` +
          `${habitIdDescriptor?.variableName ?? "its habitId var"} is empty, so the integration stays disabled.`,
      );
    }
    continue;
  }
  if (missingRequired.length > 0) {
    warnings.push(
      `${integrationName}: habitId is set but ${missingRequired.map((descriptor) => descriptor.variableName).join(", ")} is empty, ` +
        "so the integration stays disabled.",
    );
    continue;
  }

  const secretVars = descriptors.filter((descriptor) => descriptor.secret).map((descriptor) => descriptor.variableName);
  configuredIntegrations.push(
    secretVars.length > 0 ? `${integrationName} (also needs secrets: ${secretVars.join(", ")})` : integrationName,
  );
}

if (Object.keys(manifest).length > 0) {
  if (configuredIntegrations.length === 0) {
    warnings.push("No integration is fully configured in wrangler.toml; the worker will deploy but sync nothing.");
  } else {
    notes.push(`Configured integrations: ${configuredIntegrations.join("; ")}`);
  }
}

notes.push("Secrets live in Cloudflare and cannot be checked from here — verify with: npx wrangler secret list");

// --- Report ---------------------------------------------------------------
for (const note of notes) console.log(`note:    ${note}`);
for (const warning of warnings) console.log(`warning: ${warning}`);
for (const error of errors) console.error(`error:   ${error}`);

if (errors.length > 0) {
  console.error(`\npreflight failed with ${errors.length} error(s).`);
  process.exit(1);
}
console.log("\npreflight passed.");
