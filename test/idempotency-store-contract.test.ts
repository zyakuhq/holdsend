import { PGlite } from "@electric-sql/pglite";
import { afterAll, describe, expect, it } from "vitest";
import {
  ClaimLostError,
  MemoryIdempotencyStore,
  PostgresIdempotencyStore,
  onMemoryCommit,
  postgresSchema,
  type ClaimInput,
  type ClaimOutcome,
  type CompleteInput,
  type IdempotencyStore,
  type MemoryTx,
  type Queryable,
  type RecordId,
  type ResourceId,
  type StoredResult,
} from "@holdsend/server";
import { idempotencyContractChecks, type IdempotencyStoreHarness, type StoreClock } from "./idempotency-store-contract.js";

const pglite = new PGlite();
await pglite.exec(postgresSchema("contract_records"));
await pglite.exec("CREATE TABLE contract_rows (id TEXT PRIMARY KEY)");
afterAll(async () => {
  await pglite.close();
});

function memoryHarness(): IdempotencyStoreHarness {
  let rows: string[] = [];
  return {
    async create({ clock, staleClaimMs, completedTtlMs }) {
      rows = [];
      return new MemoryIdempotencyStore({ now: () => clock.now, staleClaimMs, ...(completedTtlMs === undefined ? {} : { completedTtlMs }) }) as IdempotencyStore<unknown>;
    },
    async writeRow(tx, id) {
      onMemoryCommit(tx as MemoryTx, () => rows.push(id));
    },
    async rows() {
      return [...rows].sort();
    },
    concurrentTransactions: true,
  };
}

function postgresHarness(): IdempotencyStoreHarness {
  return {
    async create({ clock, staleClaimMs, completedTtlMs }) {
      await pglite.exec("TRUNCATE contract_records; TRUNCATE contract_rows;");
      return new PostgresIdempotencyStore({
        db: pglite,
        table: "contract_records",
        transaction: (fn) => pglite.transaction((tx) => fn(tx as unknown as Queryable)),
        now: () => clock.now,
        staleClaimMs,
        ...(completedTtlMs === undefined ? {} : { completedTtlMs }),
      }) as IdempotencyStore<unknown>;
    },
    async writeRow(tx, id) {
      await (tx as Queryable).query("INSERT INTO contract_rows (id) VALUES ($1)", [id]);
    },
    async rows() {
      return (await pglite.query<{ id: string }>("SELECT id FROM contract_rows ORDER BY id")).rows.map((r) => r.id);
    },
  };
}

describe.each([
  ["MemoryIdempotencyStore", memoryHarness],
  ["PostgresIdempotencyStore (PGlite)", postgresHarness],
] as const)("IdempotencyStore contract: %s", (_name, make) => {
  it.each(idempotencyContractChecks.map((check) => [check.name, check] as const))("%s", async (_check, check) => {
    await check.run(make());
  });
});

// A small store written for this test, with switches that each break one rule,
// to show the checks catch each way of breaking the contract.

type Flaw =
  | "racy claim"
  | "hands out a second claim while one is in progress"
  | "ignores the owner in keys"
  | "joins key parts with a colon"
  | "treats a claim with no time as time zero"
  | "checks the token only when completion is called"
  | "tombstones every operation's records"
  | "keeps a tombstone's expiry"
  | "purges tombstones"
  | "forgets every owner whose name starts with the one given"
  | "drops headers on replay"
  | "replays any request under a completed key"
  | "lets another request share a claim in progress"
  | "never lets a stale claim be taken over"
  | "completes outside the transaction"
  | "completes without checking the token"
  | "throws a plain Error for a lost claim"
  | "commits when the callback throws"
  | "swallows the callback's error"
  | "releases for any token"
  | "tombstones every owner's records"
  | "tombstones outside the transaction"
  | "keeps the caller's result object"
  | "expires completed records after 30 days by default"
  | "purges fresh claims"
  | "keeps tombstones when forgetting an owner";

interface Rec {
  owner: string;
  operation: string;
  hash: string;
  state: "in_progress" | "completed" | "gone";
  token?: string;
  claimedAt: number;
  result?: StoredResult;
  ref?: string;
  expiresAt?: number;
}

interface Tx {
  changes: (() => void)[];
  checks: (() => void)[];
}

const copy = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
let tokens = 0;

class FlawedStore implements IdempotencyStore<Tx> {
  readonly records = new Map<string, Rec>();
  constructor(
    private readonly flaw: Flaw | undefined,
    private readonly clock: StoreClock,
    private readonly staleMs: number,
    private readonly ttlMs: number | undefined,
  ) {}

  private has(f: Flaw) {
    return this.flaw === f;
  }

  private id(r: RecordId) {
    if (this.has("joins key parts with a colon")) return `${r.owner}:${r.operation}:${r.key}`;
    return JSON.stringify([this.has("ignores the owner in keys") ? "" : r.owner, r.operation, r.key]);
  }

