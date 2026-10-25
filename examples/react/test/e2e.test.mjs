// End-to-end: the React notes page in a real browser, through the same
// scenarios as the plain page.
//
//   npm run e2e            (from the repository root, after npm run build)
import { fileURLToPath } from "node:url";
import { runNotesScenarios } from "../../notes/test/scenarios.mjs";

const here = (path) => fileURLToPath(new URL(path, import.meta.url));

// A development build, so StrictMode runs every effect twice and the hooks
// must survive it.
runNotesScenarios({ development: true, page: { entry: here("../src/main.jsx"), html: here("../public/index.html") } });
