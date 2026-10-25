import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const src = (pkg: string) => fileURLToPath(new URL(`./packages/${pkg}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    // Tests run against the source of every package, so no build is needed first.
    alias: {
      "@holdsend/core": src("core"),
      "@holdsend/server": src("server"),
      "@holdsend/web": src("web"),
      "@holdsend/react-native": src("react-native"),
    },
  },
  test: {
    include: ["packages/*/test/**/*.test.ts", "test/**/*.test.ts"],
    environment: "node",
    testTimeout: 30_000,
  },
});
