// Builds the docs site (GitHub Pages) from the Markdown already in the repo,
// so the site and the repository never say different things.
//
//   node scripts/build-site.mjs [outDir]      (default: site)
//
// Every page is a Markdown file listed in PAGES. Links between them become
// links between pages; links to anything else in the repo go to GitHub.
import { existsSync, statSync } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, normalize, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { Marked } from "marked";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const REPO = "https://github.com/zyakuhq/holdsend";

/** Navigation order. Each entry: [section, [[title, source file], ...]]. */
export const PAGES = [
  ["Start", [["HoldSend", "README.md"]]],
  [
    "Packages",
    [
      ["@holdsend/core", "packages/core/README.md"],
      ["@holdsend/server", "packages/server/README.md"],
      ["@holdsend/web", "packages/web/README.md"],
      ["@holdsend/react-native", "packages/react-native/README.md"],
    ],
  ],
  [
    "Examples",
    [
      ["Notes (plain web)", "examples/notes/README.md"],
      ["Notes in React", "examples/react/README.md"],
      ["Notes on a phone (Expo)", "examples/expo/README.md"],
    ],
  ],
  [
    "How it works",
    [
      ["Before you ship", "docs/production.md"],
      ["Upgrading", "docs/upgrading.md"],
      ["Wire protocol", "docs/protocol.md"],
      ["Emergency messages", "docs/emergency.md"],
      ["One draft on two devices", "docs/drafts.md"],
      ["Long queues and slow phones", "docs/low-end.md"],
      ["How it is tested", "docs/testing.md"],
      ["Design notes", "docs/reference-notes.md"],
      ["Status and roadmap", "docs/STATUS.md"],
      ["Changelog", "CHANGELOG.md"],
      ["Releasing", "docs/releasing.md"],
    ],
  ],
  [
    "Decisions",
    [
      ["0001 Name and licence", "docs/decisions/0001-name-and-licence.md"],
      ["0002 Core state model", "docs/decisions/0002-core-state-model.md"],
      ["0003 Written-At header", "docs/decisions/0003-written-at-header.md"],
      ["0004 Server idempotency store", "docs/decisions/0004-server-idempotency-store.md"],
      ["0005 Web store and tabs", "docs/decisions/0005-web-store-and-tabs.md"],
      ["0006 React Native store", "docs/decisions/0006-react-native-store-and-scheduler.md"],
      ["0007 Emergency messages", "docs/decisions/0007-emergency-messages.md"],
      ["0008 Flush order", "docs/decisions/0008-flush-order.md"],
      ["0009 One draft on two devices", "docs/decisions/0009-two-device-drafts.md"],
      ["0010 Android background task", "docs/decisions/0010-android-background-task.md"],
      ["0011 What 0.2.0 ships", "docs/decisions/0011-what-0.2.0-ships.md"],
      ["0012 Public API record", "docs/decisions/0012-api-record.md"],
      ["0013 API review for 1.0", "docs/decisions/0013-api-review-for-1.0.md"],
      ["0014 Core size budget", "docs/decisions/0014-core-budget-5.25kb.md"],
      ["0015 Drafts and the 1.0 promise", "docs/decisions/0015-drafts-and-the-1.0-promise.md"],
      ["0016 Android emulator in CI", "docs/decisions/0016-android-emulator-ci.md"],
      ["0017 Commit email exceptions", "docs/decisions/0017-commit-email-exceptions.md"],
      ["0018 Offline mid-flush", "docs/decisions/0018-offline-mid-flush.md"],
      ["0019 Schema without boot locks", "docs/decisions/0019-schema-without-boot-locks.md"],
      ["0020 Smoke-test the tarballs", "docs/decisions/0020-smoke-test-the-tarballs.md"],
      ["0021 Checks for the client Store contract", "docs/decisions/0021-client-store-contract-checks.md"],
    ],
  ],
  [
    "Audits",
    [
      ["First and second audits", "docs/audits/2026-10-25-first-independent-audit.md"],
      ["Third audit (before 0.1.0)", "docs/audits/2026-10-26-third-audit.md"],
      ["Source review of 0.1.0", "docs/audits/2026-10-27-source-review.md"],
      ["Phase 2 audit", "docs/audits/2026-10-30-phase2-audit.md"],
      ["Review before 0.3.0", "docs/audits/2026-11-21-pre-0.3-review.md"],
    ],
  ],
  [
    "Project",
    [
      ["Contributing", "CONTRIBUTING.md"],
      ["Security", "SECURITY.md"],
      ["Governance", "GOVERNANCE.md"],
      ["Code of conduct", "CODE_OF_CONDUCT.md"],
    ],
  ],
];

