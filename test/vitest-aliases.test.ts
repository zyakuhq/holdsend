import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import config from "../vitest.config";

const root = fileURLToPath(new URL("..", import.meta.url));
const packages = ["core", "server", "web", "react-native"];

describe("the test setup", () => {
  // Without an alias, an import of a subpath resolves to the built copy in
  // node_modules: tests then fail on a fresh checkout and silently test old
  // code after a source change until the next build.
  it("maps every published entry point to its source", () => {
    const aliases = (config.resolve?.alias ?? []) as { find: RegExp }[];
    const missing: string[] = [];
    for (const pkg of packages) {
      const exports = JSON.parse(readFileSync(`${root}packages/${pkg}/package.json`, "utf8")).exports as Record<string, unknown>;
      for (const sub of Object.keys(exports)) {
        if (sub === "./package.json") continue;
        const name = `@holdsend/${pkg}${sub === "." ? "" : sub.slice(1)}`;
        if (!aliases.some((a) => a.find.test(name))) missing.push(name);
      }
    }
    expect(missing).toEqual([]);
  });
});
