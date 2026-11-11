// Android only: try to send waiting notes while the app is in the background.
//
// This file must be imported from index.js, before the app is registered:
// Android can start the JavaScript bundle with no screen to run the task, and
// TaskManager.defineTask has to run in the bundle's global scope for that.
//
// Honest limits (see README.md): Android decides if and when this runs: we
// ask for every 15 minutes, it may wait longer, and only with a connection; it is skipped while
// the app is open (the auto-flush covers that); check it in a development
// build, not Expo Go; and it has not been checked on a real phone yet.
import * as BackgroundTask from "expo-background-task";
import * as TaskManager from "expo-task-manager";
import { Platform } from "react-native";
import { runBackgroundFlush } from "@holdsend/react-native";
import { SETUP_PROBLEM, demoUser, outbox } from "./outbox";

export const SEND_TASK = "holdsend-send-waiting-notes";

/** Minutes between runs we ask for. Android may wait longer. */
const EVERY_MINUTES = 15;

if (Platform.OS === "android") {
  TaskManager.defineTask(SEND_TASK, async () => {
    if (SETUP_PROBLEM) return BackgroundTask.BackgroundTaskResult.Success; // no server address: nothing to send to
    try {
      const result = await runBackgroundFlush(outbox, { owner: await demoUser(), budgetMs: 20_000 });
      // expo-background-task ignores this value (version 58): the next run is
      // scheduled the same way, so `retryLater` cannot bring it sooner.
      return result.outcome === "failed" ? BackgroundTask.BackgroundTaskResult.Failed : BackgroundTask.BackgroundTaskResult.Success;
    } catch {
      return BackgroundTask.BackgroundTaskResult.Failed; // demoUser() could not read the device's id
    }
  });
}

/**
 * Asks Android to run the task. Resolves to what happened, for the screen:
 * "registered", "already" or "unavailable" (not Android, or the system
 * does not allow it). Rejects if registering fails.
 */
export async function registerSendTask() {
  if (Platform.OS !== "android") return "unavailable";
  if ((await BackgroundTask.getStatusAsync()) !== BackgroundTask.BackgroundTaskStatus.Available) return "unavailable";
  if (await TaskManager.isTaskRegisteredAsync(SEND_TASK)) return "already";
  await BackgroundTask.registerTaskAsync(SEND_TASK, { minimumInterval: EVERY_MINUTES });
  return "registered";
}