  async claim(input: ClaimInput): Promise<ClaimOutcome> {
    const now = input.now ?? (this.has("treats a claim with no time as time zero") ? 0 : this.clock.now);
    const k = this.id(input);
    let r = this.records.get(k);
    if (this.has("racy claim")) await tick();
    if (r?.expiresAt !== undefined && r.expiresAt <= now) {
      this.records.delete(k);
      r = undefined;
    }
    if (!r) {
      const token = `t${(tokens += 1)}`;
      this.records.set(k, { owner: input.owner, operation: input.operation, hash: input.requestHash, state: "in_progress", token, claimedAt: now });
      return { type: "claimed", token };
    }
    if (r.state === "gone") return { type: "gone" };
    if (r.state === "completed") {
      if (r.hash !== input.requestHash && !this.has("replays any request under a completed key")) return { type: "conflict" };
      const result = this.has("keeps the caller's result object") ? r.result! : copy(r.result!);
      if (this.has("drops headers on replay")) delete result.headers;
      return { type: "replay", result };
    }
    if (r.hash !== input.requestHash && !this.has("lets another request share a claim in progress")) return { type: "conflict" };
    const stale = now - r.claimedAt > this.staleMs && !this.has("never lets a stale claim be taken over");
    if (stale || this.has("hands out a second claim while one is in progress")) {
      r.token = `t${(tokens += 1)}`;
      r.claimedAt = now;
      return { type: "claimed", token: r.token };
    }
    return { type: "in_progress" };
  }

  async transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    const tx: Tx = { changes: [], checks: [] };
    let value: T;
    try {
      value = await fn(tx);
    } catch (err) {
      if (this.has("commits when the callback throws")) for (const c of tx.changes) c();
      if (this.has("swallows the callback's error")) return undefined as T;
      throw err;
    }
    for (const c of tx.checks) c();
    for (const c of tx.changes) c();
    return value;
  }

  async completeInTransaction(tx: Tx, input: CompleteInput): Promise<void> {
    const k = this.id(input);
    const check = () => {
      const r = this.records.get(k);
      if (this.has("completes without checking the token")) return;
      if (!r || r.state !== "in_progress" || r.token !== input.token) {
        throw this.has("throws a plain Error for a lost claim") ? new Error("claim lost") : new ClaimLostError();
      }
    };
    check();
    const result = this.has("keeps the caller's result object") ? input.result : copy(input.result);
    const apply = () => {
      const r = this.records.get(k);
      if (!r) return;
      r.state = "completed";
      r.result = result;
      delete r.token;
      if (input.resourceRef !== undefined) r.ref = input.resourceRef;
      const ttl = this.ttlMs ?? (this.has("expires completed records after 30 days by default") ? 30 * 24 * 3_600_000 : undefined);
      if (ttl !== undefined) r.expiresAt = this.clock.now + ttl;
    };
    if (this.has("completes outside the transaction")) apply();
    else {
      if (!this.has("checks the token only when completion is called")) tx.checks.push(check);
      tx.changes.push(apply);
    }
  }

  async release(rid: RecordId, token: string): Promise<void> {
    const k = this.id(rid);
    const r = this.records.get(k);
    if (r && r.state === "in_progress" && (r.token === token || this.has("releases for any token"))) this.records.delete(k);
  }

  async tombstoneResource(tx: Tx, { owner, operation, resourceRef }: ResourceId): Promise<number> {
    const matches = () =>
      [...this.records.values()].filter(
        (r) =>
          (r.owner === owner || this.has("tombstones every owner's records")) &&
          (r.operation === operation || this.has("tombstones every operation's records")) &&
          r.ref === resourceRef &&
          r.state === "completed",
      );
    const count = matches().length;
    const apply = () => {
      for (const r of matches()) {
        r.state = "gone";
        r.hash = "";
        delete r.result;
        if (!this.has("keeps a tombstone's expiry")) delete r.expiresAt;
      }
    };
    if (this.has("tombstones outside the transaction")) apply();
    else tx.changes.push(apply);
    return count;
  }

  async purgeExpired(now: number = this.clock.now): Promise<number> {
    let n = 0;
    for (const [k, r] of this.records) {
      const old = now - r.claimedAt > this.staleMs;
      const stale = (r.state === "in_progress" && (old || this.has("purges fresh claims"))) || (r.state === "gone" && old && this.has("purges tombstones"));
      if (stale || (r.expiresAt !== undefined && r.expiresAt <= now)) {
        this.records.delete(k);
        n += 1;
      }
    }
    return n;
  }

  async forgetOwner(owner: string): Promise<number> {
    let n = 0;
    for (const [k, r] of this.records) {
      if (r.owner !== owner && !(this.has("forgets every owner whose name starts with the one given") && r.owner.startsWith(owner))) continue;
      if (r.state === "gone" && this.has("keeps tombstones when forgetting an owner")) continue;
      this.records.delete(k);
      n += 1;
    }
    return n;
  }
}

