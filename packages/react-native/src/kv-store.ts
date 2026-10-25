/**
 * An outbox Store over a key-value backend, for React Native.
 *
 * The whole queue is one JSON value under one key, so every save replaces it
 * in a single write. Updates are serialised in this JS context: read, change,
 * write, one at a time. React Native runs app code (including headless
 * background tasks) in one JS context, so this is atomic for the app.
 *
 * Safety rules:
 *   - A read that fails, or returns data that is not a valid queue, makes the
 *     update fail. It never "starts fresh" and overwrites what is stored:
 *     that would silently delete everything the person wrote.
 *   - If the change function throws, nothing is written.
 */
import type { OutboxItem, Store } from "@holdsend/core";

/** The subset of @react-native-async-storage/async-storage this store uses. */
export interface AsyncKeyValue {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

/** The subset of react-native-mmkv's MMKV instance this store uses. */
export interface MmkvLike {
  getString(key: string): string | undefined;
  set(key: string, value: string): void;
  delete(key: string): void;
}

/** Thrown when the stored queue cannot be read as a queue. The stored value is left untouched. */
export class CorruptOutboxError extends Error {
  constructor(readonly raw: string) {
    super("the stored outbox is not valid JSON or not a list; it was left untouched");
    this.name = "CorruptOutboxError";
  }
}

export interface KeyValueStoreOptions {
  /** Storage key. Use one per outbox. Default "holdsend:outbox". */
  key?: string;
}

const mmkvAdapters = new WeakMap<MmkvLike, AsyncKeyValue>();

/** Adapts an MMKV instance to the async interface. Returns the same adapter for the same instance. */
export function fromMmkv(mmkv: MmkvLike): AsyncKeyValue {
  let adapter = mmkvAdapters.get(mmkv);
  if (!adapter) {
    adapter = {
      getItem: async (key) => mmkv.getString(key) ?? null,
      setItem: async (key, value) => mmkv.set(key, value),
      removeItem: async (key) => mmkv.delete(key),
    };
    mmkvAdapters.set(mmkv, adapter);
  }
  return adapter;
}

function parse<P>(raw: string | null): OutboxItem<P>[] {
  if (raw === null) return [];
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new CorruptOutboxError(raw);
  }
  if (!Array.isArray(value)) throw new CorruptOutboxError(raw);
  return value as OutboxItem<P>[];
}

/**
 * One update chain per (backend, key), shared by every KeyValueStore on that
 * pair, so two store instances created by mistake still take turns.
 */
const chains = new WeakMap<object, Map<string, Promise<unknown>>>();

function chainFor(backend: object, key: string): Promise<unknown> {
  return chains.get(backend)?.get(key) ?? Promise.resolve();
}

function setChain(backend: object, key: string, chain: Promise<unknown>): void {
  let byKey = chains.get(backend);
  if (!byKey) {
    byKey = new Map();
    chains.set(backend, byKey);
  }
  byKey.set(key, chain);
}

export class KeyValueStore<P = unknown> implements Store<P> {
  private readonly backend: AsyncKeyValue;
  private readonly key: string;

  constructor(backend: AsyncKeyValue, options: KeyValueStoreOptions = {}) {
    this.backend = backend;
    this.key = options.key ?? "holdsend:outbox";
  }

  read(): Promise<OutboxItem<P>[]> {
    // Waits for pending updates so a read never sees a half-applied state.
    return chainFor(this.backend, this.key).then(async () => parse<P>(await this.backend.getItem(this.key)));
  }

  update<T>(fn: (items: OutboxItem<P>[]) => T): Promise<T> {
    const run = chainFor(this.backend, this.key).then(async () => {
      const items = parse<P>(await this.backend.getItem(this.key));
      const value = fn(items);
      if (value instanceof Promise) throw new TypeError("Store.update callbacks must be synchronous");
      const keys = new Set<string>();
      for (const item of items) {
        if (keys.has(item.key)) throw new Error(`duplicate key in outbox: ${item.key}`);
        keys.add(item.key);
      }
      await this.backend.setItem(this.key, JSON.stringify(items));
      return value;
    });
    setChain(this.backend, this.key, run.catch(() => undefined));
    return run;
  }

  /** True when a write to the backend reads back. */
  async isDurable(): Promise<boolean> {
    const probe = `${this.key}:probe`;
    const token = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    try {
      await this.backend.setItem(probe, token);
      const back = await this.backend.getItem(probe);
      await this.backend.removeItem(probe).catch(() => undefined);
      return back === token;
    } catch {
      return false;
    }
  }
}
