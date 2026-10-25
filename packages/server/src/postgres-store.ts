/**
 * A Postgres idempotency store.
 *
 * Works with any client that has `query(text, params)` returning `{ rows }`:
 * node-postgres (`pg`) Pool or Client, PGlite, and other drivers with a thin
 * wrapper. Every changing statement uses RETURNING, so drivers that report no
 * row count work too. No runtime dependency on any of them.
 *
 * Create the table once with `postgresSchema()` (or copy the SQL into your
 * migrations).
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
} from "./types.js";

export interface QueryResultLike {
  rows: unknown[];
  rowCount?: number | null;
  /** PGlite reports affected rows under this name. */
  affectedRows?: number;
}

export interface Queryable {
  query(text: string, params?: unknown[]): Promise<QueryResultLike>;
}

export interface PostgresStoreOptions extends StoreOptions {
  /** Used for claims and releases, outside any transaction. */
  db: Queryable;
  /**
   * Runs `fn` inside one transaction and passes the transaction's client.
   * For node-postgres use `pgPoolTransaction(pool)`; for PGlite pass
   * `(fn) => pglite.transaction(fn)`.
   */
  transaction: <T>(fn: (tx: Queryable) => Promise<T>) => Promise<T>;
  /** Table name. Letters, digits and underscores, optionally schema-qualified. Default "holdsend_idempotency". */
  table?: string;
  /** Clock for claims (epoch ms). Default Date.now. */
  now?: () => number;
}

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]{0,62}(\.[A-Za-z_][A-Za-z0-9_]{0,62})?$/;
const DEFAULT_STALE_CLAIM_MS = 5 * 60 * 1000;

function quoteTable(name: string): string {
  if (!IDENTIFIER.test(name)) throw new TypeError(`invalid table name: ${name}`);
  return name
    .split(".")
    .map((part) => `"${part}"`)
    .join(".");
}

/**
 * Rows a statement touched. Every changing statement here ends in
 * RETURNING, so the returned rows are the count, whatever the driver reports
 * as rowCount (some report nothing at all).
 */
function touched(result: QueryResultLike): number {
  return result.rows.length;
}

/** A short, stable fingerprint of the table name, so index names stay under Postgres's 63-byte limit and never collide. */
function shortHash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

/** The DDL for the store's table. Idempotent: safe to run on every deploy. */
export function postgresSchema(table = "holdsend_idempotency"): string {
  const t = quoteTable(table);
  const base = `holdsend_${shortHash(table)}`;
  return `
CREATE TABLE IF NOT EXISTS ${t} (
  owner         TEXT NOT NULL,
  operation     TEXT NOT NULL,
  key           TEXT NOT NULL,
  request_hash  TEXT NOT NULL,
  state         TEXT NOT NULL CHECK (state IN ('in_progress', 'completed', 'gone')),
  claim_token   TEXT,
  claimed_at    TIMESTAMPTZ,
  result_status INTEGER,
  result_body   JSONB,
  resource_ref  TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at    TIMESTAMPTZ,
  PRIMARY KEY (owner, operation, key),
  CHECK (state <> 'in_progress' OR (claim_token IS NOT NULL AND claimed_at IS NOT NULL)),
  CHECK (state <> 'completed' OR result_status IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS "${base}_resource_idx" ON ${t} (owner, operation, resource_ref) WHERE resource_ref IS NOT NULL;
CREATE INDEX IF NOT EXISTS "${base}_expires_idx" ON ${t} (expires_at) WHERE expires_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS "${base}_claims_idx" ON ${t} (claimed_at) WHERE state = 'in_progress';
`.trim();
}

interface Row {
  request_hash: string;
  state: "in_progress" | "completed" | "gone";
  claim_token: string | null;
  claimed_at: Date | string | null;
  result_status: number | null;
  result_body: unknown;
}

function toMs(value: Date | string | null): number {
  if (value === null) return 0;
  return value instanceof Date ? value.getTime() : Date.parse(value);
}

function parseBody(value: unknown): unknown {
  // Some drivers return JSONB as text.
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }
  return value;
}

export class PostgresIdempotencyStore implements IdempotencyStore<Queryable> {
  private readonly db: Queryable;
  private readonly runTransaction: <T>(fn: (tx: Queryable) => Promise<T>) => Promise<T>;
  private readonly t: string;
  private readonly staleClaimMs: number;
  private readonly completedTtlMs: number | undefined;
  private readonly clock: () => number;

  constructor(options: PostgresStoreOptions) {
    this.db = options.db;
    this.runTransaction = options.transaction;
    this.t = quoteTable(options.table ?? "holdsend_idempotency");
    this.staleClaimMs = options.staleClaimMs ?? DEFAULT_STALE_CLAIM_MS;
    this.completedTtlMs = options.completedTtlMs;
    this.clock = options.now ?? Date.now;
  }

