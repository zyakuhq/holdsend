/**
 * Decides WHEN to flush, for any platform.
 *
 * - `kick()` asks for a pass now (call it after `add`, on reconnect, when the
 *   app comes to the foreground). Calls during a pass fold into one more pass.
 * - After a pass that left items waiting (no answer, or the server was busy),
 *   or that could not run because another sender held the lock, the next pass
 *   is scheduled on a backoff: tried again soon, without hammering a
 *   struggling server.
 * - A pass that found items held by another sender schedules one more pass
 *   for when that sender's claim would go stale, so an app killed mid-send
 *   in another tab never leaves an item stuck as "sending".
 * - While offline, nothing is scheduled; the platform's reconnect signal
 *   calls `kick()`.
 *
 * Platform packages wire their own signals to it (browser events, NetInfo,
 * AppState) and supply the lock.
 */
import type { FlushReport } from "./outbox.js";

export interface SchedulerOptions {
  /**
   * Runs one flush. Return "skipped" if it could not run now (another sender
   * holds the lock); the scheduler then tries again on the backoff.
   */
  flush: () => Promise<FlushReport | "skipped">;
  /** Default always online. */
  isOnline?: () => boolean;
  /** Delays between passes while work remains. Default 2s, 5s, 15s, 30s, 60s (then 60s). */
  backoffMs?: number[];
  onReport?: (report: FlushReport | "skipped") => void;
  onError?: (err: unknown) => void;
}

export interface FlushScheduler {
  kick(): void;
  stop(): void;
}

interface TimerApi {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const timers = globalThis as unknown as TimerApi;
const DEFAULT_BACKOFF = [2_000, 5_000, 15_000, 30_000, 60_000];

export function createFlushScheduler(options: SchedulerOptions): FlushScheduler {
  const backoff = options.backoffMs && options.backoffMs.length > 0 ? options.backoffMs : DEFAULT_BACKOFF;
  const isOnline = options.isOnline ?? (() => true);
  let step = 0;
  let timer: unknown = null;
  let running = false;
  let again = false;
  let stopped = false;

  const later = () => {
    if (stopped) return;
    const delay = backoff[Math.min(step, backoff.length - 1)] ?? 60_000;
    step += 1;
    if (timer !== null) timers.clearTimeout(timer);
    timer = timers.setTimeout(() => {
      timer = null;
      void pass();
    }, delay);
  };

  const at = (ms: number) => {
    if (stopped) return;
    if (timer !== null) timers.clearTimeout(timer);
    timer = timers.setTimeout(() => {
      timer = null;
      void pass();
    }, Math.min(Math.max(ms, 250), 10 * 60_000));
  };

  const pass = async (): Promise<void> => {
    if (stopped) return;
    if (running) {
      again = true;
      return;
    }
    if (!isOnline()) return;
    running = true;
    try {
      const report = await options.flush();
      options.onReport?.(report);
      if (report === "skipped" || report.retry + report.busy > 0) later();
      else {
        step = 0;
        // Items held by another sender: look again when its claim would go
        // stale, in case that sender died. Nobody else would.
        if (report.nextCheckInMs !== undefined) at(report.nextCheckInMs);
      }
    } catch (err) {
      options.onError?.(err);
      later();
    } finally {
      running = false;
      if (again && !stopped) {
        again = false;
        void pass();
      }
    }
  };

  return {
    kick() {
      if (stopped) return;
      step = 0;
      if (timer !== null) {
        timers.clearTimeout(timer);
        timer = null;
      }
      void pass();
    },
    stop() {
      stopped = true;
      if (timer !== null) timers.clearTimeout(timer);
      timer = null;
    },
  };
}
