import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const file = (path: string) => readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), "utf8");

describe("the examples", () => {
  it("keep their copies of useOutboxEntries identical", () => {
    expect(file("examples/expo/src/use-outbox-entries.js")).toBe(file("examples/react/src/use-outbox-entries.js"));
  });
});