/** Where a source file is published: README.md becomes index.html of its folder. */
export function outputPath(source) {
  const dir = posix.dirname(source);
  const base = posix.basename(source, ".md");
  const file = base === "README" ? "index.html" : `${base}.html`;
  return dir === "." ? file : `${dir}/${file}`;
}

/** The id GitHub gives a heading: lower case, punctuation dropped, spaces to hyphens, repeats numbered. */
export function slugify(text, seen = new Map()) {
  const base = text
    .toLowerCase()
    // Everything but letters, digits, spaces, "_" and "-" goes, so no markup can reach the id.
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .trim()
    .replace(/\s/g, "-");
  const n = seen.get(base) ?? 0;
  seen.set(base, n + 1);
  return n ? `${base}-${n}` : base;
}

const escapeHtml = (text) => text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

/**
 * Rewrites one link found in `source`. Pages stay on the site; other repo
 * files go to GitHub; outside links are left alone.
 */
export function rewriteLink(href, source, published) {
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("#") || href.startsWith("//")) return href;
  const [path, hash = ""] = href.split("#");
  const anchor = hash ? `#${hash}` : "";
  if (path === "") return href;
  const target = posix.normalize(posix.join(posix.dirname(source), path)).replace(/\/$/, "");
  if (target.startsWith("..")) return href;
  // A standalone page under docs/tools is copied to the same path on the site.
  if (/^docs\/tools\/[^/]+\.html$/.test(target)) return `${posix.relative(posix.dirname(outputPath(source)), target)}${anchor}`;
  const candidates = [target, `${target}/README.md`];
  for (const candidate of candidates) {
    if (published.has(candidate)) {
      const from = posix.dirname(outputPath(source));
      return `${posix.relative(from, outputPath(candidate)) || posix.basename(outputPath(candidate))}${anchor}`;
    }
  }
  const onDisk = join(ROOT, target);
  const kind = existsSync(onDisk) && statSync(onDisk).isDirectory() ? "tree" : "blob";
  return `${REPO}/${kind}/main/${target}${anchor}`;
}

