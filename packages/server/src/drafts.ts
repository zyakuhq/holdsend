/**
 * Server side of one draft on two devices (decision 0009). It stores every
 * update, never refuses one for being stale, and gives each a revision number
 * from the server. It never merges and never picks a winner: `readDraft` from
 * `@holdsend/core/drafts` reads the log and lists the open heads.
 *
 *   const answer = await acceptDraftUpdate({ store, log, owner, headers, update });
 *
 * The update id is the Idempotency-Key, so a retry is the same update.
 */
import { readDraft, type DraftState, type DraftUpdate } from "@holdsend/core/drafts";
import { handleIdempotent, type IdempotentAnswer } from "./handler.js";
import { onMemoryCommit, type MemoryTx } from "./memory-store.js";
import type { Queryable } from "./postgres-store.js";
import type { IdempotencyStore } from "./types.js";

/** What a device sends. The id comes from the Idempotency-Key; the revision comes from the server. */
export interface NewDraftUpdate<T = unknown> {
  draftId: string;
  baseRev?: number | null;
  baseId?: string | null;
  reason: string;
  resolves?: readonly string[];
  writtenAt?: number;
  payload?: T;
}

export interface DraftLog<Tx> {
  /** Adds the update inside `tx` with the next revision. The same (owner, draftId, id) again returns the stored one and adds nothing. */
  append(tx: Tx, owner: string, update: NewDraftUpdate & { id: string }): Promise<DraftUpdate>;
  /** Every update of one draft, lowest revision first. */
  list(owner: string, draftId: string): Promise<DraftUpdate[]>;
}

const MAX_RESOLVES = 100;
const MAX_TEXT = 200;
const MAX_PAYLOAD_BYTES = 256 * 1024;
const MAX_INT4 = 2147483647;

const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
const wellFormed = (v: string): boolean => !LONE_SURROGATE.test(v);

/** True when a value is plain JSON that Postgres JSONB can store: no NUL, no lone surrogate, and every number finite. */
function storableJson(v: unknown, depth = 0): boolean {
  if (depth > 64) return false;
  if (v === null || typeof v === "boolean") return true;
  if (typeof v === "number") return Number.isFinite(v);
  if (typeof v === "string") return !v.includes("\u0000") && wellFormed(v);
  if (Array.isArray(v)) return v.every((x) => storableJson(x, depth + 1));
  if (typeof v === "object") return Object.entries(v as object).every(([k, x]) => storableJson(k, depth + 1) && storableJson(x, depth + 1));
  return false;
}

/** Returns a message when the update is malformed, or null when it is fine. */
export function checkDraftUpdate(u: unknown): string | null {
  if (typeof u !== "object" || u === null || Array.isArray(u)) return "update must be an object";
  const x = u as Record<string, unknown>;
  const text = (v: unknown) => typeof v === "string" && v.length > 0 && v.length <= MAX_TEXT && !v.includes("\u0000") && wellFormed(v);
  if (!text(x.draftId)) return "draftId must be a short non-empty string";
  if (!text(x.reason)) return "reason must be a short non-empty string";
  for (const k of ["baseRev"] as const) {
    const v = x[k];
    if (v != null && !(typeof v === "number" && Number.isSafeInteger(v) && v >= 1 && v <= MAX_INT4)) return `${k} must be a positive integer below 2147483648`;
  }
  if (x.baseId != null && !text(x.baseId)) return "baseId must be a short non-empty string";
  if (x.resolves !== undefined) {
    if (!Array.isArray(x.resolves) || x.resolves.length > MAX_RESOLVES || !x.resolves.every(text)) return `resolves must be a list of up to ${MAX_RESOLVES} ids`;
  }
  if (x.writtenAt != null && !(typeof x.writtenAt === "number" && Number.isSafeInteger(x.writtenAt) && x.writtenAt >= 0)) return "writtenAt must be epoch milliseconds";
  if (x.payload !== undefined) {
    if (!storableJson(x.payload)) return "payload must be plain JSON without NUL characters or lone surrogates";
    if (JSON.stringify(x.payload).length > MAX_PAYLOAD_BYTES) return `payload must be at most ${MAX_PAYLOAD_BYTES} characters of JSON`;
  }
  return null;
}

