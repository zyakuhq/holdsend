/**
 * The outbox runtime: the rules in transitions.ts, applied to a Store, with a
 * flush loop that sends what is sendable.
 *
 * Platform packages wire it to real storage, a cross-device lock and network
 * events. On its own it runs anywhere JavaScript runs.
 */
import { newKey as defaultNewKey, isValidKey } from "./key.js";
import { classifyThrown, requestHeaders, type RequestHeaderOptions } from "./protocol.js";
import type { Store } from "./store.js";
import {
  approve as approveItem,
  cancel as cancelItem,
  claim,
  discard as discardItem,
  isSendable,
  pruneSent,
  renewClaim,
  retry as retryItem,
  settle,
  statusOf,
  type CancelResult,
  type DiscardResult,
} from "./transitions.js";
import { DEFAULT_POLICY, type AttemptOutcome, type ItemStatus, type OutboxItem, type Policy } from "./types.js";

export interface SendContext {
  /** Idempotency-Key (and Written-At unless omitted). Send them on the request. */
  headers: Record<string, string>;
  /** 1 for the first automatic attempt since the item was added or reset. */
  attempt: number;
}

/**
 * Sends one item. Return the outcome (use `classifyResponse` for HTTP).
 * Throwing is treated as "no answer": the item is retried later, same key.
 */
export type Sender<P> = (item: OutboxItem<P>, context: SendContext) => Promise<AttemptOutcome>;

export interface OutboxOptions<P> {
  store: Store<P>;
  send: Sender<P>;
  policy?: Partial<Policy>;
  /** Defaults to Date.now. */
  now?: () => number;
  /** Defaults to a random UUID. */
  newKey?: () => string;
  /** Checked before each send. Defaults to always true. */
  isOnline?: () => boolean;
  /** Per item header choices, for example leaving out the written time. */
  headerOptions?: (item: OutboxItem<P>) => RequestHeaderOptions;
}

export interface AddOptions {
  /** Who wrote it. A flush for one owner never sends another owner's items. */
  owner?: string;
  /**
   * Reuse a key an earlier live attempt already sent, so a request that may
   * have reached the server is queued under the same key and cannot create a
   * second copy.
   */
  key?: string;
  /** When the person wrote it. Defaults to now. */
  writtenAt?: number;
}

export interface OutboxEntry<P> {
  item: OutboxItem<P>;
  status: ItemStatus;
}

export interface FlushReport {
  sent: number;
  /** Attempts with no definite answer; the items wait for the next flush. */
  retry: number;
  /** The server was still finishing an earlier attempt. */
  busy: number;
  /** Items that became stuck in this flush. */
  stuck: number;
}

interface TimerApi {
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

const timers = globalThis as unknown as Partial<TimerApi>;

function emptyReport(): FlushReport {
  return { sent: 0, retry: 0, busy: 0, stuck: 0 };
}

export class Outbox<P = unknown> {
  readonly policy: Policy;
  private readonly store: Store<P>;
  private readonly send: Sender<P>;
  private readonly now: () => number;
  private readonly makeKey: () => string;
  private readonly isOnline: () => boolean;
  private readonly headerOptions: ((item: OutboxItem<P>) => RequestHeaderOptions) | undefined;
  private readonly listeners = new Set<() => void>();
  private running: Promise<FlushReport> | null = null;
  private rerun: { owner: string | undefined } | null = null;

  constructor(options: OutboxOptions<P>) {
    this.store = options.store;
    this.send = options.send;
    this.policy = { ...DEFAULT_POLICY, ...options.policy };
    this.now = options.now ?? Date.now;
    this.makeKey = options.newKey ?? defaultNewKey;
    this.isOnline = options.isOnline ?? (() => true);
    this.headerOptions = options.headerOptions;
    if (this.policy.claimRenewMs > 0 && this.policy.claimRenewMs >= this.policy.staleClaimMs) {
      throw new RangeError("policy.claimRenewMs must be smaller than policy.staleClaimMs");
    }
  }

  /** Keeps something the person wrote. Resolves once it is stored. */
  async add(kind: string, payload: P, options: AddOptions = {}): Promise<OutboxItem<P>> {
    if (options.key !== undefined && !isValidKey(options.key)) {
      throw new TypeError("key must be 8 to 128 characters of letters, digits, '_', '-', ':' or '.'");
    }
    const writtenAt = options.writtenAt ?? this.now();
    if (!Number.isFinite(writtenAt) || writtenAt <= 0) throw new TypeError("writtenAt must be a positive epoch time in ms");
    const item: OutboxItem<P> = {
      key: options.key ?? this.makeKey(),
      kind,
      payload,
      writtenAt,
      state: "waiting",
      attempts: 0,
      touched: false,
    };
    if (options.owner !== undefined) item.owner = options.owner;
    await this.store.update((items) => {
      if (items.some((i) => i.key === item.key)) throw new Error(`an item with key ${item.key} is already in the outbox`);
      items.push(item);
    });
    this.emit();
    return { ...item };
  }

