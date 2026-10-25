/**
 * The outbox rules, as pure functions over a list of items.
 *
 * Nothing here does I/O or reads a clock: the list, the time and any new key
 * are arguments. Each function that changes the list is meant to run inside
 * ONE atomic read-modify-write of the store (see Store.update), so it decides
 * against the queue as it is at that instant, not against an old snapshot.
 *
 * The three guards against sending twice:
 *   1. one sender at a time per device (the store's lock, in platform packages)
 *   2. a per-item claim taken inside one atomic update (claim)
 *   3. the server's idempotency key, which turns any duplicate that still gets
 *      through into a replay of the original
 *
 * The guard against sending zero times: an item leaves the list only when the
 * server confirmed it, or when a person removes it.
 */
import type { AttemptOutcome, ItemStatus, OutboxItem, Policy } from "./types.js";
import { DEFAULT_POLICY } from "./types.js";

function find<P>(items: OutboxItem<P>[], key: string): OutboxItem<P> | undefined {
  return items.find((i) => i.key === key);
}

/** A sender holds this item and has renewed its claim recently. */
export function isClaimLive(item: OutboxItem, now: number, policy: Policy = DEFAULT_POLICY): boolean {
  return item.state === "sending" && now - (item.claimedAt ?? 0) <= policy.staleClaimMs;
}

/**
 * Written longer ago than the confirmation age, not approved, not finished.
 * Such an item is never sent automatically: the world it was written about
 * may have moved on. A person sees it and chooses Send or Discard.
 */
export function needsConfirmation(item: OutboxItem, now: number, policy: Policy = DEFAULT_POLICY): boolean {
  if (item.state === "sent" || item.approvedAt !== undefined) return false;
  if (!(now - item.writtenAt > policy.confirmAfterMs)) return false;
  // Being sent right now is not "waiting for a person": it is being sent.
  return !isClaimLive(item, now, policy);
}

/** May an automatic sender take this item now (for this owner)? */
export function isSendable(item: OutboxItem, now: number, policy: Policy = DEFAULT_POLICY, owner?: string): boolean {
  if (owner !== undefined && item.owner !== undefined && item.owner !== owner) return false;
  if (needsConfirmation(item, now, policy)) return false;
  if (item.attempts >= policy.maxAttempts) return false;
  if (item.state === "waiting") return true;
  // A claim nobody renewed: its sender is gone. Take it over, same key.
  if (item.state === "sending") return !isClaimLive(item, now, policy);
  return false;
}

/** What a person sees for this item. */
export function statusOf(item: OutboxItem, now: number, policy: Policy = DEFAULT_POLICY): ItemStatus {
  if (item.state === "sent") return "sent";
  if (needsConfirmation(item, now, policy)) return "needs_confirmation";
  if (item.state === "stuck") return "stuck";
  if (isClaimLive(item, now, policy)) return "sending";
  // A dead claim with no automatic attempts left will never be picked up again.
  if (item.state === "sending" && item.attempts >= policy.maxAttempts) return "stuck";
  // Tried before without an answer: it may be on the server, so it is
  // finished with its same key, never silently dropped.
  if (item.touched) return "sending";
  return "waiting";
}

/**
 * Takes one item for sending. Returns a copy of the claimed item, or null if
 * it is no longer sendable (another sender took it or finished it since the
 * caller's snapshot).
 */
export function claim<P>(
  items: OutboxItem<P>[],
  key: string,
  token: string,
  now: number,
  policy: Policy = DEFAULT_POLICY,
  owner?: string,
): OutboxItem<P> | null {
  const item = find(items, key);
  if (!item || !isSendable(item, now, policy, owner)) return null;
  item.state = "sending";
  item.claimedAt = now;
  item.claimToken = token;
  item.attempts += 1;
  item.touched = true;
  return { ...item };
}

/** A live sender says it is still working on this item. */
export function renewClaim(items: OutboxItem[], key: string, token: string, now: number): boolean {
  const item = find(items, key);
  if (!item || item.state !== "sending" || item.claimToken !== token) return false;
  item.claimedAt = now;
  return true;
}

/**
 * Records what one attempt ended as.
 *
 * "sent" is always recorded, whoever reports it: it is a fact about the
 * server. Any other outcome is recorded only by the sender that still holds
 * the claim, so a slow sender whose claim was taken over cannot undo the work
 * of the sender that took it.
 */
