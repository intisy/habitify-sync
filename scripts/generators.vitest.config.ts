import { defineConfig } from "vitest/config";

// A separate, narrow-scoped config for `npm run generate:settings-manifest` only, deliberately
// NOT using defineWorkersConfig/the workers pool the rest of the suite runs under. workerd's
// Node.js fs compat shim is a virtual, read-only mount of the bundled source with no access to
// the real project directory — writeFileSync inside it fails with ENOENT no matter what path is
// given. Plain Node (vitest's default pool) has real disk access, which this generator needs
// since it writes scripts/settings-manifest.json.
//
// This also means vitest's CLI filters narrow an already-collected file set rather than adding to
// it, so this generator (excluded from the default `npm test` sweep on purpose — see its own
// file comment) needs its own `include` to be runnable at all.
export default defineConfig({
  test: {
    include: ["scripts/generate-settings-manifest.vitest.ts"],
  },
});
