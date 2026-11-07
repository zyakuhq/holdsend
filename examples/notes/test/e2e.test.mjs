// End-to-end: the plain notes page, the emergency page and the drafts page in a real browser.
//
//   npm run e2e            (from the repository root, after npm run build)
import { runDraftScenarios } from "./drafts.mjs";
import { runEmergencyScenarios } from "./emergency.mjs";
import { runNotesScenarios } from "./scenarios.mjs";

runNotesScenarios();
runEmergencyScenarios();
runDraftScenarios();
