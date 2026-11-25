import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";
import pg from "pg";
import {
  postgresDraftSchema,
  postgresSchema,
} from "@holdsend/server";
import { createNotesApp } from "../src/app.mjs";
import { NOTES_SCHEMA } from "../src/schema.mjs";

const url = process.env.HOLDSEND_PG_URL;

test("Postgres app startup does not wait for schema DDL locks", { skip: !url }, async () => {
  const setup = new pg.Client({ connectionString: url });
  await setup.connect();

  try {
    const schema = [
      postgresSchema(),
      NOTES_SCHEMA,
      postgresDraftSchema(),
    ].join("\n");
    await setup.query(schema);
  } finally {
    await setup.end();
  }

  const pool = new pg.Pool({ connectionString: url, max: 1 });
  const lockClient = await pool.connect();
  let appPromise;
  let app;
  let timer;

  try {
    await lockClient.query("BEGIN");
    await lockClient.query(`
      LOCK TABLE
        holdsend_idempotency,
        holdsend_draft_updates,
        notes,
        emergency_messages
      IN ACCESS EXCLUSIVE MODE
    `);

    appPromise = createNotesApp({
      databaseUrl: url,
      staticDir: fileURLToPath(new URL("../public", import.meta.url)),
    });

    const result = await Promise.race([
      appPromise.then((value) => ({ app: value })),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve({ timeout: true }), 5000);
      }),
    ]);

    assert.equal(
      result.timeout,
      undefined,
      "App startup waited for a PostgreSQL schema lock",
    );

    app = result.app;
  } finally {
    clearTimeout(timer);
    await lockClient.query("ROLLBACK").catch(() => {});
    lockClient.release();

    if (appPromise) {
      const started = await appPromise.catch(() => null);
      await (app ?? started)?.close();
    }

    await pool.end();
  }
});
