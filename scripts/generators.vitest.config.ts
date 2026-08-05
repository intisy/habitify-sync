import { defineConfig } from "vitest/config";

// A separate, plain-Node config shared by every "generate:*" npm script — scripts/*.vitest.ts
// files that regenerate a committed artifact from the live registry (scripts/settings-manifest.json,
// the README's integrations block). Deliberately NOT using defineWorkersConfig/the workers pool the
// rest of the suite runs under: workerd's Node.js fs compat shim is a virtual, read-only mount of
// the bundled source with no access to the real project directory, so writeFileSync inside it fails
// with ENOENT no matter what path is given (confirmed by hand). Plain Node (vitest's default pool)
// has real disk access, which every generator here needs.
//
// This also means vitest's CLI filters narrow an already-collected file set rather than adding to
// it, so each generator (excluded from the default `npm test` sweep on purpose — see its own file
// comment) needs to be listed here to be runnable at all. Each npm script passes a path filter
// (e.g. `-- scripts/generate-settings-manifest.vitest.ts`) so running one generator never triggers
// the other's write as a side effect.
export default defineConfig({
  test: {
    include: ["scripts/generate-settings-manifest.vitest.ts", "scripts/generate-readme-integrations.vitest.ts"],
  },
});
