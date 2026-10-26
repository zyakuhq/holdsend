/**
 * Sending after the tab closes, where the platform allows it.
 *
 * Only Chromium browsers (Chrome, Edge, Samsung Internet, Android Chrome)
 * implement the Background Sync API. Safari on iOS, iPadOS and macOS, and
 * Firefox, do not: there the outbox sends when the app is open with a
 * connection. Apps must tell people which case they are in, at the moment
 * they press Send, and never promise background delivery from feature
 * detection alone. `requestBackgroundSync` therefore reports "background"
 * only after a registration actually succeeded.
 */

export type BackgroundSupport =
  /** A sync is registered: the browser will wake the service worker when the connection returns. */
  | "background"
  /** Sends only while the app is open with a connection. Say so, and offer an alternative (SMS) for urgent messages. */
  | "open_app";

/**
 * The part of navigator.serviceWorker this uses. Typed loosely so the real
 * ServiceWorkerContainer fits; whether its registration supports Background
 * Sync is checked at run time.
 */
export interface ServiceWorkerContainerLike {
  ready: Promise<unknown>;
}

interface SyncRegistrationLike {
  sync?: { register(tag: string): Promise<void> };
}

export interface BackgroundSyncOptions {
  tag?: string;
  /** Give up waiting for the service worker after this long. Default 3 s. */
  timeoutMs?: number;
  serviceWorker?: ServiceWorkerContainerLike | null;
}

/** Registers a background sync. Never throws; tells the truth about what it got. */
export async function requestBackgroundSync(options: BackgroundSyncOptions = {}): Promise<BackgroundSupport> {
  const tag = options.tag ?? "holdsend";
  const container =
    options.serviceWorker === undefined
      ? (globalThis as { navigator?: { serviceWorker?: ServiceWorkerContainerLike } }).navigator?.serviceWorker ?? null
      : options.serviceWorker;
  if (!container) return "open_app";
  try {
    const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), options.timeoutMs ?? 3000));
    const registration = (await Promise.race([container.ready, timeout])) as SyncRegistrationLike | null;
    if (!registration?.sync || typeof registration.sync.register !== "function") return "open_app";
    await registration.sync.register(tag);
    return "background";
  } catch {
    return "open_app";
  }
}

/** The part of a service worker's SyncEvent this uses. A plain `Event` from addEventListener is accepted too and checked at run time. */
export interface SyncEventLike {
  tag: string;
  waitUntil(promise: Promise<unknown>): void;
}

export interface OnBackgroundSyncOptions {
  /** The sync tag to handle. Default "holdsend". */
  tag?: string;
}

/**
 * True when a flush result says something is still waiting to be sent. It
 * may be a FlushReport, or a SenderLock run around one: a run that did not
 * get the lock (`ran: false`) sent nothing, so work may remain.
 */
function workRemains(result: unknown): boolean {
  if (!result || typeof result !== "object") return false;
  const run = result as { ran?: unknown; value?: unknown };
  if (run.ran === false) return true;
  const report = run.ran === true ? run.value : result;
  if (!report || typeof report !== "object") return false;
  const r = report as { retry?: unknown; busy?: unknown; nextCheckInMs?: unknown };
  return (typeof r.retry === "number" && r.retry > 0) || (typeof r.busy === "number" && r.busy > 0) || typeof r.nextCheckInMs === "number";
}

/**
 * For the service worker: run `flush` when the browser fires our sync tag.
 *
 * The browser treats the sync as done when the promise resolves, and tries
 * again later only when it rejects. A flush that left items waiting (no
 * answer, server busy, held by another sender) therefore rejects here, so
 * the browser wakes the worker again instead of giving up.
 *
 * The browser retries only a few times (Chrome: about three, with growing
 * gaps) and then drops the sync; `event.lastChance` is true on the final
 * try. After that nothing wakes the worker until the page registers again,
 * so call `requestBackgroundSync()` each time the app opens or regains a
 * connection while items are waiting.
 *
 *   // The worker has no session of its own: keep the signed-in owner in
 *   // IndexedDB when the person signs in, and read it here.
 *   self.addEventListener("sync", (event) =>
 *     onBackgroundSync(event, async () => outbox.flush(await readSignedInOwner())));
 *
 * `flush` may also return a SenderLock run (`lock.run(() => outbox.flush(owner))`);
 * a run that did not get the lock counts as work remaining.
 */
export function onBackgroundSync(event: SyncEventLike | Event, flush: () => Promise<unknown>, options: OnBackgroundSyncOptions = {}): boolean {
  const sync = event as Partial<SyncEventLike>;
  if (typeof sync.waitUntil !== "function" || sync.tag !== (options.tag ?? "holdsend")) return false;
  sync.waitUntil(
    flush().then((report) => {
      if (workRemains(report)) throw new Error("items are still waiting to be sent; asking the browser to try again");
      return report;
    }),
  );
  return true;
}