function layout({ title, body, nav, source, toRoot }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title === "HoldSend" ? "HoldSend: write offline, publish exactly once" : `${escapeHtml(title)} · HoldSend`}</title>
<meta name="description" content="HoldSend: write offline, publish exactly once. An open-source library for apps where what people write must not be lost.">
<link rel="stylesheet" href="${toRoot}style.css">
</head>
<body>
<a class="skip" href="#content">Skip to content</a>
<header class="top"><a class="brand" href="${toRoot}index.html">HoldSend</a><span class="tag">Write offline. Publish exactly once.</span><a class="gh" href="${REPO}">GitHub</a></header>
<div class="wrap">
<nav aria-label="Documentation">${nav}</nav>
<main id="content">
${body}
<p class="edit"><a href="${REPO}/blob/main/${source}">Edit this page on GitHub</a></p>
</main>
</div>
</body>
</html>
`;
}

const STYLE = `:root{--bg:#fbfaf7;--fg:#1d1d1b;--muted:#5f5e58;--line:#e2e0d8;--code:#f1efe8;--accent:#1f5f8b}
@media (prefers-color-scheme:dark){:root{--bg:#141412;--fg:#ecebe6;--muted:#a6a59d;--line:#2f2e2a;--code:#1f1e1b;--accent:#7db7e0}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.6 system-ui,sans-serif}
a{color:var(--accent)}.skip{position:absolute;left:-999px}.skip:focus{left:16px;top:8px;background:var(--bg);padding:4px 8px}
.top{display:flex;gap:16px;align-items:baseline;padding:14px 16px;border-bottom:1px solid var(--line);flex-wrap:wrap}
.brand{font-weight:700;font-size:1.15rem;text-decoration:none;color:var(--fg)}.tag{color:var(--muted);font-size:.9rem}.gh{margin-left:auto}
.wrap{display:grid;grid-template-columns:240px minmax(0,1fr);max-width:1120px;margin:0 auto}
nav{padding:20px 16px;border-right:1px solid var(--line);font-size:.92rem}nav h2{font-size:.75rem;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin:18px 0 6px}
nav ul{list-style:none;margin:0;padding:0}nav li{margin:2px 0}nav a{text-decoration:none;color:var(--fg)}nav a[aria-current=page]{color:var(--accent);font-weight:600}
main{padding:24px 32px 64px;min-width:0}main h1{margin-top:0;font-size:1.9rem}
pre{background:var(--code);padding:12px 14px;border-radius:8px;overflow-x:auto;font-size:.88rem}code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.9em}
:not(pre)>code{background:var(--code);padding:1px 5px;border-radius:4px}
table{border-collapse:collapse;display:block;overflow-x:auto;margin:12px 0}th,td{border:1px solid var(--line);padding:6px 10px;text-align:left;vertical-align:top}
blockquote{margin:12px 0;padding:4px 14px;border-left:3px solid var(--accent);color:var(--muted)}
.edit{margin-top:40px;font-size:.85rem;color:var(--muted)}
@media (max-width:760px){.wrap{grid-template-columns:1fr}main{order:1;padding:20px 16px 32px}nav{order:2;border-right:0;border-top:1px solid var(--line)}}
`;

/** Builds the site into `outDir`. Returns the list of pages written. */
export async function buildSite(outDir) {
  const published = new Set(PAGES.flatMap(([, items]) => items.map(([, source]) => source)));
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
  await writeFile(join(outDir, "style.css"), STYLE);
  await writeFile(join(outDir, ".nojekyll"), "");
  // Standalone pages (such as the SMS link check) are copied as they are.
  const tools = join(ROOT, "docs", "tools");
  for (const name of (await readdir(tools)).filter((n) => n.endsWith(".html"))) {
    await mkdir(join(outDir, "docs", "tools"), { recursive: true });
    await writeFile(join(outDir, "docs", "tools", name), await readFile(join(tools, name)));
  }
  const written = [];

  for (const [, items] of PAGES) {
    for (const [title, source] of items) {
      const markdown = await readFile(join(ROOT, source), "utf8");
      const out = outputPath(source);
      const toRoot = "../".repeat(out.split("/").length - 1);
      const slugs = new Map();
      const marked = new Marked({
        gfm: true,
        renderer: {
          // GitHub-style ids on headings, so a link to page.md#a-heading works on the site too.
          heading({ tokens, depth, text }) {
            const id = slugify(text, slugs);
            return `<h${depth} id="${id}">${this.parser.parseInline(tokens)}</h${depth}>\n`;
          },
        },
        walkTokens(token) {
          if ((token.type === "link" || token.type === "image") && token.href) token.href = rewriteLink(token.href, source, published);
        },
      });
      const body = await marked.parse(markdown);
      const nav = PAGES.map(
        ([section, entries]) =>
          `<h2>${escapeHtml(section)}</h2><ul>${entries
            .map(([label, target]) => {
              const href = posix.relative(posix.dirname(out), outputPath(target)) || posix.basename(outputPath(target));
              const current = target === source ? ' aria-current="page"' : "";
              return `<li><a href="${href}"${current}>${escapeHtml(label)}</a></li>`;
            })
            .join("")}</ul>`,
      ).join("");
      const file = join(outDir, normalize(out));
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, layout({ title, body, nav, source, toRoot }));
      written.push(out);
    }
  }
  return written;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === normalize(process.argv[1])) {
  const outDir = process.argv[2] ?? join(ROOT, "site");
  const pages = await buildSite(outDir);
  console.log(`site: ${pages.length} pages written to ${outDir}`);
}
