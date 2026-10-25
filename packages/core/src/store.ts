/**
 * Where the outbox keeps its items.
 *
 * The one hard requirement: `update` is ATOMIC with respect to every other
 * writer of the same outbox (other calls in this context, other tabs, a
 * service worker). Read, change, write, as one step. Platform packages provide
 * stores that keep this promise (IndexedDB transactions plus a cross-tab lock
 * on the web, a serialised queue on React Native).
 *
 * Items must survive app close, force-close and reload. A store that cannot
 * promise that (private browsing, blocked storage) must say so through
 * `isDurable`, so the app can warn the person before they close it.
 */
import type { OutboxItem } from "./types.js";

export interface Store<P = unknown> {
  /** A snapshot of all items. */
  read(): Promise<OutboxItem<P>[]>;
  /**
   * Runs `fn` on the current items and saves whatever it leaves in the array,
   * as one atomic step. Returns what `fn` returns. If `fn` throws, nothing is
   * saved.
   */
  update<T>(fn: (items: OutboxItem<P>[]) => T): Promise<T>;
  /** True if items survive the app being closed. */
  isDurable(): Promise<boolean>;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * An in-memory store. Atomic within one JS context. NOT durable: use it for
 * tests, or as the honest fallback when no durable storage exists.
 *
 * Items are deep-copied on the way in and out, so callers can never change
 * stored state by holding on to a returned object (the same behaviour as a
 * real serialising store).
 */
export class MemoryStore<P = unknown> implements Store<P> {
  private items: OutboxItem<P>[];
  private chain: Promise<unknown> = Promise.resolve();

  constructor(initial: OutboxItem<P>[] = []) {
    this.items = clone(initial);
  }

  read(): Promise<OutboxItem<P>[]> {
    return this.chain.then(() => clone(this.items));
  }

  update<T>(fn: (items: OutboxItem<P>[]) => T): Promise<T> {
    const run = this.chain.then(() => {
      const working = clone(this.items);
      const result = fn(working);
      this.items = clone(working);
      return result;
    });
    this.chain = run.catch(() => undefined);
    return run;
  }

  isDurable(): Promise<boolean> {
    return Promise.resolve(false);
  }
}
