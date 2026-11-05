/** Two requests with one base arrive at once on separate connections: two heads, none lost. Runs when HOLDSEND_PG_URL is set. */
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresDraftLog, PostgresIdempotencyStore, acceptDraftUpdate, pgPoolTransaction, postgresDraftSchema, postgresSchema, readDraftState } from "../src/index.js";

const url = process.env.HOLDSEND_PG_URL;

describe.skipIf(!url)("draft log, real Postgres, many connections", () => {
  let pool: pg.Pool;
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: url, max: 10 });
    await pool.query("DROP TABLE IF EXISTS holdsend_idempotency; DROP TABLE IF EXISTS holdsend_draft_updates;");
    await pool.query(postgresSchema());
    await pool.query(postgresDraftSchema());
  });
  afterAll(async () => {
    await pool?.end();
  });

  it("40 edits from one base on 10 connections: 40 heads, 40 distinct revisions, nothing lost or doubled", async () => {
    const store = new PostgresIdempotencyStore({ db: pool, transaction: pgPoolTransaction(pool) });
    const log = new PostgresDraftLog({ db: pool });
    await acceptDraftUpdate({ store, log, owner: "p", headers: { "Idempotency-Key": "base-0001" }, update: { draftId: "d", reason: "edit" }, waitMs: 10_000 });
    const keys = Array.from({ length: 40 }, (_, i) => `edit-${String(i).padStart(4, "0")}`);
    const answers = await Promise.all(
      keys.flatMap((k) => [0, 1].map(() => acceptDraftUpdate({ store, log, owner: "p", headers: { "Idempotency-Key": k }, update: { draftId: "d", reason: "edit", baseRev: 1, payload: k }, waitMs: 10_000 }))),
    );
    expect(answers.every((a) => a.status === 201)).toBe(true);
    const all = await log.list("p", "d");
    expect(all.length).toBe(41);
    expect(new Set(all.map((u) => u.rev)).size).toBe(41);
    expect((await readDraftState(log, "p", "d")).heads.length).toBe(40);
  });
});
