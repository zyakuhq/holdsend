/**
 * An in-memory idempotency store with the full contract, for tests and
 * single-process demos. Not durable, not shared between processes.
 *
 * Transactions are simulated faithfully enough to test against: changes made
 * inside transaction() are applied only when the callback resolves, and are
 * discarded if it throws. Completion re-checks the claim token at commit.
 */
import { newKey } from "@holdsend/core";
import {
  ClaimLostError,
  type ClaimInput,
  type ClaimOutcome,
  type CompleteInput,
  type IdempotencyStore,
  type RecordId,
  type StoreOptions,
  type StoredResult,
} from "./types.js";

const DEFAULT_STALE_CLAIM_MS = 5 * 60 * 1000;

interface MemoryRecord {
  requestHash: string;
  state: "in_progress" | "completed" | "gone";
  claimToken?: string;
  claimedAt?: number;
  result?: StoredResult;
  resourceRef?: string;
  expiresAt?: number;
}

type PendingChange = () => void;

export interface MemoryTx {
  readonly changes: PendingChange[];
  readonly checks: (() => void)[];
}

function id(r: RecordId): string {
  return JSON.stringify([r.owner, r.operation, r.key]);
}

function clone<T>(value: T): T {
  return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
}

export class MemoryIdempotencyStore implements IdempotencyStore<MemoryTx> {
  private readonly records = new Map<string, MemoryRecord>();
  private readonly staleClaimMs: number;
  private readonly completedTtlMs: number | undefined;
  private readonly clock: () => number;

  constructor(options: StoreOptions & { now?: () => number } = {}) {
    this.staleClaimMs = options.staleClaimMs ?? DEFAULT_STALE_CLAIM_MS;
    this.completedTtlMs = options.completedTtlMs;
    this.clock = options.now ?? Date.now;
  }

  async claim(input: ClaimInput): Promise<ClaimOutcome> {
    const now = input.now ?? this.clock();
    const key = id(input);
    const existing = this.records.get(key);
    if (existing && existing.expiresAt !== undefined && existing.expiresAt <= now) this.records.delete(key);
    const record = this.records.get(key);

    if (!record) {
      const token = newKey();
      this.records.set(key, { requestHash: input.requestHash, state: "in_progress", claimToken: token, claimedAt: now });
      return { type: "claimed", token };
    }
    if (record.state === "gone") return { type: "gone" };
    if (record.state === "completed") {
      return record.requestHash === input.requestHash && record.result
        ? { type: "replay", result: clone(record.result) }
        : { type: "conflict" };
    }
    // In progress.
    if (now - (record.claimedAt ?? 0) > this.staleClaimMs) {
      const token = newKey();
      record.claimToken = token;
      record.claimedAt = now;
      record.requestHash = input.requestHash;
      return { type: "claimed", token };
    }
    return record.requestHash === input.requestHash ? { type: "in_progress" } : { type: "conflict" };
  }

  async transaction<T>(fn: (tx: MemoryTx) => Promise<T>): Promise<T> {
    const tx: MemoryTx = { changes: [], checks: [] };
    const value = await fn(tx);
    // Commit: every check passes or nothing is applied.
    for (const check of tx.checks) check();
    for (const change of tx.changes) change();
    return value;
  }

  async completeInTransaction(tx: MemoryTx, input: CompleteInput): Promise<void> {
    const key = id(input);
    const check = () => {
      const record = this.records.get(key);
      if (!record || record.state !== "in_progress" || record.claimToken !== input.token) throw new ClaimLostError();
    };
    check();
    const result = clone(input.result);
    tx.checks.push(check);
    tx.changes.push(() => {
      const record = this.records.get(key);
      if (!record) return;
      record.state = "completed";
      record.result = result;
      delete record.claimToken;
      if (input.resourceRef !== undefined) record.resourceRef = input.resourceRef;
      if (this.completedTtlMs !== undefined) record.expiresAt = this.clock() + this.completedTtlMs;
    });
  }

  async release(rid: RecordId, token: string): Promise<void> {
    const key = id(rid);
    const record = this.records.get(key);
    if (record && record.state === "in_progress" && record.claimToken === token) this.records.delete(key);
  }

  async tombstoneResource(tx: MemoryTx, owner: string, operation: string, resourceRef: string): Promise<number> {
    let count = 0;
    for (const [key, record] of this.records) {
      const [o, op] = JSON.parse(key) as [string, string, string];
      if (o === owner && op === operation && record.resourceRef === resourceRef && record.state === "completed") count += 1;
    }
    tx.changes.push(() => {
      for (const [key, record] of this.records) {
        const [o, op] = JSON.parse(key) as [string, string, string];
        if (o === owner && op === operation && record.resourceRef === resourceRef && record.state === "completed") {
          record.state = "gone";
          record.requestHash = "";
          delete record.result;
          delete record.expiresAt;
        }
      }
    });
    return count;
  }

  async purgeExpired(now: number = this.clock()): Promise<number> {
    let count = 0;
    for (const [key, record] of this.records) {
      const staleClaim = record.state === "in_progress" && now - (record.claimedAt ?? 0) > this.staleClaimMs;
      const expired = record.expiresAt !== undefined && record.expiresAt <= now;
      if (staleClaim || expired) {
        this.records.delete(key);
        count += 1;
      }
    }
    return count;
  }

  /** Test helper: how many records exist. */
  get size(): number {
    return this.records.size;
  }
}
