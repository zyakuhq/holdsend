// Fails if any tracked file contains personal data or private names.
//
// Checks: email addresses (outside a short allowlist), phone numbers, IPv4
// addresses (outside documentation and loopback ranges), private hostnames
// and paths, cloud resource identifiers, internal codenames, and a denylist of
// private names.
//
// The denylist is stored as SHA-256 hashes (scripts/pii-denylist.sha256), so
// publishing the list does not publish the names it protects. Extra plaintext
// terms can be added locally in .pii-denylist (gitignored) or in CI through
// the PII_DENYLIST secret (comma separated).
//
// Output names the file, line and rule only, never the matched text: CI logs
// of a public repository are public, and printing a leak would repeat it.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

const ALLOWED_EMAILS = new Set(["security@zyaku.com"]);
const ALLOWED_EMAIL_DOMAINS = [/@example\.(com|org|net)$/i, /@users\.noreply\.github\.com$/i];
const ALLOWED_IPS = [/^127\./, /^0\.0\.0\.0$/, /^192\.0\.2\./, /^198\.51\.100\./, /^203\.0\.113\./, /^255\.255\.255\.255$/];

// Files that are generated or binary, or that by design hold the patterns.
const SKIP = [/^package-lock\.json$/, /(^|\/)node_modules\//, /(^|\/)dist\//, /\.(png|jpe?g|gif|ico|woff2?|pdf)$/i, /^LICENSE$/];

// North American numbers 555-0100 to 555-0199 are reserved for fiction and
// can never belong to anyone, so tests and docs may use them.
function fictionalPhone(match) {
  return /^1?\d{3}55501\d{2}$/.test(match.replace(/\D/g, ""));
}

const RULES = [
  { name: "email", re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, allow: (m) => ALLOWED_EMAILS.has(m.toLowerCase()) || ALLOWED_EMAIL_DOMAINS.some((r) => r.test(m)) },
  { name: "phone", re: /(?<![\w.:-])\+\d{1,3}[\s-]?\d[\d\s-]{6,14}\d(?![\w.:-])/g, allow: (m) => fictionalPhone(m) },
  { name: "phone", re: /(?<![\w.:/-])\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}(?![\w.:-])/g, allow: (m) => fictionalPhone(m) },
  { name: "ipv4", re: /(?<![\w.])(?:\d{1,3}\.){3}\d{1,3}(?![\w.])/g, allow: (m) => ALLOWED_IPS.some((r) => r.test(m)) },
  { name: "private-host", re: /\b[a-z0-9-]+\.zyaku\.com\b/gi },
  { name: "private-path", re: /zyaku\.com\/(?:internal|admin|api|ops|staging)\b/gi },
  { name: "internal-tld", re: /\b[a-z0-9-]+\.(?:internal|corp|lan)\b/gi },
  { name: "cloud-resource", re: /\barn:aws:[a-z0-9-]+:/gi },
  // Hostnames of deployed services on common hosting platforms.
  { name: "cloud-resource", re: /\b[a-z0-9.-]+\.(?:amazonaws\.com|cloudfront\.net|herokuapp\.com|vercel\.app|netlify\.app|fly\.dev|onrender\.com|railway\.app|rlwy\.net|azurewebsites\.net|run\.app|appspot\.com|workers\.dev|pages\.dev)\b/gi },
  { name: "codename", re: /\bZY-[A-Z][A-Z0-9-]{2,}\b/g },
];

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

function loadDenylist() {
  const hashes = new Set();
  const file = "scripts/pii-denylist.sha256";
  if (existsSync(file)) {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      const h = line.trim().split(/\s+/)[0];
      if (/^[0-9a-f]{64}$/.test(h ?? "")) hashes.add(h);
    }
  }
  const plain = [];
  if (existsSync(".pii-denylist")) plain.push(...readFileSync(".pii-denylist", "utf8").split("\n"));
  if (process.env.PII_DENYLIST) plain.push(...process.env.PII_DENYLIST.split(","));
  for (const term of plain) {
    const t = term.trim().toLowerCase();
    if (t && !t.startsWith("#")) hashes.add(sha256(t));
  }
  return hashes;
}

function tokens(line) {
  const out = new Set();
  for (const raw of line.toLowerCase().match(/[a-z0-9][a-z0-9_.\-/]*[a-z0-9]/g) ?? []) {
    out.add(raw);
    for (const part of raw.split(/[/.]/)) if (part) out.add(part);
    for (const part of raw.split(/[/._-]/)) if (part) out.add(part);
  }
  return out;
}

function trackedFiles() {
  const out = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], { encoding: "utf8" });
  return out.split("\n").filter(Boolean).filter((f) => !SKIP.some((r) => r.test(f)) && existsSync(f));
}

const denylist = loadDenylist();
const findings = [];

for (const file of trackedFiles()) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    continue;
  }
  if (text.includes("\u0000")) continue;
  const lines = text.split("\n");
  lines.forEach((line, index) => {
    for (const rule of RULES) {
      for (const match of line.matchAll(rule.re)) {
        if (rule.allow && rule.allow(match[0])) continue;
        findings.push(`${file}:${index + 1} ${rule.name}`);
      }
    }
    if (denylist.size) {
      for (const token of tokens(line)) {
        if (denylist.has(sha256(token))) {
          findings.push(`${file}:${index + 1} denylisted-name`);
          break;
        }
      }
    }
  });
}

if (findings.length) {
  console.error(`pii-scan: ${findings.length} finding(s). Matched text is not printed.`);
  for (const f of [...new Set(findings)]) console.error(`  ${f}`);
  process.exit(1);
}
console.log(`pii-scan: clean (${denylist.size} denylisted names checked)`);
