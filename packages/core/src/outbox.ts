/**
 * The outbox runtime: the rules in transitions.ts, applied to a Store, with a
 * flush loop that sends what is sendable.
 *
 * Platform packages wire it to real storage, a cross-device lock and network
 * events. On its own it runs anywhere JavaScript runs.
 */
import { newKey as defaultNewKey, isValidKey } from "./key.js";
import { classifyThrown, requestHeaders, type RequestHeaderOptions } from "./protocol.js";
import { clone, type Store } from "./store.js";
import { assertPlainJson } from "./json.js";
import {
  approve as approveItem,
  cancel as cancelItem,
  claim,
  discard as discardItem,
  isSendable,
  nextWakeMs,
  pruneSent,
  renewClaim,
  retry as retryItem,
  settle,
  statusOf,
  type CancelResult,
  type DiscardResult,
  type RetryResult,
} from "./transitions.js";
import { resolvePolicy, type AttemptOutcome, type ItemStatus, type OutboxItem, type Policy, type PolicyOptions } from "./types.js";

export interface SendContext {
  /** Idempotency-Key (and Written-At unless omitted). Send them on the request. */
  headers: Record<string, string>;
  /**
   * This attempt's number, from 1, counting only attempts that got an answer
   * from the server: attempts with no answer and "busy" answers are given
   * back, so the number can repeat. For logs, not for logic.
   */
  attempt: number;
  /**
   * Fires when the attempt is abandoned (policy.attemptTimeoutMs). Pass it to
   * fetch so the request is really cancelled. The attempt counts as "no
   * answer" either way, and the item is tried again later with the same key.
   */
  signal?: AbortSignal;
}

/**
 * Sends one item. Return the outcome (use `classifyResponse` for HTTP).
 * Throwing is treated as "no answer": the item is retried later, same key.
 */
export type Sender<P> = (item: OutboxItem<P>, context: SendContext) => Promise<AttemptOutcome>;

export interface OutboxOptions<P> {
  store: Store<P>;
  send: Sender<P>;
  policy?: PolicyOptions;
  /** Defaults to Date.now. */
  now?: () => number;
  /** Defaults to a random UUID. */
  newKey?: () => string;
  /** Checked before each send. Defaults to always true. */
  isOnline?: () => boolean;
  /** Per item header choices, for example leaving out the written time. */
  headerOptions?: (item: OutboxItem<P>) => RequestHeaderOptions;
}

export interface AddOptions<P = unknown> {
  /** Who wrote it. A flush for one owner never sends another owner's items. */
  owner?: string;
  /**
   * Reuse a key an earlier live attempt already sent, so a request that may
   * have reached the server is queued under the same key and cannot create a
   * second copy. Such an item counts as possibly sent: it cannot be
   * cancelled, only finished (or discarded with a "may exist" warning).
   */
  key?: string;
  /** When the person wrote it. Defaults to now. */
  writtenAt?: number;
  /**
   * Runs inside the store's atomic update, with the items not yet sent, so
   * no other tab or sender can change the queue in between. Return one of
   * those items to add nothing and get that item back (for example the same
   * message tapped twice), "hold" to add the new item held until a person
   * approves it, or nothing to add it as usual.
   */
  decide?: (queued: readonly OutboxItem<P>[]) => OutboxItem<P> | "hold" | undefined;
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
  /**
   * Set when items are held by another sender's claim: look again after this
   * many ms. If that sender died, its claim will then have gone stale and
   * this sender can take the item over.
   */
  nextCheckInMs?: number;
}

interface TimerApi {
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  AbortController?: new () => { signal: AbortSignal; abort(reason?: unknown): void };
}

const timers = globalThis as unknown as TimerApi;

function emptyReport(): FlushReport {
  return { sent: 0, retry: 0, busy: 0, stuck: 0 };
}

export class Outbox<P = unknown> {
  readonly policy: Readonly<Policy>;
  private readonly store: Store<P>;
  private readonly send: Sender<P>;
  private readonly now: () => number;
  private readonly makeKey: () => string;
  private readonly isOnline: () => boolean;
  private readonly headerOptions: ((item: OutboxItem<P>) => RequestHeaderOptions) | undefined;
  private readonly listeners = new Set<() => void>();
  private running: Promise<FlushReport> | null = null;
  /** Owners asked for while a flush runs. `null` stands for "every owner". */
  private queued = new Set<string | null>();

  constructor(options: OutboxOptions<P>) {
    this.store = options.store;
    this.send = options.send;
    this.policy = resolvePolicy(options.policy);
    this.now = options.now ?? Date.now;
    this.makeKey = options.newKey ?? defaultNewKey;
    this.isOnline = options.isOnline ?? (() => true);
    this.headerOptions = options.headerOptions;
  }

