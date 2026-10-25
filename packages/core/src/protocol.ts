/**
 * The small wire contract between a HoldSend client and a server.
 *
 * Request:
 *   Idempotency-Key: <item key>            same value on every attempt
 *   Written-At: <ISO 8601 with zone>        when the person wrote it
 *
 * The written time travels in a header, not in the body, so the body the
 * server hashes to compare retries is exactly what the app wrote.
 *
 * Response:
 *   2xx                      stored (first time) or replayed (same key, same body)
 *   Idempotent-Replayed: true  set on a replay, informational
 *   409 + code "key_conflict"  this key already holds a DIFFERENT request
 *   409 + code "in_progress"   an earlier attempt with this key is still running
 *   410 + code "gone"          created once with this key and deleted since
 *
 * The code is read from a JSON body field `code` (or `error.code`) by the
 * app's transport and passed to `classifyResponse`.
 */
import type { AttemptOutcome, ItemError, OutboxItem } from "./types.js";
import { formatWrittenAt } from "./time.js";

export const IDEMPOTENCY_KEY_HEADER = "Idempotency-Key";
export const WRITTEN_AT_HEADER = "Written-At";
export const REPLAYED_HEADER = "Idempotent-Replayed";

export const ERROR_KEY_CONFLICT = "key_conflict";
export const ERROR_IN_PROGRESS = "in_progress";
export const ERROR_GONE = "gone";

export interface RequestHeaderOptions {
  /**
   * Leave the written time out. Use this for content whose writing time is
   * itself sensitive (for example, it could reveal when and roughly where an
   * anonymous source was without a network).
   */
  omitWrittenAt?: boolean;
}

/** The headers every attempt for this item must carry. */
export function requestHeaders(item: Pick<OutboxItem, "key" | "writtenAt">, options: RequestHeaderOptions = {}): Record<string, string> {
  const headers: Record<string, string> = { [IDEMPOTENCY_KEY_HEADER]: item.key };
  if (!options.omitWrittenAt && Number.isFinite(item.writtenAt) && item.writtenAt > 0) {
    headers[WRITTEN_AT_HEADER] = formatWrittenAt(item.writtenAt);
  }
  return headers;
}

/**
 * Maps an HTTP answer to what it means for the item.
 *
 * Anything without a definite answer is "retry" with the same key: the
 * request may or may not have reached the server, and the key makes a second
 * arrival harmless.
 */
export function classifyResponse(status: number, code?: string, message?: string): AttemptOutcome {
  const error: ItemError = { message: message || `HTTP ${status}` };
  if (code) error.code = code;

  if (status >= 200 && status < 300) return { type: "sent" };
  if (status === 410 && code === ERROR_GONE) return { type: "sent" };
  if (status === 409 && code === ERROR_KEY_CONFLICT) return { type: "conflict", error };
  if (status === 409 && code === ERROR_IN_PROGRESS) return { type: "busy", error };

  // No definite answer, or an answer that may change by itself later:
  // timeouts, rate limits, server trouble, and auth that may be refreshed.
  if (status === 0 || status === 401 || status === 403 || status === 408 || status === 425 || status === 429 || status >= 500) {
    return { type: "retry", error };
  }
  // Any other 4xx is the server refusing this request. Repeating it would
  // only repeat the refusal.
  if (status >= 400 && status < 500) return { type: "refused", error };
  return { type: "retry", error };
}

/** A thrown error (fetch failed, timeout, offline) always means "no answer". */
export function classifyThrown(err: unknown): AttemptOutcome {
  const message = err instanceof Error && err.message ? err.message : String(err ?? "Network error");
  return { type: "retry", error: { message } };
}
