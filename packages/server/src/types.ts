/**
 * The contract every idempotency store keeps.
 *
 * A record is unique on (owner, operation, key). `owner` is whoever the
 * request is authenticated as, so one person's key can never collide with or
 * reveal another person's request. `operation` names what the request does,
 * for example "post.create".
 *
 * The flow for one keyed request:
 *
 *   claim     a short, separate statement. Exactly one concurrent request
 *             wins; the others are told what the record already says.
 *   create    the app writes its resource inside store.transaction().
 *   complete  inside THAT SAME transaction, the record becomes "completed",
 *             but only if this request still holds its claim token. If the
 *             claim was lost, completion throws and the transaction (and the
 *             resource) rolls back. So a committed resource always has a
 *             completed record, and the reverse.
 *   release   if create fails, the claim is deleted so a retry can try again.
 *
 * The claim is not held open across the create on purpose: creating can take
 * seconds (uploads, moderation), and holding a pooled connection and a row
 * lock through that would let a burst of slow requests exhaust the pool.
 */

export interface RecordId {
  owner: string;
  operation: string;
  key: string;
}

/** What the server answered the first time. Replayed verbatim for a repeated key. */
export interface StoredResult {
  status: number;
  body: unknown;
}

export type ClaimOutcome =
  /** This request owns the key. Create the resource, then complete with this token. */
  | { type: "claimed"; token: string }
  /** Completed before with the same request. Answer with the original result. */
  | { type: "replay"; result: StoredResult }
  /** The key holds a different request. */
  | { type: "conflict" }
  /** Another request with this key is still being processed. */
  | { type: "in_progress" }
  /** Created once with this key and deleted since. Never create it again. */
  | { type: "gone" };

export interface ClaimInput extends RecordId {
  /** Hash of the request content (see hashRequest). */
  requestHash: string;
  /** Epoch ms; the store's own clock when omitted. */
  now?: number;
}

export interface CompleteInput extends RecordId {
  token: string;
  result: StoredResult;
  /**
   * The id of the resource the request created, so it can be tombstoned when
   * the resource is deleted (see tombstoneResource).
   */
  resourceRef?: string;
}

export interface StoreOptions {
  /**
   * A claim older than this whose owner never completed or released it is
   * presumed dead and may be taken over. Safe because a dead owner never
   * committed. Default 5 minutes. Must be longer than your slowest create.
   */
  staleClaimMs?: number;
  /**
   * How long a completed record lives. Default: forever. Content written
   * offline can wait weeks before its final retry, and a record that expired
   * first would let that retry create a second copy. Set this only for
   * operations whose retries cannot arrive late.
   */
  completedTtlMs?: number;
}

/** Thrown by completeInTransaction when this request no longer holds the claim. */
export class ClaimLostError extends Error {
  constructor(message = "the idempotency claim was lost before the write committed") {
    super(message);
    this.name = "ClaimLostError";
  }
}

export interface IdempotencyStore<Tx = unknown> {
  claim(input: ClaimInput): Promise<ClaimOutcome>;
  /** Runs `fn` in one database transaction. Commits if it resolves, rolls back if it throws. */
  transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
  /** Marks the record completed inside `tx`. Throws ClaimLostError if the claim is no longer held. */
  completeInTransaction(tx: Tx, input: CompleteInput): Promise<void>;
  /** Deletes an unfinished claim held by `token`. No effect if the claim is gone or was taken over. */
  release(id: RecordId, token: string): Promise<void>;
  /**
   * Call inside the transaction that deletes a resource. The record that
   * created it becomes a tombstone: a late retry is answered "gone" instead
   * of creating the resource again. The stored request hash and result are
   * cleared, so a tombstone keeps nothing derived from what the person wrote.
   */
  tombstoneResource(tx: Tx, owner: string, operation: string, resourceRef: string): Promise<number>;
  /** Deletes records whose expiry has passed. Returns how many. */
  purgeExpired(now?: number): Promise<number>;
}