/** Only the known fields, the same shape Postgres returns, so memory and Postgres agree. */
function normalise(u: NewDraftUpdate & { id: string }, rev: number): DraftUpdate {
  const out: DraftUpdate = { id: u.id, draftId: u.draftId, rev, reason: u.reason };
  if (u.baseRev != null) out.baseRev = u.baseRev;
  if (u.baseId != null) out.baseId = u.baseId;
  if (u.resolves?.length) out.resolves = [...u.resolves];
  if (u.writtenAt != null) out.writtenAt = u.writtenAt;
  if (u.payload !== undefined && u.payload !== null) out.payload = clone(u.payload);
  return out;
}

function clone<T>(v: T): T {
  return v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T);
}

/** An in-memory draft log, for tests and single-process apps. Pairs with MemoryIdempotencyStore. */
export class MemoryDraftLog implements DraftLog<MemoryTx> {
  private readonly logs = new Map<string, DraftUpdate[]>();
  private readonly counters = new Map<string, number>();
  private static k(owner: string, draftId: string): string {
    return JSON.stringify([owner, draftId]);
  }

  async append(tx: MemoryTx, owner: string, update: NewDraftUpdate & { id: string }): Promise<DraftUpdate> {
    const k = MemoryDraftLog.k(owner, update.draftId);
    const existing = this.logs.get(k)?.find((u) => u.id === update.id);
    if (existing) return clone(existing);
    // Revisions come from a counter taken now, so two open transactions never share one. A rolled-back write leaves a gap, which is fine.
    const rev = (this.counters.get(k) ?? 0) + 1;
    this.counters.set(k, rev);
    const stored = normalise(update, rev);
    onMemoryCommit(tx, () => {
      const list = this.logs.get(k) ?? [];
      if (!list.some((u) => u.id === stored.id)) list.push(stored);
      list.sort((a, b) => a.rev - b.rev);
      this.logs.set(k, list);
    });
    return clone(stored);
  }

  async list(owner: string, draftId: string): Promise<DraftUpdate[]> {
    return clone(this.logs.get(MemoryDraftLog.k(owner, draftId)) ?? []);
  }
}

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;

/** The DDL for the Postgres draft log. Safe to run on every deploy. */
export function postgresDraftSchema(table = "holdsend_draft_updates"): string {
  if (!IDENTIFIER.test(table)) throw new TypeError(`invalid table name: ${table}`);
  return `
CREATE TABLE IF NOT EXISTS "${table}" (
  owner      TEXT NOT NULL,
  draft_id   TEXT NOT NULL,
  id         TEXT NOT NULL,
  rev        INTEGER NOT NULL,
  base_rev   INTEGER,
  base_id    TEXT,
  reason     TEXT NOT NULL,
  resolves   JSONB NOT NULL DEFAULT '[]',
  written_at BIGINT,
  payload    JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (owner, draft_id, id),
  UNIQUE (owner, draft_id, rev)
);
`.trim();
}

function parseJson(v: unknown): unknown {
  if (typeof v === "string") {
    try {
      return JSON.parse(v);
    } catch {
      return v;
    }
  }
  return v;
}

interface DraftRow {
  id: string;
  draft_id: string;
  rev: number | string;
  base_rev: number | string | null;
  base_id: string | null;
  reason: string;
  resolves: unknown;
  written_at: number | string | null;
  payload: unknown;
}

function fromRow(r: DraftRow): DraftUpdate {
  const u: DraftUpdate = { id: r.id, draftId: r.draft_id, rev: Number(r.rev), reason: r.reason };
  if (r.base_rev != null) u.baseRev = Number(r.base_rev);
  if (r.base_id != null) u.baseId = r.base_id;
  const resolves = parseJson(r.resolves);
  if (Array.isArray(resolves) && resolves.length) u.resolves = resolves as string[];
  if (r.written_at != null) u.writtenAt = Number(r.written_at);
  const payload = parseJson(r.payload);
  if (payload !== null && payload !== undefined) u.payload = payload;
  return u;
}

