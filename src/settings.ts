import { readJson, writeJson } from "./state";
import type { Env, Integration, SettingDescriptor } from "./integrations/types";

// Every integration gets this setting automatically — it is never declared in an integration's
// own `settings` array. It is the one thing every integration needs (which Habitify habit to log
// into), so making it implicit means an addition can't forget it and no two integrations write
// slightly different versions of the same descriptor.
export const HABIT_ID_DESCRIPTOR: SettingDescriptor = {
  key: "habitId",
  type: "string",
  required: true,
  description: "Habitify habit id this integration logs into.",
};

// The full descriptor list for an integration, its own declared settings plus the implicit
// habitId. Exported so index.ts (config routes) and preflight can enumerate exactly what
// SettingsResolver itself resolves against, without re-deriving the habitId special case.
export function settingsForIntegration(integration: Pick<Integration, "settings">): SettingDescriptor[] {
  return [...integration.settings, HABIT_ID_DESCRIPTOR];
}

// Converts a camelCase setting key to SCREAMING_SNAKE_CASE, e.g. "wordsPerPage" -> "WORDS_PER_PAGE".
function toScreamingSnakeCase(key: string): string {
  return key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toUpperCase();
}

// Derives the environment variable name a setting resolves from — the one place this rule is
// written down. Every setting follows `<INTEGRATION>_<KEY>`; `habitId` is the one universal
// exception, reversing the order to `HABIT_ID_<INTEGRATION>` to match the vars every integration
// already ships with (HABIT_ID_STRAVA, HABIT_ID_WAKATIME, HABIT_ID_KINDLE, HABIT_ID_KEYBR) — see
// the design doc's table. Getting this wrong would silently orphan live configuration.
export function deriveVariableName(integrationName: string, key: string): string {
  const integrationUpper = integrationName.toUpperCase();
  if (key === "habitId") {
    return `HABIT_ID_${integrationUpper}`;
  }
  return `${integrationUpper}_${toScreamingSnakeCase(key)}`;
}

// One entry of the generated settings manifest (scripts/settings-manifest.json) — a descriptor
// plus its precomputed derived variable name, so a plain Node script (preflight) can validate
// wrangler.toml against exactly what the registry declares without importing any TypeScript at
// all. See buildSettingsManifest below and scripts/generate-settings-manifest.vitest.ts.
export interface ManifestSettingEntry {
  key: string;
  variableName: string;
  type: SettingDescriptor["type"];
  required: boolean;
  secret: boolean;
  default?: string;
  description: string;
}

// The single place that turns the live registry into the manifest scripts/preflight.mjs reads.
// Used by both scripts/generate-settings-manifest.vitest.ts (which writes the file) and
// test/settings-manifest.test.ts (which fails CI if the committed file has drifted from this),
// so there is exactly one implementation of "what the manifest should contain" to keep in sync.
export function buildSettingsManifest(
  integrations: readonly Pick<Integration, "name" | "settings">[],
): Record<string, ManifestSettingEntry[]> {
  const manifest: Record<string, ManifestSettingEntry[]> = {};
  for (const integration of integrations) {
    manifest[integration.name] = settingsForIntegration(integration).map((descriptor) => ({
      key: descriptor.key,
      variableName: deriveVariableName(integration.name, descriptor.key),
      type: descriptor.type,
      required: Boolean(descriptor.required),
      secret: Boolean(descriptor.secret),
      default: descriptor.default,
      description: descriptor.description,
    }));
  }
  return manifest;
}

export function configKvKey(integrationName: string): string {
  return `config:${integrationName}`;
}

// The KV overrides blob is a plain JSON object of key -> string, exactly what PUT /config accepts
// and GET /config would echo back for a non-secret setting. Never holds secrets — see the
// secret-handling asymmetry documented on SettingsResolver.resolve below.
export async function readConfigOverrides(kv: KVNamespace, integrationName: string): Promise<Record<string, string>> {
  return (await readJson<Record<string, string>>(kv, configKvKey(integrationName))) ?? {};
}

export async function writeConfigOverrides(
  kv: KVNamespace,
  integrationName: string,
  overrides: Record<string, string>,
): Promise<void> {
  await writeJson(kv, configKvKey(integrationName), overrides);
}

export type SettingSource = "kv" | "env" | "default" | "unset";

export interface ResolvedSetting {
  key: string;
  variableName: string;
  descriptor: SettingDescriptor;
  value: string | undefined;
  source: SettingSource;
}

