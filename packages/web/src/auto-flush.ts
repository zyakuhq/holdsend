/**
 * Flushes the outbox when it makes sense in a browser tab: when started,
 * when `kick()` is called (call it after `add`), when the connection comes
 * back (`online`), when the tab becomes visible, and on a backoff while items
 * keep failing or another tab holds the sender lock.
 */
import { createFlushScheduler, type FlushReport, type Outbox } from "@holdsend/core";
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

function defaultIsOnline(): boolean {
  const nav = (globalThis as { navigator?: { onLine?: boolean } }).navigator;
  return nav?.onLine !== false;
}

export function startAutoFlush<P>(outbox: Outbox<P>, options: AutoFlushOptions = {}): AutoFlusher {
  const lock = options.lock ?? new SenderLock();
  const target: EventTarget & { document?: { visibilityState?: string } } =
    options.target ?? (globalThis as unknown as EventTarget & { document?: { visibilityState?: string } });

  const scheduler = createFlushScheduler({
    flush: async () => {
      const result = await lock.run(() => outbox.flush(options.owner));
      return result.acquired ? result.value : "skipped";
    },
    isOnline: options.isOnline ?? defaultIsOnline,
    ...(options.backoffMs ? { backoffMs: options.backoffMs } : {}),
    ...(options.onReport ? { onReport: options.onReport } : {}),
    ...(options.onError ? { onError: options.onError } : {}),
  });

  const onOnline = () => scheduler.kick();
  const onVisible = () => {
    if (target.document?.visibilityState === "visible") scheduler.kick();
  };
  target.addEventListener("online", onOnline);
  target.addEventListener("visibilitychange", onVisible);
  scheduler.kick();

  return {
    kick: () => scheduler.kick(),
    stop() {
      scheduler.stop();
      target.removeEventListener("online", onOnline);
      target.removeEventListener("visibilitychange", onVisible);
    },
  };
}
