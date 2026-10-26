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
/**
 * The stored outbox could not be read. Nothing was changed: every update
 * fails until the app decides what to do. `raw` holds the stored text, which
 * is the person's own writing, so it is not enumerable: error reporters that
 * copy an error's properties will not send it anywhere.
 *
 * To recover: show the person that waiting items could not be read, save
 * `raw` somewhere they can get it back from if you can, then remove the
 * storage key (the store's `key` option) so a new, empty outbox starts.
 */
export class CorruptOutboxError extends Error {
  declare readonly raw: string;
  constructor(raw: string) {
    super("the stored outbox is not valid JSON or not a list; it was left untouched");
    this.name = "CorruptOutboxError";
    Object.defineProperty(this, "raw", { value: raw, enumerable: false });
  }
}

export interface KeyValueStoreOptions {
  /** Storage key. Use one per outbox. Default "holdsend:outbox". */
  key?: string;
  /**
   * Largest queue, in UTF-8 bytes, this store will write. Default 1.5 MB.
   * Android's AsyncStorage cannot read back a value much over 2 MB, and a
   * queue it cannot read would lock the person out of everything waiting in
   * it. A write that would pass the limit fails instead, so the app can say
   * so. Keep photos and files out of payloads (store a reference). With
   * MMKV, which has no such limit, raise it or pass Infinity.
   */
  maxBytes?: number;
}

/** Thrown instead of writing a queue too large to be read back safely. Nothing is written. */
/** How much an update that adds nothing may grow the queue when it is over the limit: room for the fields that settling an attempt records. */
const SETTLE_SLACK_BYTES = 4096;

export class OutboxTooLargeError extends Error {
  constructor(readonly bytes: number, readonly maxBytes: number) {
    super(`the outbox would be ${bytes} bytes, over the ${maxBytes}-byte limit; nothing was written`);
    this.name = "OutboxTooLargeError";
  }
}

function utf8Bytes(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      bytes += 4; // a surrogate pair is one 4-byte character
      i += 1;
    } else bytes += 3;
  }
  return bytes;
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
  private readonly maxBytes: number;

  constructor(backend: AsyncKeyValue, options: KeyValueStoreOptions = {}) {
    this.backend = backend;
    this.key = options.key ?? "holdsend:outbox";
    this.maxBytes = options.maxBytes ?? 1_500_000;
  }

  read(): Promise<OutboxItem<P>[]> {
    // Waits for pending updates so a read never sees a half-applied state.
    return chainFor(this.backend, this.key).then(async () => parse<P>(await this.backend.getItem(this.key)));
  }

  update<T>(fn: (items: OutboxItem<P>[]) => T): Promise<T> {
    const run = chainFor(this.backend, this.key).then(async () => {
      const stored = await this.backend.getItem(this.key);
      const items = parse<P>(stored);
      const countBefore = items.length;
      const bytesBefore = stored === null ? 0 : utf8Bytes(stored);
      const value = fn(items);
      if (value instanceof Promise) throw new TypeError("Store.update callbacks must be synchronous");
      const keys = new Set<string>();
      for (const item of items) {
        if (keys.has(item.key)) throw new Error(`duplicate key in outbox: ${item.key}`);
        keys.add(item.key);
      }
      const text = JSON.stringify(items);
      const bytes = utf8Bytes(text);
      // Over the limit, refuse updates that add items or grow the queue by
      // more than bookkeeping does. Updates that send, settle or remove items
      // still go through (settling adds a few fields), or a full outbox could
      // never drain.
      const grows = items.length > countBefore || bytes > bytesBefore + SETTLE_SLACK_BYTES;
      if (bytes > this.maxBytes && grows) throw new OutboxTooLargeError(bytes, this.maxBytes);
      await this.backend.setItem(this.key, text);
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
