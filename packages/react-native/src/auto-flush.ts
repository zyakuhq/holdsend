/**
 * Flushes the outbox on React Native: when started, when `kick()` is called
 * (after `add`), when the network comes back, when the app returns to the
 * foreground, and on a backoff while items keep failing.
 *
 * HoldSend does not depend on NetInfo or AppState; pass in subscribe
 * functions so you choose the libraries:
 *
 *   startNativeAutoFlush(outbox, {
 *     owner: user.id,
 *     onConnectivityChange: (cb) => NetInfo.addEventListener((s) => cb(Boolean(s.isConnected))),
 *     onForeground: (cb) => AppState.addEventListener("change", (s) => s === "active" && cb()).remove,
 *   });
 *
 * About sending while the app is closed: iOS gives apps no reliable way to
 * run on reconnect. Android can, through a background task library. Tell
 * people the truth: on iOS, what is waiting is sent the next time the app is
 * open with a connection.
 */
import { createFlushScheduler, type FlushReport, type Outbox } from "@holdsend/core";

type Unsubscribe = () => void;

export interface NativeAutoFlushOptions {
  owner?: string;
  /** Subscribe to connectivity; call the listener with true when connected. Returns an unsubscribe. */
  onConnectivityChange?: (listener: (connected: boolean) => void) => Unsubscribe;
  /** Subscribe to the app coming to the foreground. Returns an unsubscribe. */
  onForeground?: (listener: () => void) => Unsubscribe;
  backoffMs?: number[];
  onReport?: (report: FlushReport | "skipped") => void;
  onError?: (err: unknown) => void;
}

export interface NativeAutoFlusher {
  kick(): void;
  stop(): void;
}

export function startNativeAutoFlush<P>(outbox: Outbox<P>, options: NativeAutoFlushOptions = {}): NativeAutoFlusher {
  let connected = true;
  const scheduler = createFlushScheduler({
    flush: () => outbox.flush(options.owner),
    isOnline: () => connected,
    ...(options.backoffMs ? { backoffMs: options.backoffMs } : {}),
    ...(options.onReport ? { onReport: options.onReport } : {}),
    ...(options.onError ? { onError: options.onError } : {}),
  });

  const unsubscribes: Unsubscribe[] = [];
  if (options.onConnectivityChange) {
    unsubscribes.push(
      options.onConnectivityChange((isConnected) => {
        const cameBack = isConnected && !connected;
        connected = isConnected;
        if (cameBack) scheduler.kick();
      }),
    );
  }
  if (options.onForeground) unsubscribes.push(options.onForeground(() => scheduler.kick()));
  scheduler.kick();

  return {
    kick: () => scheduler.kick(),
    stop() {
      scheduler.stop();
      for (const unsubscribe of unsubscribes) {
        try {
          unsubscribe();
        } catch {
          /* already removed */
        }
      }
    },
  };
}
