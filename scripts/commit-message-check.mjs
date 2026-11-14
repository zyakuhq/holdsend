// Fails if a commit message carries a tool attribution line: a
// Co-Authored-By trailer naming an AI tool, a tool session link, or a
// "Generated with" footer. Commit messages are written by people, for people.
//
//   node scripts/commit-message-check.mjs            every commit on HEAD
//   node scripts/commit-message-check.mjs A..B       a range (CI, pull requests)
//   node scripts/commit-message-check.mjs --file F   one message (commit-msg hook)
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const TOOLS = "claude|anthropic|openai|chatgpt|copilot|gemini|cursor|codeium|devin";
const RULES = [
  new RegExp(`^co-authored-by:.*(${TOOLS})`, "im"),
  /^[a-z-]*session:\s*https?:\/\//im,
  /(claude\.ai|chatgpt\.com)\//i,
  new RegExp(`generated (with|by) .*(${TOOLS})`, "i"),
];

export function findAttribution(message) {
  return RULES.some((rule) => rule.test(message));
}

const args = process.argv.slice(2);
let messages;
if (args[0] === "--file") {
  messages = [["(new commit)", readFileSync(args[1], "utf8").replace(/^#.*$/gm, "")]];
} else {
  const range = args[0] ?? "HEAD";
  const log = execFileSync("git", ["log", "--format=%H%x00%B%x01", range], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  messages = log
    .split("\x01")
    .map((entry) => entry.replace(/^\s+/, ""))
    .filter(Boolean)
    .map((entry) => entry.split("\x00"));
}

const bad = messages.filter(([, body]) => findAttribution(body ?? "")).map(([sha]) => sha);
if (bad.length > 0) {
  console.error(`commit-message-check: ${bad.length} commit message(s) carry a tool attribution line. Remove it:`);
  for (const sha of bad) console.error(`  ${sha}`);
  process.exit(1);
}
console.log(`commit-message-check: clean (${messages.length} message(s))`);