/**
 * A Postgres draft log. Takes a transaction-scoped advisory lock per draft, so
 * two requests for one draft get distinct, increasing revisions in commit
 * order, and neither is lost. Needs the default READ COMMITTED level: at
 * REPEATABLE READ or SERIALIZABLE the snapshot is taken before the lock.
 */
export class PostgresDraftLog implements DraftLog<Queryable> {
  private readonly table: string;
  constructor(private readonly options: { db: Queryable; table?: string }) {
    this.table = `"${options.table ?? "holdsend_draft_updates"}"`;
    if (!IDENTIFIER.test(options.table ?? "holdsend_draft_updates")) throw new TypeError(`invalid table name: ${options.table}`);
  }

  async append(tx: Queryable, owner: string, u: NewDraftUpdate & { id: string }): Promise<DraftUpdate> {
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [JSON.stringify([this.table, owner, u.draftId])]);
    const found = await tx.query(`SELECT * FROM ${this.table} WHERE owner = $1 AND draft_id = $2 AND id = $3`, [owner, u.draftId, u.id]);
    if (found.rows.length) return fromRow(found.rows[0] as DraftRow);
    const inserted = await tx.query(
      `INSERT INTO ${this.table} (owner, draft_id, id, rev, base_rev, base_id, reason, resolves, written_at, payload)
       VALUES ($1, $2, $3, (SELECT COALESCE(MAX(rev), 0) + 1 FROM ${this.table} WHERE owner = $1 AND draft_id = $2), $4, $5, $6, $7::jsonb, $8, $9::jsonb)
       RETURNING *`,
      [
        owner,
        u.draftId,
        u.id,
        u.baseRev ?? null,
        u.baseId ?? null,
        u.reason,
        JSON.stringify(u.resolves ?? []),
        u.writtenAt ?? null,
        u.payload === undefined ? null : JSON.stringify(u.payload),
      ],
    );
    return fromRow(inserted.rows[0] as DraftRow);
  }

  async list(owner: string, draftId: string): Promise<DraftUpdate[]> {
    const r = await this.options.db.query(`SELECT * FROM ${this.table} WHERE owner = $1 AND draft_id = $2 ORDER BY rev`, [owner, draftId]);
    return r.rows.map((row) => fromRow(row as DraftRow));
  }
}

export interface AcceptDraftUpdateOptions<Tx> {
  store: IdempotencyStore<Tx>;
  log: DraftLog<Tx>;
  owner: string;
  /** Request headers. The Idempotency-Key is required and becomes the update id. */
  headers: Parameters<typeof handleIdempotent>[0]["headers"];
  update: NewDraftUpdate;
  waitMs?: number;
}

/** What a device gets back (and on a replay, the same answer as the first time). */
export interface DraftAccepted {
  id: string;
  draftId: string;
  rev: number;
}

/**
 * Accepts one update. Always accepted when well formed: a stale base is kept,
 * not refused. The key is required (answered 400 without one), because the key
 * is how a retry avoids adding the edit twice. Read the draft's state with
 * `readDraftState`.
 */
export async function acceptDraftUpdate<Tx>(o: AcceptDraftUpdateOptions<Tx>): Promise<IdempotentAnswer> {
  const bad = checkDraftUpdate(o.update);
  if (bad) return { status: 400, body: { error: "invalid_update", message: bad }, headers: {}, outcome: "not_stored" };
  const update = o.update;
  return handleIdempotent<Tx>({
    store: o.store,
    owner: o.owner,
    operation: "draft.update",
    headers: o.headers,
    content: update,
    requireKey: true,
    ...(o.waitMs !== undefined ? { waitMs: o.waitMs } : {}),
    create: async (tx, { key }) => {
      const stored = await o.log.append(tx, o.owner, { ...update, id: key! });
      const body: DraftAccepted = { id: stored.id, draftId: stored.draftId, rev: stored.rev };
      return { status: 201, body, resourceRef: `${update.draftId}/${stored.id}` };
    },
  });
}

/** The draft's open heads, read from its log. */
export async function readDraftState<T = unknown>(log: Pick<DraftLog<never>, "list">, owner: string, draftId: string): Promise<DraftState<T>> {
  return readDraft<T>((await log.list(owner, draftId)) as DraftUpdate<T>[], draftId);
}
