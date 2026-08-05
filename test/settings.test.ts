import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  configKvKey,
  deriveVariableName,
  readConfigOverrides,
  settingsForIntegration,
  SettingsResolver,
  writeConfigOverrides,
} from "../src/settings";
import type { Env, SettingDescriptor } from "../src/integrations/types";

describe("deriveVariableName", () => {
  // Every live variable name in wrangler.toml today, taken straight from the design doc's table.
  // A mismatch here would silently orphan real, already-deployed configuration.
  it.each([
    ["kindle", "wordsPerPage", "KINDLE_WORDS_PER_PAGE"],
    ["kindle", "pageCounts", "KINDLE_PAGE_COUNTS"],
    ["kindle", "positionsPerPage", "KINDLE_POSITIONS_PER_PAGE"],
    ["keybr", "publicId", "KEYBR_PUBLIC_ID"],
    ["wakatime", "apiKey", "WAKATIME_API_KEY"],
    ["strava", "clientId", "STRAVA_CLIENT_ID"],
    ["strava", "clientSecret", "STRAVA_CLIENT_SECRET"],
    ["strava", "habitId", "HABIT_ID_STRAVA"],
    ["wakatime", "habitId", "HABIT_ID_WAKATIME"],
    ["kindle", "habitId", "HABIT_ID_KINDLE"],
    ["keybr", "habitId", "HABIT_ID_KEYBR"],
  ])("derives %s.%s as %s", (integrationName, key, expected) => {
    expect(deriveVariableName(integrationName, key)).toBe(expected);
  });
});

const STRING_SETTING: SettingDescriptor = { key: "publicId", type: "string", required: true, description: "d" };
const OPTIONAL_STRING_SETTING: SettingDescriptor = { key: "note", type: "string", description: "d" };
const NUMBER_SETTING: SettingDescriptor = { key: "wordsPerPage", type: "number", default: "250", description: "d" };
const JSON_SETTING: SettingDescriptor = { key: "pageCounts", type: "json", description: "d" };
const SECRET_SETTING: SettingDescriptor = { key: "apiKey", type: "string", secret: true, required: true, description: "d" };

function makeResolver(testEnv: Env, descriptors: SettingDescriptor[], integrationName = "widget"): SettingsResolver {
  return new SettingsResolver(testEnv, testEnv.STATE, integrationName, descriptors);
}

describe("SettingsResolver precedence", () => {
  it("resolves the default when neither KV nor env has a value", async () => {
    const resolver = makeResolver({ ...env }, [NUMBER_SETTING]);
    const resolved = await resolver.resolve("wordsPerPage");
    expect(resolved).toMatchObject({ value: "250", source: "default" });
  });

  it("resolves env over the default", async () => {
    const testEnv: Env = { ...env, WIDGET_WORDS_PER_PAGE: "300" };
    const resolved = await makeResolver(testEnv, [NUMBER_SETTING]).resolve("wordsPerPage");
    expect(resolved).toMatchObject({ value: "300", source: "env" });
  });

  it("resolves a KV override over env over the default", async () => {
    const testEnv: Env = { ...env, WIDGET_WORDS_PER_PAGE: "300" };
    await writeConfigOverrides(testEnv.STATE, "widget", { wordsPerPage: "400" });
    const resolved = await makeResolver(testEnv, [NUMBER_SETTING]).resolve("wordsPerPage");
    expect(resolved).toMatchObject({ value: "400", source: "kv" });
  });

  it("treats an empty-string env value as unset, falling through to the default", async () => {
    const testEnv: Env = { ...env, WIDGET_WORDS_PER_PAGE: "" };
    const resolved = await makeResolver(testEnv, [NUMBER_SETTING]).resolve("wordsPerPage");
    expect(resolved).toMatchObject({ value: "250", source: "default" });
  });

  it("resolves undefined with source 'unset' for an optional setting with no default and nothing configured", async () => {
    const resolved = await makeResolver({ ...env }, [OPTIONAL_STRING_SETTING]).resolve("note");
    expect(resolved).toMatchObject({ value: undefined, source: "unset" });
  });

  it("throws when asked to resolve a key nobody declared", async () => {
    const resolver = makeResolver({ ...env }, [NUMBER_SETTING]);
    await expect(resolver.resolve("nonexistent")).rejects.toThrow(/not a declared setting/);
  });
});