  /** Every item not yet delivered, oldest written first, with what to show for it. */
  async list(): Promise<OutboxEntry<P>[]> {
    const now = this.now();
    const items = await this.store.read();
    return items
      .filter((i) => i.state !== "sent")
      .sort((a, b) => a.writtenAt - b.writtenAt)
      .map((item) => ({ item, status: statusOf(item, now, this.policy) }));
  }

  cancel(key: string): Promise<CancelResult> {
    return this.change((items) => cancelItem(items, key));
  }

  approve(key: string): Promise<boolean> {
    return this.change((items) => approveItem(items, key, this.now(), this.policy));
  }

  /** Returns the item's key after the reset (new only after a key conflict), or null. */
  retry(key: string): Promise<string | null> {
    return this.change((items) => retryItem(items, key, this.now(), this.makeKey, this.policy));
  }

  discard(key: string): Promise<DiscardResult> {
    return this.change((items) => discardItem(items, key, this.now(), this.policy));
  }

  isDurable(): Promise<boolean> {
    return this.store.isDurable();
  }

  /** Called after any change this outbox makes. Returns an unsubscribe function. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Sends everything sendable (for `owner`, if given). Only one flush runs at
   * a time per Outbox; a flush requested while one runs is folded into one
   * more pass after it, so nothing asked for in the meantime is missed.
   */
  flush(owner?: string): Promise<FlushReport> {
    if (this.running) {
      this.rerun = { owner };
      return this.running;
    }
    const run = (async () => {
      const total = emptyReport();
      let nextOwner: string | undefined = owner;
      for (;;) {
        const report = await this.pass(nextOwner);
        total.sent += report.sent;
        total.retry += report.retry;
        total.busy += report.busy;
        total.stuck += report.stuck;
        if (!this.rerun) break;
        nextOwner = this.rerun.owner;
        this.rerun = null;
      }
      return total;
    })();
    this.running = run;
    const clear = () => {
      if (this.running === run) this.running = null;
    };
    run.then(clear, clear);
    return run;
  }

  private async pass(owner: string | undefined): Promise<FlushReport> {
    const report = emptyReport();
    const snapshot = await this.store.read();
    const candidates = snapshot
      .filter((i) => isSendable(i, this.now(), this.policy, owner))
      .sort((a, b) => a.writtenAt - b.writtenAt)
      .map((i) => i.key);

    for (const key of candidates) {
      if (!this.isOnline()) break;
      const token = this.makeKey();
      const claimed = await this.store.update((items) => claim(items, key, token, this.now(), this.policy, owner));
      if (!claimed) continue;
      this.emit();

      const outcome = await this.attempt(claimed, token);
      await this.store.update((items) => settle(items, key, token, outcome, this.now(), this.policy));

      if (outcome.type === "sent") report.sent += 1;
      else if (outcome.type === "busy") report.busy += 1;
      else if (outcome.type === "retry" && claimed.attempts < this.policy.maxAttempts) report.retry += 1;
      else report.stuck += 1;
      this.emit();
    }

    await this.store.update((items) => pruneSent(items));
    return report;
  }

  private async attempt(item: OutboxItem<P>, token: string): Promise<AttemptOutcome> {
    const context: SendContext = {
      headers: requestHeaders(item, this.headerOptions?.(item) ?? {}),
      attempt: item.attempts,
    };
    let renew: unknown = null;
    if (this.policy.claimRenewMs > 0 && timers.setInterval && timers.clearInterval) {
      renew = timers.setInterval(() => {
        void this.store.update((items) => renewClaim(items, item.key, token, this.now())).catch(() => undefined);
      }, this.policy.claimRenewMs);
    }
    try {
      return await this.send(item, context);
    } catch (err) {
      return classifyThrown(err);
    } finally {
      if (renew !== null) timers.clearInterval?.(renew);
    }
  }

  private async change<T>(fn: (items: OutboxItem<P>[]) => T): Promise<T> {
    const result = await this.store.update(fn);
    this.emit();
    return result;
  }

  private emit(): void {
    for (const listener of Array.from(this.listeners)) {
      try {
        listener();
      } catch {
        /* a listener never breaks the outbox */
      }
    }
  }
}
