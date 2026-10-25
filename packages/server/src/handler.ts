/**
 * The request flow, framework-agnostic.
 *
 *   const answer = await handleIdempotent({
 *     store, owner: session.userId, operation: "post.create",
 *     headers: req.headers, content: req.body,
 *     create: async (tx) => {
 *       const post = await insertPost(tx, req.body, { writtenAt: answer.writtenAt });
 *       return { status: 201, body: post, resourceRef: post.id };
 *     },
 *   });
 *   res.status(answer.status).set(answer.headers).json(answer.body);
 *
 * `create` runs inside store.transaction(), and the record is completed in
 * that same transaction, so the write and its record commit together or not
 * at all.
 */
import {
  ERROR_GONE,
  ERROR_IN_PROGRESS,
  ERROR_KEY_CONFLICT,
  IDEMPOTENCY_KEY_HEADER,
  REPLAYED_HEADER,
  WRITTEN_AT_HEADER,
  acceptWrittenAt,
  isValidKey,
  type WrittenAtBounds,
} from "@holdsend/core";
import { hashRequest } from "./hash.js";
import { ClaimLostError, type IdempotencyStore, type StoredResult } from "./types.js";

export type HeaderSource =
  | { get(name: string): string | null | undefined }
  | Record<string, string | string[] | undefined>;

/** Reads a header from a Fetch `Headers`, a Node `IncomingHttpHeaders` or a plain object, ignoring case. */
export function readHeader(headers: HeaderSource | undefined, name: string): string | undefined {
  if (!headers) return undefined;
  if (typeof (headers as { get?: unknown }).get === "function") {
    const value = (headers as { get(n: string): string | null | undefined }).get(name);
    return value ?? undefined;
  }
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers as Record<string, string | string[] | undefined>)) {
    if (k.toLowerCase() === lower) return Array.isArray(v) ? v.join(",") : v;
  }
  return undefined;
}

export type KeyRead = { ok: true; key: string | null } | { ok: false };

/** The Idempotency-Key header: absent, valid, or invalid. */
export function parseIdempotencyKey(headers: HeaderSource | undefined): KeyRead {
  const raw = readHeader(headers, IDEMPOTENCY_KEY_HEADER);
  if (raw === undefined || raw.trim() === "") return { ok: true, key: null };
  const key = raw.trim();
  return isValidKey(key) ? { ok: true, key } : { ok: false };
}

/**
 * The written time to store with this request, or null. Accepted only on a
 * request with a valid Idempotency-Key, and only within the bounds of
 * acceptWrittenAt. Never throws.
 *
 * Any client can send a key and a Written-At header, so the bounds (at most
 * two minutes ahead, at most 30 days back, by default) are the real limit.
 * Store it in its own column, show it as when the author says they wrote it,
 * and never order a feed by it.
 */
export function writtenAtFromRequest(headers: HeaderSource | undefined, now: number = Date.now(), bounds?: WrittenAtBounds): number | null {
  try {
    const key = parseIdempotencyKey(headers);
    if (!key.ok || key.key === null) return null;
    return acceptWrittenAt(readHeader(headers, WRITTEN_AT_HEADER), now, bounds);
  } catch {
    return null;
  }
}

export interface CreateResult extends StoredResult {
  /** The created resource's id, so it can be tombstoned when deleted. */
  resourceRef?: string;
}

export interface HandleOptions<Tx> {
  store: IdempotencyStore<Tx>;
  /** The authenticated identity. Never take this from the request body. */
  owner: string;
  /** What this endpoint does, for example "post.create". */
  operation: string;
  headers: HeaderSource | undefined;
  /**
   * The request content that defines "the same request". Pass the body as
   * the person wrote it; leave out anything that is not content.
   */
  content: unknown;
  /** Writes the resource inside the transaction. Its result is stored and replayed. */
  create: (tx: Tx, context: { writtenAt: number | null; key: string | null }) => Promise<CreateResult>;
  /** Reject requests without a key (400 key_required). Default false: they run unkeyed. */
  requireKey?: boolean;
  /** How long to wait for an in-progress duplicate to finish before answering 409. Default 2000 ms. */
  waitMs?: number;
  /** First delay between looks while waiting; doubles each time, up to 500 ms. Default 50 ms. */
  pollMs?: number;
  now?: () => number;
  writtenAtBounds?: WrittenAtBounds;
}

