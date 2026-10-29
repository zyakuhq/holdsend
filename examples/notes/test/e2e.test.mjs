// End-to-end: the plain notes page and the emergency page in a real browser.
//
//   npm run e2e            (from the repository root, after npm run build)
import { runEmergencyScenarios } from "./emergency.mjs";
import { runNotesScenarios } from "./scenarios.mjs";

runNotesScenarios();
runEmergencyScenarios();
