// Scans every tracked file for secrets (keys, tokens, private keys,
// connection strings) with secretlint, installed from npm. It runs in
// `npm run check`, so it needs no separate download. CI also runs gitleaks
// over the full history on every pull request.
//
//   node scripts/secret-scan.mjs
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SKIP = [/^package-lock\.json$/, /\.(png|jpe?g|gif|ico|woff2?|pdf)$/i];
const files = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" })
  .split("\0")
  .filter((f) => f && !SKIP.some((re) => re.test(f)));

const bin = fileURLToPath(new URL("../node_modules/secretlint/bin/secretlint.js", import.meta.url));
try {
  execFileSync(process.execPath, [bin, "--maskSecrets", ...files], { stdio: "inherit" });
  console.log(`secret-scan: clean (${files.length} tracked files)`);
} catch {
  console.error("secret-scan: possible secrets found (shown masked above). Remove them before pushing.");
  process.exit(1);
}
