/**
 * The shapes HoldSend works with. Everything here is plain data so it can be
 * stored as JSON in any backend (IndexedDB, AsyncStorage, MMKV, a file).
 */

/** Where an item is in its life. */
export type ItemState =
  /** Kept on the device, will be sent when allowed. */
  | "waiting"
  /** A sender has claimed it and the request may be on the wire. */
  | "sending"
  /** The server confirmed it. Kept only until the next cleanup. */
  | "sent"
  /** Automatic sending stopped. Needs a person to retry or discard. */
  | "stuck";

/** Why an item became stuck, in machine-readable form. */
export type StuckReason =
  /** Every automatic attempt was used and none got a definite answer. */
  | "attempts_exhausted"
  /** The server holds a DIFFERENT request under this key. Retrying needs a new key. */
  | "key_conflict"
  /** The server refused the request itself (validation, size, policy). */
  | "refused"
  /**
   * No answer at all for longer than policy.giveUpAfterMs: something keeps
   * failing before the server answers (an app bug, a blocked request, a
   * wrong address). Shown to the person instead of retrying silently.
   */
  | "unreachable";

export interface ItemError {
  code?: string;
  message: string;
}

export interface OutboxItem<P = unknown> {
  /**
   * The idempotency key. Minted once when the item is added and sent on every
   * attempt. It only changes when the server proves the old key can never
   * succeed (a key conflict) and the person asks to retry.
   */
  key: string;
  /** App-defined label, for example "post.create". Not interpreted by HoldSend. */
  kind: string;
  /** Whatever the app needs to rebuild the request. Must be JSON-serialisable. */
  payload: P;
  /**
   * Who wrote it (for example a user id). A flush for one owner never sends
   * another owner's items, so a shared device never posts as the wrong person.
   */
  owner?: string;
  /** When the person wrote it, from the device clock (epoch ms). Set once. */
  writtenAt: number;
  state: ItemState;
  /**
   * Automatic attempts used since the item was added or last reset by a
   * person. Attempts that got no answer at all (offline, timeout, a network
   * that says it is connected but is not) do not count: they say nothing
   * about the request, only about the network.
   */
  attempts: number;
  /**
   * True once any attempt has started. Never reset. An item that may have
   * reached the server can no longer be cancelled, only finished.
   */
  touched: boolean;
  /** Set while state is "sending": when the claim was taken or last renewed. */
  claimedAt?: number;
  /** Set while state is "sending": identifies the sender holding the claim. */
  claimToken?: string;
  /** When a person approved sending an item that needed confirmation. */
  approvedAt?: number;
  /**
   * Held when it was added: never sent automatically, however recent, until a
   * person approves it. See AddOptions.decide.
   */
  held?: true;
  /**
   * After this time (epoch ms) it is not sent automatically until a person
   * approves it, whatever the sending outbox's policy says. Set from
   * AddOptions.askAfterMs, so the rule travels with the item to every sender.
   */
  askBy?: number;
  stuckReason?: StuckReason;
  lastError?: ItemError;
  /** When the server confirmed it (epoch ms, device clock). */
  sentAt?: number;
  /** Earliest time the next automatic attempt may start (backoff after a failed attempt). */
  retryAt?: number;
  /** Failed attempts in a row, answered or not; sets the backoff. */
  failures?: number;
  /** When the current run of attempts with no answer began. Cleared by any answer. */
  noAnswerSince?: number;
  /** Attempts abandoned at the timeout in a row; each doubles the next timeout. */
  timeouts?: number;
}

export interface Policy {
  /** Automatic attempts before an item becomes "stuck". Default 5. */
  maxAttempts: number;
  /**
   * A "sending" claim not renewed for this long belonged to a sender that died
   * (closed tab, killed app). Another sender may then take it over, with the
   * same key. Default 2 minutes.
   */
  staleClaimMs: number;
  /**
   * How often a live sender renews its claim during a long request. Must be
   * well below staleClaimMs. Set to 0 to disable renewal. Default 30 seconds.
   */
  claimRenewMs: number;
  /**
   * Items written longer ago than this are never sent automatically. A person
   * must approve them first. Default 30 days.
   */
  confirmAfterMs: number;
  /**
   * An attempt still unanswered after this long is abandoned: its AbortSignal
   * fires and it counts as "no answer". The item is tried again later with
   * the same key, so a late arrival on the server is still one copy. Without
   * this, a request that hangs forever would hold its item, and every later
   * flush, forever. Each abandoned attempt doubles the next one's timeout (up
   * to 16 times this), so a large upload on a slow link gets the time it
   * needs instead of restarting from zero forever. Default 2 minutes.
   */
  attemptTimeoutMs: number;
  /**
   * Waits between failed attempts of one item, in order; the last repeats.
   * Applies however often flush() is called. Default 1s, 5s, 15s, 30s, 1m,
   * 2m, 5m.
   */
  retryDelaysMs: readonly number[];
  /**
   * Attempts with no answer do not use up `maxAttempts` (they say nothing
   * about the request). But if nothing has answered for this long, the item
   * becomes stuck ("unreachable") so a person sees it. Default 24 hours.
   */
  giveUpAfterMs: number;
}

