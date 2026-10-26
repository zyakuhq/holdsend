import { MemoryStore, type Store } from "@holdsend/core";
import { IndexedDbStore, type IndexedDbStoreOptions } from "./indexeddb-store.js";

export { IndexedDbStore, requestPersistentStorage, type IndexedDbStoreOptions } from "./indexeddb-store.js";
export { SenderLock, type LeaseStorage, type LockedRun, type SenderLockOptions, type WebLockApi } from "./sender-lock.js";
export { startAutoFlush, type AutoFlusher, type AutoFlushOptions } from "./auto-flush.js";
export {
  onBackgroundSync,
  requestBackgroundSync,
  type BackgroundSupport,
  type BackgroundSyncOptions,
  type OnBackgroundSyncOptions,
  type ServiceWorkerContainerLike,
  type SyncEventLike,
} from "./background-sync.js";

export interface CreateWebStoreOptions extends IndexedDbStoreOptions {
  /**
   * Called when IndexedDB could not be used and the store falls back to
   * memory, with the reason. Log it: a fallback hides anything already
   * waiting on disk for this session, so it should be rare and visible.
   */
  onFallback?: (reason: unknown) => void;
}

/**
 * The best store this browser offers: IndexedDB when it works, otherwise an
 * in-memory store (after one retry, since Safari sometimes fails to open
 * IndexedDB once and then succeeds). Check `store.isDurable()` and warn the
 * person when it is false: what they write then lasts only as long as the
 * tab.
 *
 * What `isDurable()` can and cannot tell you: it is false when storage is
 * blocked or unusable. A private window usually still reports true, because
 * its IndexedDB works until the window closes; browsers do not let a page
 * tell a private window apart. Safari may also clear a site's storage after
 * about a week without a visit. Say so where it matters to the person.
 */
export async function createWebStore<P = unknown>(options: CreateWebStoreOptions = {}): Promise<Store<P>> {
  const { onFallback, ...storeOptions } = options;
  let reason: unknown = new Error("IndexedDB did not read back what was written");
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const store = new IndexedDbStore<P>(storeOptions);
      await store.read(); // surfaces the real error if the database cannot be opened
      if (await store.isDurable()) return store;
      store.close();
    } catch (err) {
      reason = err;
    }
  }
  onFallback?.(reason);
  return new MemoryStore<P>();
}