export function settle(items: OutboxItem[], key: string, token: string, outcome: AttemptOutcome, now: number, policy: Policy = DEFAULT_POLICY): void {
  const item = find(items, key);
  if (!item || item.state === "sent") return;

  if (outcome.type === "sent") {
    item.state = "sent";
    item.sentAt = now;
    delete item.claimedAt;
    delete item.claimToken;
    delete item.lastError;
    delete item.stuckReason;
    return;
  }

  if (item.state !== "sending" || item.claimToken !== token) return;
  delete item.claimedAt;
  delete item.claimToken;
  if (outcome.error) item.lastError = { ...outcome.error };

  switch (outcome.type) {
    case "busy":
      // The server is still finishing an earlier attempt. Not this attempt's
      // fault, so it does not count.
      item.state = "waiting";
      item.attempts = Math.max(0, item.attempts - 1);
      return;
    case "retry":
      if (item.attempts >= policy.maxAttempts) {
        item.state = "stuck";
        item.stuckReason = "attempts_exhausted";
      } else {
        item.state = "waiting";
      }
      return;
    case "conflict":
      item.state = "stuck";
      item.stuckReason = "key_conflict";
      return;
    case "refused":
      item.state = "stuck";
      item.stuckReason = "refused";
      return;
  }
}

export type CancelResult =
  /** Removed. It never left the device and never will. */
  | "cancelled"
  /** Refused: it is being sent, or was tried before and may be on the server. */
  | "in_flight"
  /** No such item, or it was already delivered. */
  | "not_found";

/**
 * A person cancels one waiting item. Only an item that no sender has ever
 * touched can truthfully be cancelled: once an attempt started, the request
 * may have reached the server, and removing the local copy would throw away
 * the same-key retry that settles it.
 */
export function cancel(items: OutboxItem[], key: string): CancelResult {
  const index = items.findIndex((i) => i.key === key);
  const item = items[index];
  if (!item || item.state === "sent") return "not_found";
  if (item.touched || item.state === "sending") return "in_flight";
  items.splice(index, 1);
  return "cancelled";
}

/**
 * A person approves sending one item that needs confirmation. The key never
 * changes: an earlier attempt may already be on the server, and the same key
 * is what makes the server answer with that original.
 */
export function approve(items: OutboxItem[], key: string, now: number, policy: Policy = DEFAULT_POLICY): boolean {
  const item = find(items, key);
  if (!item || !needsConfirmation(item, now, policy)) return false;
  item.approvedAt = now;
  if (item.state === "stuck" || item.state === "sending") {
    item.state = "waiting";
    delete item.claimedAt;
    delete item.claimToken;
    delete item.stuckReason;
  }
  item.attempts = 0;
  return true;
}

/**
 * A person retries one stuck item. Its attempts are reset. It keeps its key,
 * unless the server rejected the key itself (a conflict): then the server
 * proved nothing was created under that key for this content, so a new key
 * cannot cause a duplicate.
 */
export function retry(items: OutboxItem[], key: string, now: number, newKey: () => string, policy: Policy = DEFAULT_POLICY): string | null {
  const item = find(items, key);
  if (!item || statusOf(item, now, policy) !== "stuck") return null;
  if (item.stuckReason === "key_conflict") item.key = newKey();
  item.state = "waiting";
  item.attempts = 0;
  delete item.claimedAt;
  delete item.claimToken;
  delete item.stuckReason;
  delete item.lastError;
  return item.key;
}

export type DiscardResult =
  /** Removed. It never reached the server. */
  | "discarded"
  /** Removed, but an earlier attempt may have reached the server. */
  | "discarded_may_exist"
  /** Refused: a live sender holds it right now. */
  | "in_flight"
  | "not_found";

/**
 * A person removes one item that is stuck, needs confirmation, or was never
 * sent. Refused while a live sender holds it. The result says honestly
 * whether a copy may already exist on the server.
 */
export function discard(items: OutboxItem[], key: string, now: number, policy: Policy = DEFAULT_POLICY): DiscardResult {
  const index = items.findIndex((i) => i.key === key);
  const item = items[index];
  if (!item || item.state === "sent") return "not_found";
  if (isClaimLive(item, now, policy)) return "in_flight";
  items.splice(index, 1);
  return item.touched ? "discarded_may_exist" : "discarded";
}

/** Drops delivered items. Returns how many were removed. */
export function pruneSent(items: OutboxItem[]): number {
  const before = items.length;
  const keep = items.filter((i) => i.state !== "sent");
  items.splice(0, items.length, ...keep);
  return before - keep.length;
}