// Resolves every setting of one integration — KV override, then environment, then the
// descriptor's default, highest precedence first (see the design doc). Scoped to a single
// integration name, so a setting can never accidentally be read under a name nobody declared.
//
// KV overrides are loaded once per resolver instance (not once per setting) and cached for the
// resolver's lifetime, since a single sync run or HTTP request resolves several settings off the
// same KV blob.
export class SettingsResolver {
  private readonly descriptors: SettingDescriptor[];
  private overridesPromise: Promise<Record<string, string>> | null = null;

  constructor(
    private readonly env: Env,
    private readonly kv: KVNamespace,
    private readonly integrationName: string,
    declaredSettings: SettingDescriptor[],
  ) {
    this.descriptors = [...declaredSettings, HABIT_ID_DESCRIPTOR];
  }

  private descriptorFor(key: string): SettingDescriptor {
    const descriptor = this.descriptors.find((candidate) => candidate.key === key);
    if (!descriptor) {
      throw new Error(`"${key}" is not a declared setting of ${this.integrationName}`);
    }
    return descriptor;
  }

  private async loadOverrides(): Promise<Record<string, string>> {
    if (!this.overridesPromise) {
      this.overridesPromise = readConfigOverrides(this.kv, this.integrationName);
    }
    return this.overridesPromise;
  }

  async resolve(key: string): Promise<ResolvedSetting> {
    const descriptor = this.descriptorFor(key);
    const variableName = deriveVariableName(this.integrationName, key);

    // Secrets are environment-only: never read from KV. This is what makes it impossible for a
    // secret to leak through the config API's storage path — there is no code path that ever
    // writes one there, since PUT rejects secret keys before they'd reach writeConfigOverrides.
    if (!descriptor.secret) {
      const overrides = await this.loadOverrides();
      const kvValue = overrides[key];
      if (kvValue !== undefined && kvValue !== "") {
        return { key, variableName, descriptor, value: kvValue, source: "kv" };
      }
    }

    const envValue = this.env[variableName];
    if (typeof envValue === "string" && envValue !== "") {
      return { key, variableName, descriptor, value: envValue, source: "env" };
    }

    if (descriptor.default !== undefined) {
      return { key, variableName, descriptor, value: descriptor.default, source: "default" };
    }

    return { key, variableName, descriptor, value: undefined, source: "unset" };
  }

  async getString(key: string): Promise<string | undefined> {
    return (await this.resolve(key)).value;
  }

  // Parses the resolved value as the descriptor's declared "number" type. Throws rather than
  // silently falling back on a non-numeric value, since PUT already validates KV overrides before
  // they're stored and preflight validates wrangler.toml before deploy — a bad number reaching
  // here means both checks were bypassed, which is worth surfacing loudly (as a sync-time error)
  // rather than masking.
  async getNumber(key: string): Promise<number | undefined> {
    const resolved = await this.resolve(key);
    if (resolved.value === undefined) return undefined;
    const parsed = Number(resolved.value);
    if (!Number.isFinite(parsed)) {
      throw new Error(`${resolved.variableName} must be a number, got ${JSON.stringify(resolved.value)}`);
    }
    return parsed;
  }

  // Parses the resolved value as JSON. Only JSON *syntax* is validated here; a value that parses
  // but has the wrong shape for a particular setting (e.g. KINDLE_PAGE_COUNTS holding a JSON array
  // instead of an object) is that integration's own concern, same as before this resolver existed.
  async getJson<T>(key: string): Promise<T | undefined> {
    const resolved = await this.resolve(key);
    if (resolved.value === undefined) return undefined;
    try {
      return JSON.parse(resolved.value) as T;
    } catch (cause) {
      throw new Error(`${resolved.variableName} must be valid JSON: ${(cause as Error).message}`);
    }
  }

  async resolveAll(): Promise<ResolvedSetting[]> {
    return Promise.all(this.descriptors.map((descriptor) => this.resolve(descriptor.key)));
  }

  // Derived enabled(): true when every required setting (habitId included, implicitly) resolves
  // to a non-empty value. This replaces each integration hand-writing its own enabled() — see the
  // design doc.
  async isEnabled(): Promise<boolean> {
    for (const descriptor of this.descriptors) {
      if (!descriptor.required) continue;
      const resolved = await this.resolve(descriptor.key);
      if (!resolved.value) return false;
    }
    return true;
  }
}