export interface IdempotentAnswer {
  status: number;
  body: unknown;
  headers: Record<string, string>;
  /** What happened, for logs and tests. */
  outcome: "created" | "replayed" | "unkeyed" | "conflict" | "in_progress" | "gone" | "invalid_key" | "key_required";
}

function errorAnswer(status: number, code: string, message: string, outcome: IdempotentAnswer["outcome"], headers: Record<string, string> = {}): IdempotentAnswer {
  return { status, body: { code, message }, headers, outcome };
}

const timers = globalThis as unknown as { setTimeout(fn: () => void, ms: number): unknown };
const sleep = (ms: number) => new Promise<void>((resolve) => timers.setTimeout(resolve, ms));

export async function handleIdempotent<Tx>(options: HandleOptions<Tx>): Promise<IdempotentAnswer> {
  const now = options.now ?? Date.now;
  const keyRead = parseIdempotencyKey(options.headers);
  if (!keyRead.ok) {
    return errorAnswer(400, "invalid_key", "Idempotency-Key must be 8 to 128 characters of letters, digits, '_', '-', ':' or '.'.", "invalid_key");
  }
  const writtenAt = writtenAtFromRequest(options.headers, now(), options.writtenAtBounds);

  if (keyRead.key === null) {
    if (options.requireKey) return errorAnswer(400, "key_required", "This endpoint requires an Idempotency-Key header.", "key_required");
    const result = await options.store.transaction((tx) => options.create(tx, { writtenAt: null, key: null }));
    return { status: result.status, body: result.body, headers: {}, outcome: "unkeyed" };
  }

  const key = keyRead.key;
  const record = { owner: options.owner, operation: options.operation, key };
  const requestHash = await hashRequest(options.operation, options.content);
  const waitMs = options.waitMs ?? 2000;
  let pollMs = Math.max(10, options.pollMs ?? 50);
  const deadline = now() + waitMs;

  for (;;) {
    const claimed = await options.store.claim({ ...record, requestHash, now: now() });
    switch (claimed.type) {
      case "replay":
        return {
          status: claimed.result.status,
          body: claimed.result.body,
          headers: { [REPLAYED_HEADER]: "true" },
          outcome: "replayed",
        };
      case "conflict":
        return errorAnswer(409, ERROR_KEY_CONFLICT, "This Idempotency-Key was already used for a different request.", "conflict");
      case "gone":
        return errorAnswer(410, ERROR_GONE, "This request was completed once and its result has since been deleted.", "gone");
      case "in_progress":
        if (now() < deadline) {
          await sleep(Math.min(pollMs, Math.max(0, deadline - now())));
          pollMs = Math.min(pollMs * 2, 500);
          continue;
        }
        return errorAnswer(409, ERROR_IN_PROGRESS, "A request with this Idempotency-Key is still being processed.", "in_progress", { "Retry-After": "1" });
      case "claimed": {
        let result: CreateResult;
        try {
          result = await options.store.transaction(async (tx) => {
            const created = await options.create(tx, { writtenAt, key });
            const stored: StoredResult = { status: created.status, body: created.body };
            await options.store.completeInTransaction(tx, {
              ...record,
              token: claimed.token,
              result: stored,
              ...(created.resourceRef !== undefined ? { resourceRef: created.resourceRef } : {}),
            });
            return created;
          });
        } catch (err) {
          // Nothing committed. Free the key so the client's retry can run.
          await options.store.release(record, claimed.token).catch(() => undefined);
          // Another request took the claim over while this one was slow. Its
          // write is the one that counts: look again and answer with it.
          if (err instanceof ClaimLostError && now() < deadline) continue;
          if (err instanceof ClaimLostError) {
            return errorAnswer(409, ERROR_IN_PROGRESS, "A request with this Idempotency-Key is still being processed.", "in_progress", { "Retry-After": "1" });
          }
          throw err;
        }
        return { status: result.status, body: result.body, headers: {}, outcome: "created" };
      }
    }
  }
}
