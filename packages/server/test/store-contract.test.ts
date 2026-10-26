/**
 * One contract, two stores. Every rule here must hold for the in-memory
 * store and for Postgres (a real Postgres engine, via PGlite).
 */
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  ClaimLostError,
  MemoryIdempotencyStore,
  PostgresIdempotencyStore,
  postgresSchema,
  type IdempotencyStore,
  type Queryable,
} from "../src/index.js";

const T0 = Date.parse("2026-10-25T12:00:00.000Z");
const MIN = 60 * 1000;

interface Harness {
  store: IdempotencyStore<unknown>;
  /** Runs a resource insert in the same transaction as completion, to prove atomicity. */
  insertResource?: (tx: unknown, id: string) => Promise<void>;
  countResources?: () => Promise<number>;
}

const pglite = new PGlite();
await pglite.exec(postgresSchema());
await pglite.exec("CREATE TABLE notes (id TEXT PRIMARY KEY)");
afterAll(async () => {
  await pglite.close();
});

const factories: [string, (opts?: { completedTtlMs?: number }) => Promise<Harness>][] = [
  ["memory", async (opts = {}) => ({ store: new MemoryIdempotencyStore({ now: () => T0, ...opts }) as IdempotencyStore<unknown> })],
  [
    "postgres",
    async (opts = {}) => {
      await pglite.exec("TRUNCATE holdsend_idempotency; TRUNCATE notes;");
      const store = new PostgresIdempotencyStore({
        db: pglite,
        transaction: (fn) => pglite.transaction((tx) => fn(tx as unknown as Queryable)),
        now: () => T0,
        ...opts,
      });
      return {
        store: store as IdempotencyStore<unknown>,
        insertResource: async (tx, id) => {
          await (tx as Queryable).query("INSERT INTO notes (id) VALUES ($1)", [id]);
        },
        countResources: async () => {
          const r = await pglite.query<{ n: number }>("SELECT count(*)::int AS n FROM notes");
          return r.rows[0]?.n ?? 0;
        },
      };
    },
  ],
];

const rec = { owner: "person-a", operation: "post.create", key: "key-00000001" };