describe("SettingsResolver secret handling", () => {
  it("never reads a secret from KV, even if one is present there", async () => {
    const testEnv: Env = { ...env, WIDGET_API_KEY: "from-env" };
    // A secret key should never legitimately end up in the KV overrides blob (PUT rejects it
    // before it's written), but the resolver must ignore it defensively even if it somehow did.
    await writeConfigOverrides(testEnv.STATE, "widget", { apiKey: "smuggled-via-kv" });
    const resolved = await makeResolver(testEnv, [SECRET_SETTING]).resolve("apiKey");
    expect(resolved).toMatchObject({ value: "from-env", source: "env" });
  });

  it("resolves a secret from env when no KV entry exists", async () => {
    const testEnv: Env = { ...env, WIDGET_API_KEY: "from-env" };
    const resolved = await makeResolver(testEnv, [SECRET_SETTING]).resolve("apiKey");
    expect(resolved).toMatchObject({ value: "from-env", source: "env" });
  });
});

// No `default`, unlike NUMBER_SETTING/JSON_SETTING above — used to prove getNumber/getJson still
// throw when there is truly nothing sensible to fall back to.
const NUMBER_SETTING_NO_DEFAULT: SettingDescriptor = { key: "limit", type: "number", description: "d" };
const JSON_SETTING_NO_DEFAULT: SettingDescriptor = { key: "extras", type: "json", description: "d" };
const SECRET_NUMBER_SETTING_NO_DEFAULT: SettingDescriptor = {
  key: "secretLimit",
  type: "number",
  secret: true,
  description: "d",
};

describe("SettingsResolver.getNumber", () => {
  it("parses a resolved numeric string", async () => {
    const testEnv: Env = { ...env, WIDGET_WORDS_PER_PAGE: "300" };
    expect(await makeResolver(testEnv, [NUMBER_SETTING]).getNumber("wordsPerPage")).toBe(300);
  });

  it("returns undefined for an unset optional number setting with no default", async () => {
    expect(await makeResolver({ ...env }, [NUMBER_SETTING_NO_DEFAULT]).getNumber("limit")).toBeUndefined();
  });

  // Matches the pre-resolver behavior every integration relied on (`Number(x) || DEFAULT`): a
  // malformed value degrades to the declared default rather than failing the whole sync.
  it("falls back to the default when the resolved value is malformed but a default is declared", async () => {
    const testEnv: Env = { ...env, WIDGET_WORDS_PER_PAGE: "25o" };
    expect(await makeResolver(testEnv, [NUMBER_SETTING]).getNumber("wordsPerPage")).toBe(250);
  });

  it("throws naming the derived variable when the resolved value isn't numeric and there is no default", async () => {
    const testEnv: Env = { ...env, WIDGET_LIMIT: "not-a-number" };
    await expect(makeResolver(testEnv, [NUMBER_SETTING_NO_DEFAULT]).getNumber("limit")).rejects.toThrow(
      "WIDGET_LIMIT must be a number",
    );
  });

  it("redacts the malformed value in the thrown error when the setting is a secret", async () => {
    const testEnv: Env = { ...env, WIDGET_SECRET_LIMIT: "super-secret-garbage" };
    await expect(makeResolver(testEnv, [SECRET_NUMBER_SETTING_NO_DEFAULT]).getNumber("secretLimit")).rejects.toThrow(
      "[redacted]",
    );
    await expect(
      makeResolver(testEnv, [SECRET_NUMBER_SETTING_NO_DEFAULT]).getNumber("secretLimit"),
    ).rejects.not.toThrow(/super-secret-garbage/);
  });
});

