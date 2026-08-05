#!/usr/bin/env node
/**
 * Validates wrangler.toml before a deploy, so misconfiguration surfaces here
 * rather than as a rejected deploy or a "disabled"/"error" source at the next
 * hourly sync.
 *
 * Reads the file as text and matches the handful of keys it cares about, which
 * keeps this dependency-free — a TOML parser would be the project's only
 * dependency and would earn its place only if this grew a lot more checks.
 *
 * Exit 0 = safe to deploy (warnings may still be printed), exit 1 = fix first.
 */
import { readFileSync } from "node:fs";

const CONFIG_PATH = new URL("../wrangler.toml", import.meta.url);
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

// --- KINDLE_PAGE_COUNTS ---------------------------------------------------
// Malformed JSON here degrades silently to the estimate tier at runtime, so a
// typo is otherwise invisible unless you go read a book's pageCountSource.
const pageCounts = readString("KINDLE_PAGE_COUNTS");
if (pageCounts) {
  let parsed;
  try {
    parsed = JSON.parse(pageCounts);
  } catch (cause) {
    errors.push(`KINDLE_PAGE_COUNTS is not valid JSON: ${cause.message}`);
  }
  if (parsed !== undefined) {
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      errors.push("KINDLE_PAGE_COUNTS must be a JSON object mapping asin -> printed page count.");
    } else {
      for (const [asin, pages] of Object.entries(parsed)) {
        if (typeof pages !== "number" || !Number.isFinite(pages) || pages <= 0) {
          errors.push(`KINDLE_PAGE_COUNTS["${asin}"] must be a positive number, got ${JSON.stringify(pages)}.`);
        }
      }
    }
  }
}

// --- Integration pairing --------------------------------------------------
// Each integration needs its habit id plus its own config before it does
// anything; a half-configured one stays "disabled" and silently logs nothing.
const integrations = [
  { name: "strava", habitVar: "HABIT_ID_STRAVA", extras: [], secrets: ["STRAVA_CLIENT_ID", "STRAVA_CLIENT_SECRET"] },
  { name: "wakatime", habitVar: "HABIT_ID_WAKATIME", extras: [], secrets: ["WAKATIME_API_KEY"] },
  { name: "kindle", habitVar: "HABIT_ID_KINDLE", extras: [], secrets: [] },
  { name: "keybr", habitVar: "HABIT_ID_KEYBR", extras: ["KEYBR_PUBLIC_ID"], secrets: [] },
];

const configured = [];
for (const integration of integrations) {
  const habitId = readString(integration.habitVar);
  const missingExtras = integration.extras.filter((extra) => !readString(extra));

  if (!habitId) {
    if (missingExtras.length < integration.extras.length) {
      warnings.push(
        `${integration.name}: ${integration.extras.filter((e) => readString(e)).join(", ")} is set but ` +
          `${integration.habitVar} is empty, so the integration stays disabled.`,
      );
    }
    continue;
  }

  if (missingExtras.length > 0) {
    warnings.push(
      `${integration.name}: ${integration.habitVar} is set but ${missingExtras.join(", ")} is empty, ` +
        "so the integration stays disabled.",
    );
    continue;
  }

  configured.push(
    integration.secrets.length > 0
      ? `${integration.name} (also needs secrets: ${integration.secrets.join(", ")})`
      : integration.name,
  );
}

if (configured.length === 0) {
  warnings.push("No integration is fully configured in wrangler.toml; the worker will deploy but sync nothing.");
} else {
  notes.push(`Configured integrations: ${configured.join("; ")}`);
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
