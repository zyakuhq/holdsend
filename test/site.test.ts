import { existsSync, readFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
// @ts-expect-error: a plain JavaScript build script, without type declarations.
import { buildSite } from "../scripts/build-site.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));

describe("the docs site", () => {
  it("builds every page, and every link points at a page or a file that exists", async () => {
    const out = mkdtempSync(join(tmpdir(), "holdsend-site-"));
    const pages: string[] = await buildSite(out);
    expect(pages.length).toBeGreaterThan(10);
    expect(existsSync(join(out, ".nojekyll"))).toBe(true);

    for (const page of pages) {
      const html = readFileSync(join(out, page), "utf8");
      expect(html, page).toMatch(/<title>[^<]+ · HoldSend<\/title>/);
      for (const [, href] of html.matchAll(/href="([^"]+)"/g)) {
        if (href!.startsWith("#")) continue;
        const repoPath = /^https:\/\/github\.com\/zyakuhq\/holdsend\/(?:blob|tree)\/main\/([^#]+)/.exec(href!);
        if (repoPath) {
          expect(existsSync(join(root, repoPath[1]!)), `${page} links to missing ${repoPath[1]}`).toBe(true);
          continue;
        }
        if (/^[a-z]+:/i.test(href!)) continue;
        const target = resolve(dirname(join(out, page)), href!.split("#")[0]!);
        expect(existsSync(target), `${page} links to missing ${href}`).toBe(true);
      }
    }
  });
});
