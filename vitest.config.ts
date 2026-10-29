import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const src = (pkg: string, file = "index") => fileURLToPath(new URL(`./packages/${pkg}/src/${file}.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    // Tests run against the source of every package, so no build is needed first.
    alias: [
      { find: /^@holdsend\/core\/emergency$/, replacement: src("core", "emergency") },
      { find: /^@holdsend\/core$/, replacement: src("core") },
      { find: /^@holdsend\/server$/, replacement: src("server") },
      { find: /^@holdsend\/web$/, replacement: src("web") },
      { find: /^@holdsend\/react-native$/, replacement: src("react-native") },
    ],
  },
  test: {
    include: ["packages/*/test/**/*.test.ts", "test/**/*.test.ts"],
    environment: "node",
    testTimeout: 30_000,
  },
});