describe("SettingsResolver.getJson", () => {
  it("parses resolved JSON", async () => {
    const testEnv: Env = { ...env, WIDGET_PAGE_COUNTS: '{"a":1}' };
    expect(await makeResolver(testEnv, [JSON_SETTING]).getJson("pageCounts")).toEqual({ a: 1 });
  });

  it("returns undefined when unset", async () => {
    expect(await makeResolver({ ...env }, [JSON_SETTING]).getJson("pageCounts")).toBeUndefined();
  });

  it("falls back to the default when the resolved value is malformed but a default is declared", async () => {
    const jsonWithDefault: SettingDescriptor = { key: "pageCounts", type: "json", default: "{}", description: "d" };
    const testEnv: Env = { ...env, WIDGET_PAGE_COUNTS: "not json" };
    expect(await makeResolver(testEnv, [jsonWithDefault]).getJson("pageCounts")).toEqual({});
  });

  it("throws naming the derived variable on invalid JSON syntax and there is no default", async () => {
    const testEnv: Env = { ...env, WIDGET_EXTRAS: "not json" };
    await expect(makeResolver(testEnv, [JSON_SETTING_NO_DEFAULT]).getJson("extras")).rejects.toThrow(
      "WIDGET_EXTRAS must be valid JSON",
    );
  });
});

describe("SettingsResolver.resolveAll", () => {
  it("includes the implicit habitId alongside the integration's declared settings", async () => {
    const testEnv: Env = { ...env, HABIT_ID_WIDGET: "habit-1" };
    const resolved = await makeResolver(testEnv, [STRING_SETTING]).resolveAll();
    expect(resolved.map((setting) => setting.key).sort()).toEqual(["habitId", "publicId"]);
    expect(resolved.find((setting) => setting.key === "habitId")).toMatchObject({ value: "habit-1", source: "env" });
  });
});

describe("SettingsResolver.isEnabled", () => {
  it("is false when a required setting is missing and true once every required setting resolves", async () => {
    const withoutPublicId: Env = { ...env, HABIT_ID_WIDGET: "habit-1" };
    expect(await makeResolver(withoutPublicId, [STRING_SETTING]).isEnabled()).toBe(false);

    const withPublicId: Env = { ...env, HABIT_ID_WIDGET: "habit-1", WIDGET_PUBLIC_ID: "pub-1" };
    expect(await makeResolver(withPublicId, [STRING_SETTING]).isEnabled()).toBe(true);
  });

  it("is false when every declared setting is present but the implicit habitId is missing", async () => {
    const withoutHabitId: Env = { ...env, WIDGET_PUBLIC_ID: "pub-1" };
    expect(await makeResolver(withoutHabitId, [STRING_SETTING]).isEnabled()).toBe(false);
  });

  it("ignores optional (non-required) settings entirely", async () => {
    const testEnv: Env = { ...env, HABIT_ID_WIDGET: "habit-1" };
    expect(await makeResolver(testEnv, [OPTIONAL_STRING_SETTING]).isEnabled()).toBe(true);
  });
});

describe("settingsForIntegration", () => {
  it("appends the implicit habitId descriptor to an integration's own declared settings", () => {
    const descriptors = settingsForIntegration({ settings: [STRING_SETTING] });
    expect(descriptors.map((descriptor) => descriptor.key)).toEqual(["publicId", "habitId"]);
  });
});

describe("config KV overrides", () => {
  it("round-trips overrides through configKvKey", async () => {
    await writeConfigOverrides(env.STATE, "roundtrip", { foo: "bar" });
    expect(await readConfigOverrides(env.STATE, "roundtrip")).toEqual({ foo: "bar" });
    expect(await env.STATE.get(configKvKey("roundtrip"))).toBe(JSON.stringify({ foo: "bar" }));
  });

  it("returns an empty object when nothing has been stored", async () => {
    expect(await readConfigOverrides(env.STATE, "never-configured")).toEqual({});
  });
});