for (const [name, make] of factories) {
  describe(`${name} store`, () => {
    let h: Harness;
    beforeEach(async () => {
      h = await make();
    });

    async function createAndComplete(token: string, body: unknown = { id: "n1" }, resourceRef?: string) {
      await h.store.transaction(async (tx) => {
        await h.insertResource?.(tx, String((body as { id?: string }).id ?? "n1"));
        await h.store.completeInTransaction(tx, { ...rec, token, result: { status: 201, body }, ...(resourceRef ? { resourceRef } : {}) });
      });
    }

    it("claims a new key, then replays the original result for the same request", async () => {
      const first = await h.store.claim({ ...rec, requestHash: "h1", now: T0 });
      expect(first.type).toBe("claimed");
      if (first.type !== "claimed") return;
      await createAndComplete(first.token, { id: "n1", text: "synthetic" });
      const again = await h.store.claim({ ...rec, requestHash: "h1", now: T0 + 1000 });
      expect(again).toEqual({ type: "replay", result: { status: 201, body: { id: "n1", text: "synthetic" } } });
    });

    it("refuses a different request under a completed key", async () => {
      const first = await h.store.claim({ ...rec, requestHash: "h1", now: T0 });
      if (first.type !== "claimed") throw new Error("expected claim");
      await createAndComplete(first.token);
      expect((await h.store.claim({ ...rec, requestHash: "h2", now: T0 })).type).toBe("conflict");
    });

    it("scopes keys by owner and operation", async () => {
      const a = await h.store.claim({ ...rec, requestHash: "h1", now: T0 });
      const b = await h.store.claim({ ...rec, owner: "person-b", requestHash: "h1", now: T0 });
      const c = await h.store.claim({ ...rec, operation: "article.create", requestHash: "h1", now: T0 });
      expect([a.type, b.type, c.type]).toEqual(["claimed", "claimed", "claimed"]);
    });

    it("lets exactly one of many concurrent requests claim a key", async () => {
      const results = await Promise.all(Array.from({ length: 25 }, () => h.store.claim({ ...rec, requestHash: "h1", now: T0 })));
      expect(results.filter((r) => r.type === "claimed")).toHaveLength(1);
      expect(results.filter((r) => r.type === "in_progress")).toHaveLength(24);
    });

    it("reports a fresh claim as in progress, or a conflict for a different body", async () => {
      await h.store.claim({ ...rec, requestHash: "h1", now: T0 });
      expect((await h.store.claim({ ...rec, requestHash: "h1", now: T0 + MIN })).type).toBe("in_progress");
      expect((await h.store.claim({ ...rec, requestHash: "h2", now: T0 + MIN })).type).toBe("conflict");
    });

    it("lets a request take over a stale claim, and the old owner's commit then fails and rolls back", async () => {
      const old = await h.store.claim({ ...rec, requestHash: "h1", now: T0 });
      if (old.type !== "claimed") throw new Error("expected claim");
      const taken = await h.store.claim({ ...rec, requestHash: "h1", now: T0 + 6 * MIN });
      expect(taken.type).toBe("claimed");

      await expect(createAndComplete(old.token, { id: "from-old" })).rejects.toBeInstanceOf(ClaimLostError);
      if (h.countResources) expect(await h.countResources()).toBe(0);

      if (taken.type !== "claimed") return;
      await createAndComplete(taken.token, { id: "from-new" });
      if (h.countResources) expect(await h.countResources()).toBe(1);
      const replay = await h.store.claim({ ...rec, requestHash: "h1", now: T0 + 7 * MIN });
      expect(replay).toEqual({ type: "replay", result: { status: 201, body: { id: "from-new" } } });
    });

    it("rolls the record back with the resource when the transaction fails", async () => {
      const c = await h.store.claim({ ...rec, requestHash: "h1", now: T0 });
      if (c.type !== "claimed") throw new Error("expected claim");
      await expect(
        h.store.transaction(async (tx) => {
          await h.insertResource?.(tx, "n1");
          await h.store.completeInTransaction(tx, { ...rec, token: c.token, result: { status: 201, body: {} } });
          throw new Error("something after completion failed");
        }),
      ).rejects.toThrow("something after completion failed");
      if (h.countResources) expect(await h.countResources()).toBe(0);
      // Still the same claim, still in progress: not completed.
      expect((await h.store.claim({ ...rec, requestHash: "h1", now: T0 })).type).toBe("in_progress");
    });

    it("frees a key when the claim is released", async () => {
      const c = await h.store.claim({ ...rec, requestHash: "h1", now: T0 });
      if (c.type !== "claimed") throw new Error("expected claim");
      await h.store.release(rec, c.token);
      expect((await h.store.claim({ ...rec, requestHash: "h1", now: T0 })).type).toBe("claimed");
    });

    it("ignores a release by a token that no longer holds the claim", async () => {
      const old = await h.store.claim({ ...rec, requestHash: "h1", now: T0 });
      if (old.type !== "claimed") throw new Error("expected claim");
      const taken = await h.store.claim({ ...rec, requestHash: "h1", now: T0 + 6 * MIN });
      await h.store.release(rec, old.token);
      expect(taken.type).toBe("claimed");
      expect((await h.store.claim({ ...rec, requestHash: "h1", now: T0 + 6 * MIN })).type).toBe("in_progress");
    });

    it("answers 'gone' for a key whose resource was deleted, and keeps nothing it was given", async () => {
      const c = await h.store.claim({ ...rec, requestHash: "h1", now: T0 });
      if (c.type !== "claimed") throw new Error("expected claim");
      await createAndComplete(c.token, { id: "n1", text: "private words" }, "n1");
      const tombstoned = await h.store.transaction((tx) => h.store.tombstoneResource(tx, { owner: rec.owner, operation: rec.operation, resourceRef: "n1" }));
      expect(tombstoned).toBe(1);
      expect((await h.store.claim({ ...rec, requestHash: "h1", now: T0 })).type).toBe("gone");
      expect((await h.store.claim({ ...rec, requestHash: "anything", now: T0 })).type).toBe("gone");
      if (name === "postgres") {
        const r = await pglite.query<{ request_hash: string; result_body: unknown }>("SELECT request_hash, result_body FROM holdsend_idempotency");
        expect(r.rows[0]).toEqual({ request_hash: "", result_body: null });
      }
    });

    it("keeps completed records forever by default", async () => {
      const c = await h.store.claim({ ...rec, requestHash: "h1", now: T0 });
      if (c.type !== "claimed") throw new Error("expected claim");
      await createAndComplete(c.token);
      expect(await h.store.purgeExpired(T0 + 400 * 24 * 60 * MIN)).toBe(0);
      expect((await h.store.claim({ ...rec, requestHash: "h1", now: T0 + 400 * 24 * 60 * MIN })).type).toBe("replay");
    });

    it("expires completed records only when a TTL is configured", async () => {
      h = await make({ completedTtlMs: 7 * 24 * 60 * MIN });
      const c = await h.store.claim({ ...rec, requestHash: "h1", now: T0 });
      if (c.type !== "claimed") throw new Error("expected claim");
      await createAndComplete(c.token);
      expect(await h.store.purgeExpired(T0 + 8 * 24 * 60 * MIN)).toBe(1);
    });

    it("purges stale unfinished claims", async () => {
      await h.store.claim({ ...rec, requestHash: "h1", now: T0 });
      expect(await h.store.purgeExpired(T0 + 6 * MIN)).toBe(1);
    });
  });
}

describe("postgresSchema", () => {
  it("is safe to run twice", async () => {
    await pglite.exec(postgresSchema());
    await pglite.exec(postgresSchema());
  });

  it("rejects table names that are not plain identifiers", () => {
    expect(() => postgresSchema('x"; DROP TABLE users; --')).toThrow(TypeError);
    expect(() => postgresSchema("app.holdsend_keys")).not.toThrow();
  });
});