  async claim(input: ClaimInput): Promise<ClaimOutcome> {
    const now = new Date(input.now ?? this.clock());
    // Two rounds at most: the second only after removing an expired record.
    for (let round = 0; round < 2; round += 1) {
      const token = newKey();
      const inserted = await this.db.query(
        `INSERT INTO ${this.t} (owner, operation, key, request_hash, state, claim_token, claimed_at)
         VALUES ($1, $2, $3, $4, 'in_progress', $5, $6)
         ON CONFLICT (owner, operation, key) DO NOTHING
         RETURNING 1`,
        [input.owner, input.operation, input.key, input.requestHash, token, now],
      );
      if (touched(inserted) === 1) return { type: "claimed", token };

      const found = await this.db.query(
        `SELECT request_hash, state, claim_token, claimed_at, result_status, result_body, expires_at
           FROM ${this.t} WHERE owner = $1 AND operation = $2 AND key = $3`,
        [input.owner, input.operation, input.key],
      );
      const row = found.rows[0] as (Row & { expires_at: Date | string | null }) | undefined;
      // Released or purged between the insert and the select: try again.
      if (!row) continue;

      if (row.expires_at !== null && toMs(row.expires_at) <= now.getTime()) {
        await this.db.query(
          `DELETE FROM ${this.t} WHERE owner = $1 AND operation = $2 AND key = $3 AND expires_at IS NOT NULL AND expires_at <= $4 RETURNING 1`,
          [input.owner, input.operation, input.key, now],
        );
        continue;
      }
      return this.decide(input, row, now);
    }
    return { type: "in_progress" };
  }

  private async decide(input: ClaimInput, row: Row, now: Date): Promise<ClaimOutcome> {
    if (row.state === "gone") return { type: "gone" };
    if (row.request_hash !== input.requestHash) return { type: "conflict" };
    if (row.state === "completed") {
      if (row.result_status === null) return { type: "conflict" };
      return { type: "replay", result: { status: row.result_status, body: parseBody(row.result_body) } };
    }
    // In progress with the same request. Take over a claim nobody finished,
    // with the same guard completion uses: the old token must still be current.
    if (now.getTime() - toMs(row.claimed_at) > this.staleClaimMs) {
      const token = newKey();
      const taken = await this.db.query(
        `UPDATE ${this.t}
            SET claim_token = $5, claimed_at = $6, updated_at = now()
          WHERE owner = $1 AND operation = $2 AND key = $3 AND state = 'in_progress' AND claim_token = $4
          RETURNING 1`,
        [input.owner, input.operation, input.key, row.claim_token, token, now],
      );
      if (touched(taken) === 1) return { type: "claimed", token };
    }
    return { type: "in_progress" };
  }

  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
    return this.runTransaction(fn);
  }

  async completeInTransaction(tx: Queryable, input: CompleteInput): Promise<void> {
    const expiresAt = this.completedTtlMs === undefined ? null : new Date(this.clock() + this.completedTtlMs);
    const updated = await tx.query(
      `UPDATE ${this.t}
          SET state = 'completed', claim_token = NULL, result_status = $5, result_body = $6::jsonb,
              resource_ref = $7, expires_at = $8, updated_at = now()
        WHERE owner = $1 AND operation = $2 AND key = $3 AND state = 'in_progress' AND claim_token = $4
        RETURNING 1`,
      [
        input.owner,
        input.operation,
        input.key,
        input.token,
        input.result.status,
        JSON.stringify(input.result.body ?? null),
        input.resourceRef ?? null,
        expiresAt,
      ],
    );
    if (touched(updated) !== 1) throw new ClaimLostError();
  }

  async release(id: RecordId, token: string): Promise<void> {
    await this.db.query(
      `DELETE FROM ${this.t} WHERE owner = $1 AND operation = $2 AND key = $3 AND state = 'in_progress' AND claim_token = $4`,
      [id.owner, id.operation, id.key, token],
    );
  }

  async tombstoneResource(tx: Queryable, owner: string, operation: string, resourceRef: string): Promise<number> {
    const updated = await tx.query(
      `UPDATE ${this.t}
          SET state = 'gone', request_hash = '', result_status = NULL, result_body = NULL,
              expires_at = NULL, updated_at = now()
        WHERE owner = $1 AND operation = $2 AND resource_ref = $3 AND state = 'completed'
        RETURNING 1`,
      [owner, operation, resourceRef],
    );
    return touched(updated);
  }

  async purgeExpired(now: number = this.clock()): Promise<number> {
    const at = new Date(now);
    const staleBefore = new Date(now - this.staleClaimMs);
    const deleted = await this.db.query(
      `DELETE FROM ${this.t}
        WHERE (expires_at IS NOT NULL AND expires_at <= $1)
           OR (state = 'in_progress' AND claimed_at < $2)
        RETURNING 1`,
      [at, staleBefore],
    );
    return touched(deleted);
  }

  async forgetOwner(owner: string): Promise<number> {
    const deleted = await this.db.query(`DELETE FROM ${this.t} WHERE owner = $1 RETURNING 1`, [owner]);
    return touched(deleted);
  }
}

interface PoolLike {
  connect(): Promise<Queryable & { release(err?: unknown): void }>;
}

/** A `transaction` function for a node-postgres Pool: BEGIN, COMMIT, or ROLLBACK on error. */
export function pgPoolTransaction(pool: PoolLike): <T>(fn: (tx: Queryable) => Promise<T>) => Promise<T> {
  return async <T>(fn: (tx: Queryable) => Promise<T>): Promise<T> => {
    const client = await pool.connect();
    let broken: unknown;
    try {
      await client.query("BEGIN");
      const value = await fn(client);
      await client.query("COMMIT");
      return value;
    } catch (err) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackErr) {
        broken = rollbackErr;
      }
      throw err;
    } finally {
      // A client whose rollback failed is in an unknown state: destroy it.
      client.release(broken);
    }
  };
}
