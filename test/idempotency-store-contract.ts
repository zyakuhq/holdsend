/**
 * The server `IdempotencyStore` contract from packages/server/src/types.ts, as
 * checks any store can be run through. Each check throws when the store breaks
 * the contract. `test/idempotency-store-contract.test.ts` runs them against
 * `MemoryIdempotencyStore` and `PostgresIdempotencyStore`, and against
 * deliberately broken stores to show each check can fail.
 *
 * To test your own store (Redis, MySQL, DynamoDB...), copy this file and give
 * it a harness: a way to make a new, empty store, and a way to write one row
 * of your app's data inside the store's transaction, so the checks can see
 * that the row and the idempotency record commit or roll back together.
 */
import { isDeepStrictEqual } from "node:util";
import { ClaimLostError, type IdempotencyStore, type StoredResult } from "@holdsend/server";

export interface StoreClock {
  now: number;
}

export interface IdempotencyStoreHarness<Tx = unknown> {
  /**
   * A new store with no records. Its own clock must read `clock.now`. A claim
   * older than `staleClaimMs` may be taken over; completed records live
   * `completedTtlMs` when it is given, and forever otherwise.
   */
  create(options: { clock: StoreClock; staleClaimMs: number; completedTtlMs?: number }): Promise<IdempotencyStore<Tx>>;
  /** Writes one row of app data with this id inside `tx`, the way the app's create would. */
  writeRow(tx: Tx, id: string): Promise<void>;
  /** The ids of the app rows that committed. */
  rows(): Promise<string[]>;
}

export interface IdempotencyContractCheck {
  name: string;
  run(harness: IdempotencyStoreHarness): Promise<void>;
}

const T0 = Date.parse("2026-11-26T12:00:00.000Z");
const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const STALE = 5 * MIN;

const rec = { owner: "person-a", operation: "post.create", key: "key-00000001" };

function fail(message: string): never {
  throw new Error(`idempotency store contract: ${message}`);
}

function same(actual: unknown, expected: unknown, what: string): void {
  // Compared as plain JSON values, so the order of fields in an object does not matter.
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (!isDeepStrictEqual(a === undefined ? a : JSON.parse(a), e === undefined ? e : JSON.parse(e))) fail(`${what}\n  expected ${e}\n  got      ${a}`);
}

async function setup(harness: IdempotencyStoreHarness, completedTtlMs?: number) {
  const clock: StoreClock = { now: T0 };
  const store = await harness.create({ clock, staleClaimMs: STALE, ...(completedTtlMs === undefined ? {} : { completedTtlMs }) });
  async function claim(requestHash: string, at = clock.now, id = rec) {
    clock.now = at;
    return store.claim({ ...id, requestHash, now: at });
  }
  async function claimed(requestHash: string, at = clock.now, id = rec): Promise<string> {
    const outcome = await claim(requestHash, at, id);
    if (outcome.type !== "claimed") fail(`a claim that should win (${id.owner}, ${id.operation}, ${id.key}) was answered ${JSON.stringify(outcome)}`);
    return outcome.token;
  }
  /** Writes the app row and completes the record in one transaction, as handleIdempotent does. */
  async function complete(token: string, row: string, result: StoredResult = { status: 201, body: { id: row } }, id = rec, resourceRef?: string) {
    await store.transaction(async (tx) => {
      await harness.writeRow(tx, row);
      await store.completeInTransaction(tx, { ...id, token, result, ...(resourceRef === undefined ? {} : { resourceRef }) });
    });
  }
  async function outcome(requestHash: string, at = clock.now, id = rec): Promise<string> {
    return (await claim(requestHash, at, id)).type;
  }
  return { clock, store, claim, claimed, complete, outcome };
}

async function expectClaimLost(work: Promise<unknown>, what: string): Promise<void> {
  try {
    await work;
  } catch (err) {
    // handleIdempotent recognises a lost claim with instanceof, so a store must throw this class.
    if (err instanceof ClaimLostError) return;
    fail(`${what} threw ${String(err)}, not ClaimLostError`);
  }
  fail(`${what} did not throw ClaimLostError`);
}

