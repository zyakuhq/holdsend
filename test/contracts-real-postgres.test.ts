/**
 * The draft log and idempotency store contract checks on a real Postgres
 * through node-postgres, with many connections. The draft log check that
 * needs a second connection while a transaction is open runs here, which
 * PGlite cannot do. Runs when HOLDSEND_PG_URL is set; CI's postgres job
 * sets it.
 */
import pg from "pg";
import { afterAll, beforeAll, describe, it } from "vitest";
import { PostgresDraftLog, PostgresIdempotencyStore, pgPoolTransaction, postgresDraftSchema, postgresSchema, type IdempotencyStore, type Queryable } from "@holdsend/server";
import { draftLogContractChecks, type DraftLogHarness, type DraftLogUnderTest } from "./draft-log-contract.js";
import { idempotencyContractChecks, type IdempotencyStoreHarness } from "./idempotency-store-contract.js";

const url = process.env.HOLDSEND_PG_URL;

describe.skipIf(!url)("contract checks, real Postgres through node-postgres", () => {
  let pool: pg.Pool;
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: url, max: 10 });
    await pool.query("DROP TABLE IF EXISTS contract_pg_drafts; DROP TABLE IF EXISTS contract_pg_records; DROP TABLE IF EXISTS contract_pg_rows;");
    await pool.query(postgresDraftSchema("contract_pg_drafts"));
    await pool.query(postgresSchema("contract_pg_records"));
    await pool.query("CREATE TABLE contract_pg_rows (id TEXT PRIMARY KEY)");
  });
  afterAll(async () => {
    await pool?.end();
  });

  const draftHarness = (): DraftLogHarness => ({
    async create() {
      await pool.query("TRUNCATE contract_pg_drafts");
      return { log: new PostgresDraftLog({ db: pool, table: "contract_pg_drafts" }), transaction: pgPoolTransaction(pool) } as DraftLogUnderTest<Queryable> as DraftLogUnderTest;
    },
    concurrentTransactions: true,
  });

  const storeHarness = (): IdempotencyStoreHarness => ({
    async create({ clock, staleClaimMs, completedTtlMs }) {
      await pool.query("TRUNCATE contract_pg_records; TRUNCATE contract_pg_rows;");
      return new PostgresIdempotencyStore({
        db: pool,
        table: "contract_pg_records",
        transaction: pgPoolTransaction(pool),
        now: () => clock.now,
        staleClaimMs,
        ...(completedTtlMs === undefined ? {} : { completedTtlMs }),
      }) as IdempotencyStore<unknown>;
    },
    async writeRow(tx, id) {
      await (tx as Queryable).query("INSERT INTO contract_pg_rows (id) VALUES ($1)", [id]);
    },
    async rows() {
      return (await pool.query<{ id: string }>("SELECT id FROM contract_pg_rows ORDER BY id")).rows.map((r) => r.id);
    },
    // The takeover in that check waits for the row lock the open completion
    // holds (the safe behaviour), so the check cannot finish on one test
    // process. It runs on the memory store.
    concurrentTransactions: false,
  });

  for (const check of draftLogContractChecks) {
    it(`DraftLog: ${check.name}`, async () => {
      await check.run(draftHarness());
    });
  }
  for (const check of idempotencyContractChecks) {
    it(`IdempotencyStore: ${check.name}`, async () => {
      await check.run(storeHarness());
    });
  }
});
