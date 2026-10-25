/**
 * Regression tests for the server findings of the first independent audit
 * (2026-10-25). Each failed on the code before its fix.
 */
import { PGlite } from "@electric-sql/pglite";
import { afterAll, describe, expect, it } from "vitest";
import {
  MemoryIdempotencyStore,
  PostgresIdempotencyStore,
  handleIdempotent,
  postgresSchema,
  type IdempotencyStore,
  type Queryable,
} from "../src/index.js";

const T0 = Date.parse("2026-10-25T12:00:00.000Z");
const MIN = 60 * 1000;
const rec = { owner: "person-a", operation: "post.create", key: "key-00000001" };

const db = new PGlite();
afterAll(async () => {
  await db.close();
});

/** A driver wrapper that reports rows only: no rowCount, no affectedRows. */
const rowsOnly: Queryable = {
  query: async (text, params) => ({ rows: (await db.query(text, params)).rows }),
};

async function postgres(table = "holdsend_idempotency", conn: Queryable = db): Promise<IdempotencyStore<unknown>> {
  await db.exec(postgresSchema(table));
  await db.exec(`TRUNCATE ${table}`);
  return new PostgresIdempotencyStore({
    db: conn,
    table,
    transaction: (fn) => db.transaction((tx) => fn(conn === db ? (tx as unknown as Queryable) : { query: async (q, p) => ({ rows: (await tx.query(q, p)).rows }) })),
  }) as IdempotencyStore<unknown>;
}

describe("audit 9: drivers that report no row count", () => {
  it("still claim, complete and replay", async () => {
    const store = await postgres("holdsend_rows_only", rowsOnly);
    const c = await store.claim({ ...rec, requestHash: "h1", now: T0 });
    expect(c.type).toBe("claimed");
    if (c.type !== "claimed") return;
    await store.transaction((tx) => store.completeInTransaction(tx, { ...rec, token: c.token, result: { status: 201, body: { id: "p1" } } }));
    expect(await store.claim({ ...rec, requestHash: "h1", now: T0 })).toEqual({ type: "replay", result: { status: 201, body: { id: "p1" } } });
  });
});

for (const [name, make] of [
  ["memory", async () => new MemoryIdempotencyStore({ now: () => T0 }) as IdempotencyStore<unknown>],
  ["postgres", () => postgres()],
] as const) {
  describe(`${name}: audit 17 and 10`, () => {
    it("answers conflict when different content tries to take over a stale claim", async () => {
      const store = await make();
      await store.claim({ ...rec, requestHash: "original", now: T0 });
      expect((await store.claim({ ...rec, requestHash: "different", now: T0 + 10 * MIN })).type).toBe("conflict");
      expect((await store.claim({ ...rec, requestHash: "original", now: T0 + 10 * MIN })).type).toBe("claimed");
    });

    it("forgets every record of one owner, and only that owner", async () => {
      const store = await make();
      await store.claim({ ...rec, requestHash: "h", now: T0 });
      await store.claim({ ...rec, key: "key-00000002", requestHash: "h", now: T0 });
      await store.claim({ ...rec, owner: "person-b", requestHash: "h", now: T0 });
      expect(await store.forgetOwner("person-a")).toBe(2);
      expect((await store.claim({ ...rec, requestHash: "h", now: T0 })).type).toBe("claimed");
      expect((await store.claim({ ...rec, owner: "person-b", requestHash: "h", now: T0 })).type).toBe("in_progress");
    });
  });
}

describe("audit 19: long table names", () => {
  it("get distinct index names", async () => {
    const long = `t${"x".repeat(61)}`;
    await db.exec(postgresSchema(long));
    const r = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM pg_indexes WHERE tablename = $1`, [long]);
    expect(r.rows[0]?.n).toBe(4); // primary key + three indexes
  });
});

describe("audit 18: waiting for an in-progress duplicate", () => {
  it("backs off instead of polling every 50 ms", async () => {
    let claims = 0;
    const inner = new MemoryIdempotencyStore();
    const counting = Object.assign(Object.create(inner) as MemoryIdempotencyStore, {
      claim: (input: Parameters<MemoryIdempotencyStore["claim"]>[0]) => {
        claims += 1;
        return inner.claim(input);
      },
    });
    await inner.claim({ ...rec, requestHash: await (await import("../src/index.js")).hashRequest("post.create", { a: 1 }) });
    const started = Date.now();
    const answer = await handleIdempotent({
      store: counting,
      owner: rec.owner,
      operation: rec.operation,
      headers: { "Idempotency-Key": rec.key },
      content: { a: 1 },
      create: async () => ({ status: 201, body: {} }),
      waitMs: 2000,
    });
    expect(answer.outcome).toBe("in_progress");
    expect(Date.now() - started).toBeLessThan(2600);
    expect(claims).toBeLessThanOrEqual(10);
  });
});
