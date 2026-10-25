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

interface SyncRegistrationLike {
  sync?: { register(tag: string): Promise<void> };
}

interface ServiceWorkerContainerLike {
  ready: Promise<SyncRegistrationLike>;
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
    const registration = await Promise.race([container.ready, timeout]);
    if (!registration?.sync || typeof registration.sync.register !== "function") return "open_app";
    await registration.sync.register(tag);
    return "background";
  } catch {
    return "open_app";
  }
}

interface SyncEventLike {
  tag: string;
  waitUntil(promise: Promise<unknown>): void;
}

/**
 * For the service worker: run `flush` when the browser fires our sync tag.
 * If `flush` rejects, the browser retries the sync later.
 *
 *   self.addEventListener("sync", (event) => onBackgroundSync(event, () => outbox.flush(userId)));
 */
export function onBackgroundSync(event: SyncEventLike, flush: () => Promise<unknown>, tag = "holdsend"): boolean {
  if (event.tag !== tag) return false;
  event.waitUntil(flush());
  return true;
}
