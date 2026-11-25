// Run once during deployment, before starting application instances.
import pg from "pg";
import { error as logError, log } from "node:console";
import process from "node:process";
import { postgresDraftSchema, postgresSchema } from "@holdsend/server";
import { NOTES_SCHEMA } from "./schema.mjs";

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error("DATABASE_URL is required to run the PostgreSQL migration.");
}

const lockTimeoutMs = Number(process.env.MIGRATION_LOCK_TIMEOUT_MS ?? "500");

if (!Number.isSafeInteger(lockTimeoutMs) || lockTimeoutMs < 1) {
  throw new Error("MIGRATION_LOCK_TIMEOUT_MS must be a positive integer.");
}

const client = new pg.Client({ connectionString });

try {
  await client.connect();
  await client.query("BEGIN");

  await client.query(
    "SELECT set_config('lock_timeout', $1, true)",
    [`${lockTimeoutMs}ms`],
  );

  await client.query(
    `${postgresSchema()}\n${NOTES_SCHEMA}\n${postgresDraftSchema()}`,
  );

  await client.query("COMMIT");
  log("HoldSend Notes PostgreSQL schema is up to date.");
} catch (error) {
  try {
    await client.query("ROLLBACK");
  } catch {
    // Preserve the original migration error.
  }

  logError("PostgreSQL migration failed; the transaction was rolled back.");
  throw error;
} finally {
  await client.end();
}