/** Policy fields to change; any left out or undefined keep their default. */
export type PolicyOptions = { [K in keyof Policy]?: Policy[K] | undefined };

/**
 * Fills in defaults for the fields `partial` leaves out (or sets to
 * undefined) and checks every value, so a typo or an unset environment
 * variable fails at start instead of quietly making claims look stale or
 * retrying forever. The result is frozen.
 */
export function resolvePolicy(partial: PolicyOptions = {}): Readonly<Policy> {
  const merged: Record<string, unknown> = { ...DEFAULT_POLICY };
  for (const [name, value] of Object.entries(partial)) if (value !== undefined) merged[name] = value;
  const policy = merged as unknown as Policy;
  const positive = (name: keyof Policy, allowZero = false) => {
    const value = policy[name] as number;
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || (!allowZero && value === 0)) {
      throw new RangeError(`policy.${name} must be a finite number${allowZero ? ", 0 or more" : " above 0"}`);
    }
  };
  positive("staleClaimMs");
  positive("claimRenewMs", true);
  positive("confirmAfterMs");
  positive("attemptTimeoutMs");
  positive("giveUpAfterMs");
  if (!Number.isInteger(policy.maxAttempts) || policy.maxAttempts < 1) throw new RangeError("policy.maxAttempts must be a whole number, 1 or more");
  if (!Array.isArray(policy.retryDelaysMs) || policy.retryDelaysMs.length === 0 || policy.retryDelaysMs.some((d) => !Number.isFinite(d) || d < 0)) {
    throw new RangeError("policy.retryDelaysMs must be a non-empty list of finite numbers, 0 or more");
  }
  if (policy.claimRenewMs > 0 && policy.claimRenewMs >= policy.staleClaimMs) {
    throw new RangeError("policy.claimRenewMs must be smaller than policy.staleClaimMs");
  }
  return Object.freeze({ ...policy, retryDelaysMs: Object.freeze([...policy.retryDelaysMs]) });
}

export const DEFAULT_POLICY: Readonly<Policy> = Object.freeze({
  maxAttempts: 5,
  staleClaimMs: 2 * 60 * 1000,
  claimRenewMs: 30 * 1000,
  confirmAfterMs: 30 * 24 * 60 * 60 * 1000,
  attemptTimeoutMs: 2 * 60 * 1000,
  retryDelaysMs: Object.freeze([1_000, 5_000, 15_000, 30_000, 60_000, 120_000, 300_000]),
  giveUpAfterMs: 24 * 60 * 60 * 1000,
});

/**
 * What one attempt ended as. `classifyResponse` maps an HTTP answer to this;
 * apps with other transports can produce it directly.
 */
export type AttemptOutcome =
  /** The server has it (first time, or a replay of the original). */
  | { type: "sent" }
  /**
   * Try later, with the same key. `noAnswer` means nothing came back at all
   * (offline, timeout, connection reset): such attempts do not use up the
   * item's attempt budget. Server answers like 5xx or 429 do.
   */
  | { type: "retry"; error?: ItemError; noAnswer?: boolean; timedOut?: boolean }
  /** The server is still processing an earlier attempt with this key. Not counted. */
  | { type: "busy"; error?: ItemError }
  /** The server holds a different request under this key. Final for this key. */
  | { type: "conflict"; error?: ItemError }
  /** The server refused the request itself. Final until a person retries. */
  | { type: "refused"; error?: ItemError };

/** What the outbox shows a person for one item. */
export type ItemStatus =
  /** Will be sent when there is a connection. Can be cancelled. */
  | "waiting"
  /** Being sent, or tried before without an answer. Cannot be cancelled. */
  | "sending"
  /** Written longer ago than the confirmation age: asks before sending. */
  | "needs_confirmation"
  /** Automatic sending stopped: retry or discard. */
  | "stuck"
  /** Delivered. */
  | "sent";