export const idempotencyContractChecks: IdempotencyContractCheck[] = [
  {
    name: "a completed request is replayed with its result unchanged",
    async run(harness) {
      const s = await setup(harness);
      const result: StoredResult = {
        status: 201,
        body: { id: "n1", text: "Ünïcode, \"quotes\", <b>tags</b>, emoji 🛰️ and a\nnewline", list: [null, true, 0, "", { deep: [0.1] }] },
        headers: { Location: "/notes/n1", "X-Synthetic": "yes" },
      };
      await s.complete(await s.claimed("h1"), "n1", result);
      same(await s.claim("h1", T0 + 1000), { type: "replay", result }, "a repeat of the completed request");
      const bodyOnly = await setup(harness);
      await bodyOnly.complete(await bodyOnly.claimed("h1"), "n2", { status: 200, body: null });
      same(await bodyOnly.claim("h1"), { type: "replay", result: { status: 200, body: null } }, "a repeat of a request whose body was null");
    },
  },
  {
    name: "a different request under a used key is a conflict",
    async run(harness) {
      const s = await setup(harness);
      await s.complete(await s.claimed("h1"), "n1");
      same(await s.outcome("h2"), "conflict", "another request under a completed key");
      const p = await setup(harness);
      await p.claimed("h1");
      same(await p.outcome("h2", T0 + MIN), "conflict", "another request under a key in progress");
      same(await p.outcome("h2", T0 + STALE + MIN), "conflict", "another request under a stale claim (the first may still be retried)");
    },
  },
  {
    name: "a claim in progress is reported as in progress",
    async run(harness) {
      const s = await setup(harness);
      await s.claimed("h1");
      same(await s.outcome("h1", T0 + MIN), "in_progress", "the same request while the first is in progress");
    },
  },
  {
    name: "keys are scoped by owner and operation",
    async run(harness) {
      const s = await setup(harness);
      await s.complete(await s.claimed("h1"), "n1");
      same(await s.outcome("h1", T0, { ...rec, owner: "person-b" }), "claimed", "the same key from another owner");
      same(await s.outcome("h1", T0, { ...rec, operation: "article.create" }), "claimed", "the same key for another operation");
      same(await s.outcome("h1", T0, { ...rec, key: "key-00000002" }), "claimed", "another key");
      same(await s.outcome("h1"), "replay", "the first key after the others");
    },
  },
  {
    name: "exactly one of many concurrent claims wins",
    async run(harness) {
      const s = await setup(harness);
      const results = await Promise.all(Array.from({ length: 25 }, () => s.store.claim({ ...rec, requestHash: "h1", now: T0 })));
      const types = results.map((r) => r.type);
      same(types.filter((t) => t === "claimed").length, 1, "claims won by 25 concurrent requests");
      same(types.filter((t) => t === "in_progress").length, 24, "concurrent requests told the key is in progress");
    },
  },
  {
    name: "a completion and the app's row commit together or not at all",
    async run(harness) {
      const s = await setup(harness);
      const token = await s.claimed("h1");
      let threw = false;
      try {
        await s.store.transaction(async (tx) => {
          await harness.writeRow(tx, "n1");
          await s.store.completeInTransaction(tx, { ...rec, token, result: { status: 201, body: { id: "n1" } } });
          throw new Error("synthetic failure after completion");
        });
      } catch {
        threw = true;
      }
      if (!threw) fail("transaction() resolved although its callback threw");
      same(await harness.rows(), [], "app rows after the transaction rolled back");
      same(await s.outcome("h1"), "in_progress", "the key after a rolled-back completion");
      await s.complete(token, "n1");
      same(await harness.rows(), ["n1"], "app rows after the same claim completed");
    },
  },
  {
    name: "a stale claim can be taken over, and the old holder can no longer complete",
    async run(harness) {
      const s = await setup(harness);
      const old = await s.claimed("h1");
      same(await s.outcome("h1", T0 + STALE - MIN), "in_progress", "the same request before the claim is stale");
      const taken = await s.claimed("h1", T0 + STALE + MIN);
      await expectClaimLost(s.complete(old, "from-old"), "completing with a claim that was taken over");
      same(await harness.rows(), [], "app rows after the old holder's completion failed");
      await s.complete(taken, "from-new");
      same(await harness.rows(), ["from-new"], "app rows after the new holder completed");
      same(await s.claim("h1"), { type: "replay", result: { status: 201, body: { id: "from-new" } } }, "the replay after a takeover");
    },
  },
  {
    name: "only the claim's own token can complete it, and only once",
    async run(harness) {
      const s = await setup(harness);
      const token = await s.claimed("h1");
      await expectClaimLost(s.complete("not-the-token", "wrong"), "completing with a token the store never gave");
      await expectClaimLost(s.complete(token, "elsewhere", undefined, { ...rec, key: "key-unclaimed" }), "completing a key that was never claimed");
      await s.complete(token, "n1");
      await expectClaimLost(s.complete(token, "twice"), "completing the same claim a second time");
      same(await harness.rows(), ["n1"], "app rows after the failed completions");
    },
  },
  {
    name: "a release frees the key, but only by the token that holds it",
    async run(harness) {
      const s = await setup(harness);
      const token = await s.claimed("h1");
      await s.store.release(rec, token);
      await s.claimed("h1");
      const r = await setup(harness);
      const old = await r.claimed("h1");
      const taken = await r.claimed("h1", T0 + STALE + MIN);
      await r.store.release(rec, old);
      same(await r.outcome("h1"), "in_progress", "the key after a release by a token that lost the claim");
      await r.complete(taken, "n1");
      await r.store.release(rec, taken);
      same(await r.outcome("h1"), "replay", "the key after a release of a completed record");
    },
  },
  {
    name: "a deleted resource's key answers gone, and only that owner's",
    async run(harness) {
      const s = await setup(harness);
      await s.complete(await s.claimed("h1"), "n1", undefined, rec, "n1");
      const other = { ...rec, owner: "person-b" };
      await s.complete(await s.claimed("h1", T0, other), "n1-b", undefined, other, "n1");
      let rolledBack = false;
      try {
        await s.store.transaction(async (tx) => {
          await s.store.tombstoneResource(tx, { owner: rec.owner, operation: rec.operation, resourceRef: "n1" });
          throw new Error("synthetic failure in the delete");
        });
      } catch {
        rolledBack = true;
      }
      if (!rolledBack) fail("transaction() resolved although its callback threw");
      same(await s.outcome("h1"), "replay", "the key after a tombstone that rolled back");
      const count = await s.store.transaction((tx) => s.store.tombstoneResource(tx, { owner: rec.owner, operation: rec.operation, resourceRef: "n1" }));
      same(count, 1, "records tombstoned for one resource");
      same(await s.outcome("h1"), "gone", "a retry of the request that created the deleted resource");
      same(await s.outcome("anything-else"), "gone", "another request under the same key");
      same(await s.outcome("h1", T0 + 400 * DAY), "gone", "the key long after");
      same(await s.outcome("h1", T0, other), "replay", "another owner's record for the same resource id");
    },
  },
  {
    name: "the store keeps its own copy of a result",
    async run(harness) {
      const s = await setup(harness);
      const result = { status: 201, body: { id: "n1", list: [1, 2] }, headers: { Location: "/notes/n1" } };
      await s.complete(await s.claimed("h1"), "n1", result);
      result.body.list.push(3);
      result.headers.Location = "/changed";
      const first = await s.claim("h1");
      if (first.type !== "replay") fail(`a repeat of a completed request was answered ${first.type}`);
      (first.result.body as { list: number[] }).list.push(4);
      same(await s.claim("h1"), { type: "replay", result: { status: 201, body: { id: "n1", list: [1, 2] }, headers: { Location: "/notes/n1" } } }, "the replay after the caller changed the objects it gave and got");
    },
  },
  {
    name: "completed records are kept forever unless a lifetime is set",
    async run(harness) {
      const s = await setup(harness);
      await s.complete(await s.claimed("h1"), "n1");
      same(await s.store.purgeExpired(T0 + 400 * DAY), 0, "records purged 400 days later with no lifetime set");
      same(await s.outcome("h1", T0 + 400 * DAY), "replay", "the key 400 days later");
      const t = await setup(harness, 7 * DAY);
      await t.complete(await t.claimed("h1"), "n1");
      same(await t.store.purgeExpired(T0 + 6 * DAY), 0, "records purged before their lifetime ends");
      same(await t.outcome("h1", T0 + 6 * DAY), "replay", "the key before its lifetime ends");
      same(await t.store.purgeExpired(T0 + 8 * DAY), 1, "records purged after their lifetime ends");
      const u = await setup(harness, 7 * DAY);
      await u.complete(await u.claimed("h1"), "n1");
      same(await u.outcome("h1", T0 + 8 * DAY), "claimed", "the key after its lifetime ended, without a purge");
    },
  },
  {
    name: "purging removes stale unfinished claims and nothing else",
    async run(harness) {
      const s = await setup(harness);
      await s.claimed("h1");
      await s.complete(await s.claimed("h1", T0, { ...rec, key: "key-done" }), "done", undefined, { ...rec, key: "key-done" });
      same(await s.store.purgeExpired(T0 + MIN), 0, "records purged while the claim is fresh");
      same(await s.store.purgeExpired(T0 + STALE + MIN), 1, "records purged once the claim is stale");
      same(await s.outcome("h1", T0 + STALE + MIN), "claimed", "the key after its stale claim was purged");
      same(await s.outcome("h1", T0 + STALE + MIN, { ...rec, key: "key-done" }), "replay", "a completed key after the purge");
    },
  },
  {
    name: "forgetting an owner removes all of their records and nobody else's",
    async run(harness) {
      const s = await setup(harness);
      const b = { ...rec, owner: "person-b" };
      await s.complete(await s.claimed("h1"), "a1", undefined, rec, "a1");
      await s.claimed("h2", T0, { ...rec, key: "key-open" });
      await s.complete(await s.claimed("h3", T0, { ...rec, key: "key-deleted" }), "a2", undefined, { ...rec, key: "key-deleted" }, "a2");
      await s.store.transaction((tx) => s.store.tombstoneResource(tx, { owner: rec.owner, operation: rec.operation, resourceRef: "a2" }));
      await s.complete(await s.claimed("h1", T0, b), "b1", undefined, b, "b1");
      same(await s.store.forgetOwner(rec.owner), 3, "records removed for one owner (completed, in progress, tombstone)");
      same(await s.outcome("h1"), "claimed", "a forgotten owner's completed key");
      same(await s.outcome("h3", T0, { ...rec, key: "key-deleted" }), "claimed", "a forgotten owner's tombstoned key");
      same(await s.outcome("h1", T0, b), "replay", "another owner's key");
      same(await s.store.forgetOwner("nobody"), 0, "records removed for an owner with none");
    },
  },
];
