/**
 * Flushes the outbox when it makes sense in a browser tab:
 *
 *   - when started, and whenever `kick()` is called (call it after `add`);
 *   - when the browser says the connection came back (`online`);
 *   - when the tab becomes visible again;
 *   - after a pass that left items waiting, on a backoff schedule, so an item
 *     that failed on a flaky connection is tried again without waiting for
 *     the next reconnect, and without hammering a struggling server.
 *
 * Only one tab sends at a time (SenderLock). A tab that does not get the
 * lock tries again on the backoff schedule, in case the sending tab closes.
 */
import type { FlushReport, Outbox } from "@holdsend/core";
import { SenderLock } from "./sender-lock.js";

export interface AutoFlushOptions {
  /** Only this owner's items are sent (for example the signed-in user id). */
  owner?: string;
  lock?: SenderLock;
  /** Delays between passes while items are still waiting. Default 2s, 5s, 15s, 30s, 60s (then 60s). */
  backoffMs?: number[];
  /** Event source for online/visibility. Default globalThis (window). */
  target?: EventTarget & { document?: { visibilityState?: string } };
  /** Default navigator.onLine (assumed online when unknown). */
  isOnline?: () => boolean;
  /** Called after every pass, for logging or UI. */
  onReport?: (report: FlushReport | "skipped") => void;
  onError?: (err: unknown) => void;
}

export interface AutoFlusher {
  /** Ask for a pass soon (coalesced). */
  kick(): void;
  /** Stops listening and cancels any scheduled pass. */
  stop(): void;
}

const DEFAULT_BACKOFF = [2_000, 5_000, 15_000, 30_000, 60_000];

function defaultIsOnline(): boolean {
  const nav = (globalThis as { navigator?: { onLine?: boolean } }).navigator;
  return nav?.onLine !== false;
}

export function startAutoFlush<P>(outbox: Outbox<P>, options: AutoFlushOptions = {}): AutoFlusher {
  const lock = options.lock ?? new SenderLock();
  const backoff = options.backoffMs?.length ? options.backoffMs : DEFAULT_BACKOFF;
  const target: EventTarget & { document?: { visibilityState?: string } } =
    options.target ?? (globalThis as unknown as EventTarget & { document?: { visibilityState?: string } });
  const isOnline = options.isOnline ?? defaultIsOnline;
  let step = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false;
  let again = false;
  let stopped = false;

  const schedule = (ms: number) => {
    if (stopped) return;
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void pass();
    }, ms);
  };

  const pass = async (): Promise<void> => {
    if (stopped) return;
    if (running) {
      again = true;
      return;
    }
    if (!isOnline()) return; // the `online` event will start the next pass
    running = true;
    try {
      const result = await lock.run(() => outbox.flush(options.owner));
      if (!result.acquired) {
        options.onReport?.("skipped");
        schedule(backoff[Math.min(step, backoff.length - 1)]!);
        step += 1;
        return;
      }
      options.onReport?.(result.value);
      const stillWaiting = result.value.retry + result.value.busy > 0;
      if (stillWaiting) {
        schedule(backoff[Math.min(step, backoff.length - 1)]!);
        step += 1;
      } else {
        step = 0;
      }
    } catch (err) {
      options.onError?.(err);
      schedule(backoff[Math.min(step, backoff.length - 1)]!);
      step += 1;
    } finally {
      running = false;
      if (again && !stopped) {
        again = false;
        void pass();
      }
    }
  };

  const onOnline = () => {
    step = 0;
    void pass();
  };
  const onVisible = () => {
    if (target.document?.visibilityState === "visible") void pass();
  };

  target.addEventListener("online", onOnline);
  target.addEventListener("visibilitychange", onVisible);
  void pass();

  return {
    kick() {
      step = 0;
      void pass();
    },
    stop() {
      stopped = true;
      if (timer !== null) clearTimeout(timer);
      target.removeEventListener("online", onOnline);
      target.removeEventListener("visibilitychange", onVisible);
    },
  };
}