function flawedHarness(flaw: Flaw | undefined): IdempotencyStoreHarness {
  let rows: string[] = [];
  return {
    async create({ clock, staleClaimMs, completedTtlMs }) {
      rows = [];
      return new FlawedStore(flaw, clock, staleClaimMs, completedTtlMs) as IdempotencyStore<unknown>;
    },
    async writeRow(tx, id) {
      (tx as Tx).changes.push(() => rows.push(id));
    },
    async rows() {
      return [...rows].sort();
    },
    concurrentTransactions: true,
  };
}

const STALE_CHECK = "a stale claim can be taken over, and the old holder can no longer complete";
const TOKEN_CHECK = "only the claim's own token can complete it, and only once";
const ATOMIC_CHECK = "a completion and the app's row commit together or not at all";
const GONE_CHECK = "a deleted resource's key answers gone, and only that owner's";
const SCOPE_CHECK = "keys are scoped by owner and operation";
const PURGE_CHECK = "purging removes stale unfinished claims and nothing else";

/** For each flaw: the check that must fail, and words from the failure it must fail with. */
const caughtBy: Record<Flaw, [check: string, failure: string]> = {
  "racy claim": ["exactly one of many concurrent claims wins", "claims won by 25 concurrent requests"],
  "hands out a second claim while one is in progress": ["a claim in progress is reported as in progress", "the same request while the first is in progress"],
  "ignores the owner in keys": [SCOPE_CHECK, "the same key from another owner"],
  "joins key parts with a colon": [SCOPE_CHECK, "whose parts joined would match another's"],
  "drops headers on replay": ["a completed request is replayed with its result unchanged", "a repeat of the completed request"],
  "replays any request under a completed key": ["a different request under a used key is a conflict", "another request under a completed key"],
  "lets another request share a claim in progress": ["a different request under a used key is a conflict", "another request under a key in progress"],
  "never lets a stale claim be taken over": [STALE_CHECK, "the store's clock says the claim is stale"],
  "treats a claim with no time as time zero": [STALE_CHECK, "a claim with no time"],
  "checks the token only when completion is called": ["a completion re-checks its claim when it commits", "did not throw ClaimLostError"],
  "completes outside the transaction": [ATOMIC_CHECK, "the key after a rolled-back completion"],
  "completes without checking the token": [TOKEN_CHECK, "with a token the store never gave"],
  "throws a plain Error for a lost claim": [TOKEN_CHECK, "not ClaimLostError"],
  "commits when the callback throws": [ATOMIC_CHECK, "app rows after the transaction rolled back"],
  "swallows the callback's error": [ATOMIC_CHECK, "resolved although its callback threw"],
  "releases for any token": ["a release frees the key, but only by the token that holds it", "a release by a token that lost the claim"],
  "tombstones every owner's records": [GONE_CHECK, "records tombstoned for one resource"],
  "tombstones every operation's records": [GONE_CHECK, "records tombstoned for one resource"],
  "tombstones outside the transaction": [GONE_CHECK, "a tombstone that rolled back"],
  "keeps a tombstone's expiry": [GONE_CHECK, "with a 7-day lifetime for completed records"],
  "keeps the caller's result object": ["the store keeps its own copy of a result", "the caller changed the objects"],
  "expires completed records after 30 days by default": ["completed records are kept forever unless a lifetime is set", "with no lifetime set"],
  "purges fresh claims": [PURGE_CHECK, "while the claim is fresh"],
  "purges tombstones": [PURGE_CHECK, "records purged once the claim is stale"],
  "keeps tombstones when forgetting an owner": ["forgetting an owner removes all of their records and nobody else's", "records removed for one owner"],
  "forgets every owner whose name starts with the one given": [
    "forgetting an owner removes all of their records and nobody else's",
    "records removed for one owner",
  ],
};

describe("IdempotencyStore contract checks catch broken stores", () => {
  it.each(Object.entries(caughtBy))("%s", async (flaw, [name, failure]) => {
    const check = idempotencyContractChecks.find((c) => c.name === name);
    expect(check, name).toBeDefined();
    const error = await check!.run(flawedHarness(flaw as Flaw)).then(
      () => undefined,
      (err: unknown) => err,
    );
    expect(String(error)).toContain("idempotency store contract");
    expect(String(error)).toContain(failure);
  });

  it("the same store without a flaw passes every check", async () => {
    for (const check of idempotencyContractChecks) await check.run(flawedHarness(undefined));
  });

  it("every check catches at least one broken store", () => {
    const shown = new Set(Object.values(caughtBy).map(([check]) => check));
    expect(idempotencyContractChecks.map((c) => c.name).filter((n) => !shown.has(n))).toEqual([]);
  });
});