  /** Keeps something the person wrote. Resolves once it is stored. */
  async add(kind: string, payload: P, options: AddOptions<P> = {}): Promise<OutboxItem<P>> {
    if (options.key !== undefined && !isValidKey(options.key)) {
      throw new TypeError("key must be 8 to 128 characters of letters, digits, '_', '-', ':' or '.'");
    }
    const writtenAt = options.writtenAt ?? this.now();
    if (!Number.isFinite(writtenAt) || writtenAt <= 0) throw new TypeError("writtenAt must be a positive epoch time in ms");
    assertPlainJson(payload);
    const item: OutboxItem<P> = {
      key: options.key ?? this.makeKey(),
      kind,
      // A snapshot, so changing the object after add() cannot change what is sent.
      payload: clone(payload),
      writtenAt,
      state: "waiting",
      attempts: 0,
      // A key from an earlier live attempt means the request may already be on the server.
      touched: options.key !== undefined,
    };
    if (options.owner !== undefined) item.owner = options.owner;
    const existing = await this.store.update((items) => {
      if (items.some((i) => i.key === item.key)) throw new Error(`an item with key ${item.key} is already in the outbox`);
      const queued = items.filter((i) => i.state !== "sent");
      const decided = options.decide?.(queued);
      if (decided !== undefined && decided !== "hold") {
        if (!queued.includes(decided)) throw new Error("decide must return one of the queued items it was given");
        return clone(decided);
      }
      if (decided === "hold") item.held = true;
      items.push(item);
      return undefined;
    });
    if (existing) return existing;
    this.emit();
    return clone(item);
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

  /** Approves one item that waited longer than the confirmation age. See RetryResult for `newKey`. */
  approve(key: string): Promise<RetryResult> {
    return this.change((items) => approveItem(items, key, this.now(), this.makeKey, this.policy));
  }

  /** Resets one stuck item for sending. See RetryResult for when its key changes and what that means. */
  retry(key: string): Promise<RetryResult> {
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
   * Sends everything sendable (for `owner`, if given; every owner otherwise).
   * Only one flush runs at a time per Outbox. Flushes asked for while one
   * runs are queued, each owner once, and run before the returned promise
   * resolves, so nothing asked for in the meantime is missed.
   */
  flush(owner?: string): Promise<FlushReport> {
    if (this.running) {
      this.queued.add(owner ?? null);
      return this.running;
    }
    const run = (async () => {
      const total = emptyReport();
      let next: string | null = owner ?? null;
      try {
        for (;;) {
          const report = await this.pass(next ?? undefined);
          total.sent += report.sent;
          total.retry += report.retry;
          total.busy += report.busy;
          total.stuck += report.stuck;
          if (report.nextCheckInMs !== undefined) {
            total.nextCheckInMs = Math.min(total.nextCheckInMs ?? Infinity, report.nextCheckInMs);
          }
          const [following] = this.queued;
          if (following === undefined) {
            // Checking the queue and finishing happen in one synchronous
            // step, so a flush asked for from now on starts a new run
            // instead of being queued behind one that is already over.
            this.running = null;
            return total;
          }
          this.queued.delete(following);
          next = following;
        }
      } catch (err) {
        // Everyone waiting on this run gets the error; nothing stays queued
        // to ride along on some later, unrelated flush.
        this.running = null;
        this.queued.clear();
        throw err;
      }
    })();
    // The run cannot have finished yet: it always awaits before returning.
    this.running = run;
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
      const after = await this.store.update((items) => {
        settle(items, key, token, outcome, this.now(), this.policy);
        return items.find((i) => i.key === key);
      });

      if (outcome.type === "sent") report.sent += 1;
      else if (outcome.type === "busy") report.busy += 1;
      else if (after?.state === "stuck") report.stuck += 1;
      else report.retry += 1;
      this.emit();
    }

    const waitMs = await this.store.update((items) => {
      pruneSent(items);
      return nextWakeMs(items, this.now(), this.policy, owner);
    });
    if (waitMs !== undefined) report.nextCheckInMs = waitMs;
    return report;
  }

  private async attempt(item: OutboxItem<P>, token: string): Promise<AttemptOutcome> {
    const Controller = timers.AbortController ?? (globalThis as unknown as TimerApi).AbortController;
    const controller = Controller ? new Controller() : null;
    const context: SendContext = {
      headers: requestHeaders(item, this.headerOptions?.(item) ?? {}),
      attempt: item.attempts,
    };
    if (controller) context.signal = controller.signal;

    let renew: unknown = null;
    if (this.policy.claimRenewMs > 0) {
      renew = timers.setInterval(() => {
        void this.store.update((items) => renewClaim(items, item.key, token, this.now())).catch(() => undefined);
      }, this.policy.claimRenewMs);
    }
    // Each attempt abandoned in a row doubles the next timeout (up to 16x),
    // so a large upload on a slow link gets the time it needs.
    const timeoutMs = this.policy.attemptTimeoutMs * 2 ** Math.min(item.timeouts ?? 0, 4);
    let timeout: unknown = null;
    const abandoned = new Promise<AttemptOutcome>((resolve) => {
      timeout = timers.setTimeout(() => {
        controller?.abort(new Error("attempt timed out"));
        resolve({ type: "retry", error: { message: "No answer before the attempt timed out" }, noAnswer: true, timedOut: true });
      }, timeoutMs);
    });
    // Promise.resolve().then(...) also catches a send() that throws synchronously.
    const answer = Promise.resolve()
      .then(() => this.send(item, context))
      .catch((err: unknown) => classifyThrown(err));
    try {
      // Whichever comes first: the answer, or the timeout. A send that never
      // settles can no longer hold its item (or this Outbox) forever.
      return await Promise.race([answer, abandoned]);
    } finally {
      if (renew !== null) timers.clearInterval(renew);
      if (timeout !== null) timers.clearTimeout(timeout);
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
