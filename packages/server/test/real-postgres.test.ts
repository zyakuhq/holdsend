/**
 * Races between real connections, against a real Postgres server.
 *
 * Runs when HOLDSEND_PG_URL is set (CI starts a Postgres service for it);
 * skipped otherwise. PGlite, used by the other suites, has one connection,
 * so it cannot show races between connections at READ COMMITTED.
 */
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ClaimLostError, PostgresIdempotencyStore, handleIdempotent, pgPoolTransaction, postgresSchema, type Queryable } from "../src/index.js";

const url = process.env.HOLDSEND_PG_URL;

describe.skipIf(!url)("real Postgres, many connections", () => {
  let pool: pg.Pool;
  let store: PostgresIdempotencyStore;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: url, max: 10 });
    await pool.query("DROP TABLE IF EXISTS holdsend_idempotency; DROP TABLE IF EXISTS posts;");
    await pool.query(postgresSchema());
    await pool.query("CREATE TABLE posts (id SERIAL PRIMARY KEY, owner TEXT NOT NULL, body TEXT NOT NULL)");
    store = new PostgresIdempotencyStore({ db: pool, transaction: pgPoolTransaction(pool) });
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("creates exactly one row for 60 concurrent copies of one request on 10 connections", async () => {
    const run = () =>
      handleIdempotent<Queryable>({
        store,
        owner: "person-a",
        operation: "post.create",
        headers: { "Idempotency-Key": "race-key-0001" },
        content: { text: "flood update" },
        waitMs: 10_000,
        create: async (tx) => {
          const r = await tx.query("INSERT INTO posts (owner, body) VALUES ($1, $2) RETURNING id", ["person-a", "flood update"]);
          // Hold the transaction open briefly so the races overlap.
          await new Promise((done) => setTimeout(done, 20));
          return { status: 201, body: { id: (r.rows[0] as { id: number }).id } };
        },
      });
    const answers = await Promise.all(Array.from({ length: 60 }, run));
    const count = await pool.query("SELECT count(*)::int AS n FROM posts WHERE owner = 'person-a'");
    expect(count.rows[0].n).toBe(1);
    expect(new Set(answers.map((a) => JSON.stringify(a.body))).size).toBe(1);
    expect(answers.filter((a) => a.outcome === "created")).toHaveLength(1);
  });

  it("lets only one of many concurrent takeovers of a stale claim win, and the old owner cannot commit", async () => {
    const id = { owner: "person-b", operation: "post.create", key: "stale-key-0001" };
    const t0 = Date.now();
    const first = await store.claim({ ...id, requestHash: "h", now: t0 });
    if (first.type !== "claimed") throw new Error("expected claim");
    const later = t0 + 10 * 60 * 1000;
    const racers = await Promise.all(Array.from({ length: 20 }, () => store.claim({ ...id, requestHash: "h", now: later })));
    expect(racers.filter((r) => r.type === "claimed")).toHaveLength(1);
    await expect(
      store.transaction(async (tx) => {
        await tx.query("INSERT INTO posts (owner, body) VALUES ($1, $2)", ["person-b", "late"]);
        await store.completeInTransaction(tx, { ...id, token: first.token, result: { status: 201, body: {} } });
      }),
    ).rejects.toBeInstanceOf(ClaimLostError);
    const count = await pool.query("SELECT count(*)::int AS n FROM posts WHERE owner = 'person-b'");
    expect(count.rows[0].n).toBe(0);
  });

  it("keeps one post when purgeExpired removes a claim whose transaction is still running", async () => {
    // Independent review HS-001: the first request is slow, its claim goes
    // stale, a purge deletes it, and a retry claims the key afresh and
    // commits. The first request must then fail to commit, not add a second post.
    const id = { owner: "person-c", operation: "post.create", key: "purged-key-0001" };
    const t0 = Date.now();
    const first = await store.claim({ ...id, requestHash: "h", now: t0 });
    if (first.type !== "claimed") throw new Error("expected claim");

    let releaseFirst!: () => void;
    const gate = new Promise<void>((resolve) => (releaseFirst = resolve));
    let firstInserted!: () => void;
    const inserted = new Promise<void>((resolve) => (firstInserted = resolve));
    const slow = store.transaction(async (tx) => {
      await tx.query("INSERT INTO posts (owner, body) VALUES ($1, $2)", ["person-c", "slow first attempt"]);
      firstInserted();
      await gate;
      await store.completeInTransaction(tx, { ...id, token: first.token, result: { status: 201, body: { by: "first" } } });
    });
    await inserted;

    const later = t0 + 10 * 60 * 1000;
    expect(await store.purgeExpired(later)).toBeGreaterThanOrEqual(1);
    const retry = await store.claim({ ...id, requestHash: "h", now: later });
    if (retry.type !== "claimed") throw new Error(`expected a fresh claim, got ${retry.type}`);
    await store.transaction(async (tx) => {
      await tx.query("INSERT INTO posts (owner, body) VALUES ($1, $2)", ["person-c", "retry"]);
      await store.completeInTransaction(tx, { ...id, token: retry.token, result: { status: 201, body: { by: "retry" } } });
    });

    releaseFirst();
    await expect(slow).rejects.toBeInstanceOf(ClaimLostError);
    const posts = await pool.query("SELECT body FROM posts WHERE owner = 'person-c'");
    expect(posts.rows.map((r) => r.body)).toEqual(["retry"]);
    const again = await store.claim({ ...id, requestHash: "h", now: later + 1000 });
    expect(again).toMatchObject({ type: "replay", result: { status: 201, body: { by: "retry" } } });
  });
});
