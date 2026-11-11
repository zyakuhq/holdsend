/**
 * One bounded flush for a background task (Android WorkManager through
 * expo-background-task, react-native-background-fetch, or similar).
 *
 * HoldSend does not depend on a background library. Your task callback calls
 * this and maps the answer to what the library expects:
 *
 *   TaskManager.defineTask(TASK, async () => {
 *     const result = await runBackgroundFlush(outbox, { owner: await loadOwner() });
 *     return result.outcome === "failed" ? BackgroundTask.BackgroundTaskResult.Failed : BackgroundTask.BackgroundTaskResult.Success;
 *   });
 *
 * `retryLater` only helps with a library that can run the task again sooner;
 * expo-background-task schedules the next run the same way whatever it gets.
 *
 * Honest limits: the operating system decides if and when the task runs
 * (often 15 minutes or more apart, less on low battery), and it may stop the
 * task early. iOS gives no promise at all. A stopped task loses nothing: an
 * item being sent is claimed, and a claim that nobody finishes goes stale and
 * the next flush takes it over, sending with the same key.
 */
import type { FlushReport, Outbox } from "@holdsend/core";

interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}
const timers = globalThis as unknown as Timers;

export interface BackgroundFlushOptions {
  owner?: string;
  /** Stop waiting after this many ms (default 20000). The system may then stop or pause the attempt in flight; its claim goes stale and a later flush takes it over. */
  budgetMs?: number;
}

export interface BackgroundFlushResult {
  /** What happened: everything sent or nothing to do, some items wait, time ran out, or the flush threw. If the outbox's `isOnline` says offline, the flush does nothing and this is "done". */
  outcome: "done" | "waiting" | "out-of-time" | "failed";
  /** True when asking the system to run the task again soon makes sense. */
  retryLater: boolean;
  report?: FlushReport;
  error?: unknown;
}

export async function runBackgroundFlush<P>(
  outbox: Outbox<P>,
  options: BackgroundFlushOptions = {},
): Promise<BackgroundFlushResult> {
  const budgetMs = options.budgetMs ?? 20_000;
  let timer: unknown;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = timers.setTimeout(() => resolve("timeout"), Math.max(0, budgetMs));
  });
  const flush = outbox.flush(options.owner);
  // If the timeout wins, a later failure of the flush must not become an unhandled rejection.
  flush.catch(() => undefined);
  try {
    const won = await Promise.race([flush, timeout]);
    if (won === "timeout") return { outcome: "out-of-time", retryLater: true };
    const waiting = won.retry > 0 || won.busy > 0 || won.nextCheckInMs !== undefined;
    return { outcome: waiting ? "waiting" : "done", retryLater: waiting, report: won };
  } catch (error) {
    return { outcome: "failed", retryLater: true, error };
  } finally {
    timers.clearTimeout(timer);
  }
}
