import { MemoryStore, type Store } from "@holdsend/core";
import { IndexedDbStore, type IndexedDbStoreOptions } from "./indexeddb-store.js";

export { IndexedDbStore, requestPersistentStorage, type IndexedDbStoreOptions } from "./indexeddb-store.js";
export { SenderLock, type LockManagerLike, type SenderLockOptions, type SenderLockResult, type SyncStorageLike } from "./sender-lock.js";
export { startAutoFlush, type AutoFlusher, type AutoFlushOptions } from "./auto-flush.js";
export { onBackgroundSync, requestBackgroundSync, type BackgroundSupport, type BackgroundSyncOptions } from "./background-sync.js";

/**
 * The best store this browser offers: IndexedDB when it works, otherwise an
 * in-memory store. Check `store.isDurable()` and warn the person when it is
 * false: what they write then lasts only as long as the tab.
 */
export async function createWebStore<P = unknown>(options: IndexedDbStoreOptions = {}): Promise<Store<P>> {
  try {
    const store = new IndexedDbStore<P>(options);
    if (await store.isDurable()) return store;
    store.close();
  } catch {
    /* fall through */
  }
  return new MemoryStore<P>();
}
