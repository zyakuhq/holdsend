// Checks what each package would publish, without publishing anything.
//
//   node scripts/check-packages.mjs            (after npm run build)
//
// Fails when a package would ship anything but its build output, README,
// LICENSE and package.json; when the build output its exports point at is
// missing; when versions disagree; or when a package's metadata is missing
// something npm users rely on.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PACKAGES = ["core", "server", "web", "react-native"];
const ALLOWED = [/^package\.json$/, /^README\.md$/, /^LICENSE$/, /^dist\/.+\.(js|d\.ts|js\.map|d\.ts\.map)$/];

const problems = [];
const manifests = PACKAGES.map((dir) => ({ dir, pkg: JSON.parse(readFileSync(join(ROOT, "packages", dir, "package.json"), "utf8")) }));
const version = manifests[0].pkg.version;
const rootLicense = readFileSync(join(ROOT, "LICENSE"), "utf8");

for (const { dir, pkg } of manifests) {
  const where = `packages/${dir}`;
  const fail = (message) => problems.push(`${where}: ${message}`);

  if (pkg.version !== version) fail(`version ${pkg.version} differs from @holdsend/core ${version}`);
  for (const [name, range] of Object.entries(pkg.dependencies ?? {})) {
    if (name.startsWith("@holdsend/") && range !== version) fail(`depends on ${name}@${range}, expected ${version}`);
  }
  if (pkg.license !== "Apache-2.0") fail("license must be Apache-2.0");
  if (pkg.publishConfig?.access !== "public") fail("publishConfig.access must be public");
  if (pkg.publishConfig?.provenance !== true) fail("publishConfig.provenance must be true");
  for (const field of ["description", "repository", "homepage", "bugs", "engines", "keywords"]) {
    if (!pkg[field]) fail(`missing ${field}`);
  }
  if (readFileSync(join(ROOT, where, "LICENSE"), "utf8") !== rootLicense) fail("LICENSE differs from the repository's LICENSE");

  // The files npm would put in the tarball.
  const [packed] = JSON.parse(execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: join(ROOT, where), encoding: "utf8" }));
  const files = packed.files.map((f) => f.path);
  for (const file of files) {
    if (!ALLOWED.some((re) => re.test(file))) fail(`would publish ${file}`);
  }
  for (const required of ["package.json", "README.md", "LICENSE"]) {
    if (!files.includes(required)) fail(`would not publish ${required}`);
  }

  // Every file the exports point at must exist in the build output.
  const targets = [pkg.main, pkg.types];
  for (const entry of Object.values(pkg.exports ?? {})) {
    if (typeof entry === "string") targets.push(entry);
    else targets.push(...Object.values(entry));
  }
  for (const target of targets.filter(Boolean)) {
    const path = target.replace(/^\.\//, "");
    if (!existsSync(join(ROOT, where, path))) fail(`${target} does not exist (run npm run build)`);
    else if (!files.includes(path)) fail(`${target} would not be published`);
  }
}

if (problems.length) {
  console.error(`check-packages: ${problems.length} problem(s)`);
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}
console.log(`check-packages: ${PACKAGES.length} packages at ${version} would publish only their build output, README and LICENSE`);
