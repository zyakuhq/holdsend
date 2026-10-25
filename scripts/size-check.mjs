// Fails if a package grows past its budget: the entry point bundled and
// minified the way an app would ship it, then gzipped. Budgets are tight on
// purpose: the core must stay small enough to drop into any app without a
// second thought.
import { build } from "esbuild";
import { gzipSync } from "node:zlib";

const BUDGETS = [
  { name: "@holdsend/core", entry: "packages/core/dist/index.js", gzipBytes: 4 * 1024 },
  // Measured with the parts of core it imports bundled in.
  { name: "@holdsend/web", entry: "packages/web/dist/index.js", gzipBytes: 7 * 1024 },
  { name: "@holdsend/react-native", entry: "packages/react-native/dist/index.js", gzipBytes: 4 * 1024 },
];

let failed = false;
for (const { name, entry, gzipBytes } of BUDGETS) {
  let result;
  try {
    result = await build({ entryPoints: [entry], bundle: true, minify: true, format: "esm", write: false, logLevel: "silent" });
  } catch {
    console.error(`size: ${entry} could not be bundled. Run "npm run build" first.`);
    process.exit(1);
  }
  const size = gzipSync(result.outputFiles[0].contents).length;
  const ok = size <= gzipBytes;
  if (!ok) failed = true;
  console.log(`size: ${name} ${size} B min+gzip (budget ${gzipBytes} B) ${ok ? "ok" : "OVER BUDGET"}`);
}
process.exit(failed ? 1 : 0);
