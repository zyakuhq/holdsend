/**
 * An outbox Store backed by IndexedDB.
 *
 * Each item is one row, keyed by its idempotency key. `update` reads every
 * row, runs the change, and writes the difference back, all inside ONE
 * readwrite transaction. IndexedDB runs readwrite transactions on the same
 * object store one at a time, across every tab and worker of the origin, so
 * the update is atomic everywhere without any extra lock.
 *
 * The change function must be synchronous (the Store contract already says
 * so): an IndexedDB transaction commits as soon as it has no pending
 * requests, so it cannot stay open across an `await`.
 */
import type { OutboxItem, Store } from "@holdsend/core";

export interface IndexedDbStoreOptions {
  /** Database name. Use one per outbox. Default "holdsend". */
  name?: string;
  /** The IndexedDB factory. Default globalThis.indexedDB. */
  indexedDB?: IDBFactory;
}

const ITEMS = "items";
const META = "meta";
/**
 * The database schema version. Policy: a later HoldSend version may only add
 * to this schema in an upgrade that older code can still read, and must never
 * bump it without that. A tab still running an older version gets a
 * versionchange event, closes its connection and reopens on next use.
 */
const VERSION = 1;

function promisify<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed"));
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
  });
}

export class IndexedDbStore<P = unknown> implements Store<P> {
  private readonly name: string;
  private readonly factory: IDBFactory;
  private dbPromise: Promise<IDBDatabase> | null = null;

  constructor(options: IndexedDbStoreOptions = {}) {
    this.name = options.name ?? "holdsend";
    const factory = options.indexedDB ?? (globalThis as { indexedDB?: IDBFactory }).indexedDB;
    if (!factory) throw new Error("IndexedDB is not available in this environment");
    this.factory = factory;
  }

  private open(): Promise<IDBDatabase> {
    if (!this.dbPromise) {
      // Handlers below forget the cached connection only if it is still this
      // one, so a late close event from an old connection cannot drop a newer one.
      const forget = () => {
        if (this.dbPromise === opening) this.dbPromise = null;
      };
      const opening: Promise<IDBDatabase> = new Promise<IDBDatabase>((resolve, reject) => {
        const request = this.factory.open(this.name, VERSION);
        request.onupgradeneeded = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains(ITEMS)) db.createObjectStore(ITEMS, { keyPath: "key" });
          if (!db.objectStoreNames.contains(META)) db.createObjectStore(META);
        };
        request.onsuccess = () => {
          const db = request.result;
          // Another tab upgrading the schema: step aside so it can, and reopen next time.
          db.onversionchange = () => {
            db.close();
            forget();
          };
          // The browser closed the connection (iOS Safari does this after the
          // app was in the background, or when storage is cleared): reopen
          // next time instead of failing every write from now on.
          db.onclose = forget;
          resolve(db);
        };
        request.onerror = () => reject(request.error ?? new Error("could not open IndexedDB"));
        request.onblocked = () => reject(new Error("IndexedDB open is blocked by another tab"));
      }).catch((err) => {
        forget();
        throw err;
      });
      this.dbPromise = opening;
    }
    return this.dbPromise;
  }

  /**
   * Starts a transaction, reopening the database once if the cached
   * connection turns out to be closed. Nothing has run yet at that point, so
   * retrying is safe.
   */
  private async begin(stores: string, mode: IDBTransactionMode): Promise<IDBTransaction> {
    const db = await this.open();
    try {
      return db.transaction(stores, mode);
    } catch (err) {
      const name = (err as { name?: unknown } | null)?.name;
      if (name !== "InvalidStateError" && name !== "UnknownError") throw err;
      if (this.dbPromise && (await this.dbPromise.catch(() => null)) === db) this.dbPromise = null;
      return (await this.open()).transaction(stores, mode);
    }
  }

  async read(): Promise<OutboxItem<P>[]> {
    const tx = await this.begin(ITEMS, "readonly");
    const items = await promisify(tx.objectStore(ITEMS).getAll() as IDBRequest<OutboxItem<P>[]>);
    return items;
  }

  async update<T>(fn: (items: OutboxItem<P>[]) => T): Promise<T> {
    const tx = await this.begin(ITEMS, "readwrite");
    const store = tx.objectStore(ITEMS);
    const finished = done(tx);
    // Attach a handler now so a failure is never an unhandled rejection; it is rethrown below.
    finished.catch(() => undefined);

    const result = await new Promise<{ value: T }>((resolve, reject) => {
      const getAll = store.getAll() as IDBRequest<OutboxItem<P>[]>;
      getAll.onerror = () => reject(getAll.error ?? new Error("IndexedDB read failed"));
      getAll.onsuccess = () => {
        try {
          const before = getAll.result;
          const beforeByKey = new Map(before.map((item) => [item.key, JSON.stringify(item)]));
          const working = before.map((item) => JSON.parse(JSON.stringify(item)) as OutboxItem<P>);
          const value = fn(working);
          if (value instanceof Promise) throw new TypeError("Store.update callbacks must be synchronous");

          const seen = new Set<string>();
          for (const item of working) {
            if (seen.has(item.key)) throw new Error(`duplicate key in outbox: ${item.key}`);
            seen.add(item.key);
            const serialised = JSON.stringify(item);
            if (beforeByKey.get(item.key) !== serialised) store.put(JSON.parse(serialised));
          }
          for (const key of beforeByKey.keys()) if (!seen.has(key)) store.delete(key);
          resolve({ value });
        } catch (err) {
          try {
            tx.abort();
          } catch {
            /* already finished */
          }
          reject(err);
        }
      };
    });
    await finished;
    return result.value;
  }

  /**
   * True when a write survives a read-back. This catches browsers or modes
   * where IndexedDB is missing or refuses writes. It cannot detect a private
   * window that keeps data only until the window closes; call
   * `requestPersistentStorage()` to ask the browser not to evict the outbox.
   */
  async isDurable(): Promise<boolean> {
    try {
      const token = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
      const write = await this.begin(META, "readwrite");
      write.objectStore(META).put(token, "probe");
      await done(write);
      const readTx = await this.begin(META, "readonly");
      const back = await promisify(readTx.objectStore(META).get("probe"));
      return back === token;
    } catch {
      return false;
    }
  }

  /** Closes the connection. The next call reopens it. */
  close(): void {
    void this.dbPromise?.then((db) => db.close()).catch(() => undefined);
    this.dbPromise = null;
  }
}

/**
 * Asks the browser to keep this origin's storage when space runs low.
 * Returns true if storage is (now) persistent. Never throws.
 */
export async function requestPersistentStorage(): Promise<boolean> {
  try {
    const storage = (globalThis as { navigator?: { storage?: StorageManager } }).navigator?.storage;
    if (!storage?.persist) return false;
    if (await storage.persisted?.()) return true;
    return await storage.persist();
  } catch {
    return false;
  }
}
