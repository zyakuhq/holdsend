// The notes server as a function, so tests can start one on any port.
//
// This is a demo. "Signing in" is a random id the browser makes up and sends
// in the X-Demo-User header. A real app takes the owner from its session,
// never from anything the request says about itself.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import express from "express";
import { PostgresIdempotencyStore, handleIdempotent, pgPoolTransaction, postgresSchema } from "@holdsend/server";

const here = (path) => fileURLToPath(new URL(path, import.meta.url));

const NOTES_SCHEMA = `
CREATE TABLE IF NOT EXISTS notes (
  id         BIGSERIAL PRIMARY KEY,
  owner      TEXT NOT NULL,
  text       TEXT NOT NULL,
  written_at TIMESTAMPTZ,
  arrived_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS notes_owner_arrived_idx ON notes (owner, arrived_at DESC);
`;

const DEMO_USER = /^[A-Za-z0-9-]{8,64}$/;
const MAX_NOTE = 2000;

async function openDatabase(databaseUrl) {
  if (databaseUrl) {
    const { default: pg } = await import("pg");
    const pool = new pg.Pool({ connectionString: databaseUrl });
    return { db: pool, transaction: pgPoolTransaction(pool), close: () => pool.end(), label: "Postgres from DATABASE_URL" };
  }
  const { PGlite } = await import("@electric-sql/pglite");
  const lite = new PGlite();
  return { db: lite, transaction: (fn) => lite.transaction(fn), close: () => lite.close(), label: "PGlite in memory; set DATABASE_URL to use Postgres" };
}

/** Bundles the page script (a module) and the service worker (a classic script) once, at start, into memory. */
async function bundleClient() {
  const bundle = async (entry, format) => {
    const result = await build({ entryPoints: [here(entry)], bundle: true, format, target: "es2022", write: false, logLevel: "silent" });
    return result.outputFiles[0].text;
  };
  const [app, sw] = await Promise.all([bundle("./client.mjs", "esm"), bundle("./sw.mjs", "iife")]);
  return { "app.js": app, "sw.js": sw };
}

function noteJson(row) {
  const time = (value) => (value === null ? null : new Date(value).toISOString());
  return { id: String(row.id), text: row.text, writtenAt: time(row.written_at), arrivedAt: time(row.arrived_at) };
}

export async function createNotesApp(options = {}) {
  const database = await openDatabase(options.databaseUrl);
  // One statement per query: PGlite's query() takes a single statement.
  for (const statement of `${postgresSchema()}\n${NOTES_SCHEMA}`.split(";").map((s) => s.trim()).filter(Boolean)) {
    await database.db.query(statement);
  }
  const store = new PostgresIdempotencyStore({ db: database.db, transaction: database.transaction });

  const [client, indexHtml] = await Promise.all([bundleClient(), readFile(here("../public/index.html"), "utf8")]);
  // Owners who asked to lose the answer to their next note (the demo button).
  const loseNextAnswer = new Set();
  // For tests: how many answers were really dropped.
  const stats = { answersLost: 0 };

  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "16kb" }));

  const page = (type, body) => (_req, res) => {
    res.set({ "content-type": type, "cache-control": "no-cache" }).send(body);
  };
  app.get("/", page("text/html; charset=utf-8", indexHtml));
  app.get("/app.js", page("text/javascript; charset=utf-8", client["app.js"]));
  app.get("/sw.js", page("text/javascript; charset=utf-8", client["sw.js"]));

  // Every API route needs the demo user.
  app.use("/api", (req, res, next) => {
    const owner = req.get("x-demo-user") ?? "";
    if (!DEMO_USER.test(owner)) return res.status(401).json({ code: "no_user", message: "Send X-Demo-User." });
    res.locals.owner = owner;
    next();
  });

  app.get("/api/notes", async (_req, res) => {
    const { rows } = await database.db.query(
      // Ordered by arrival, never by the written time the client claims.
      "SELECT id, text, written_at, arrived_at FROM notes WHERE owner = $1 ORDER BY arrived_at DESC, id DESC LIMIT 100",
      [res.locals.owner],
    );
    res.set("cache-control", "no-store").json({ notes: rows.map(noteJson) });
  });

  app.post("/api/notes", async (req, res) => {
    const owner = res.locals.owner;
    const text = req.body?.text;
    if (typeof text !== "string" || text.trim() === "" || text.length > MAX_NOTE) {
      return res.status(400).json({ code: "invalid_note", message: `A note is 1 to ${MAX_NOTE} characters.` });
    }
    const answer = await handleIdempotent({
      store,
      owner,
      operation: "note.create",
      headers: req.headers,
      content: { text },
      // Every note must carry a key: a request without one could not be
      // told apart from its own retry.
      requireKey: true,
      create: async (tx, { writtenAt }) => {
        const { rows } = await tx.query("INSERT INTO notes (owner, text, written_at) VALUES ($1, $2, $3) RETURNING id, text, written_at, arrived_at", [
          owner,
          text,
          writtenAt === null ? null : new Date(writtenAt),
        ]);
        const note = noteJson(rows[0]);
        return { status: 201, body: { id: note.id }, resourceRef: note.id };
      },
    });
    if (answer.outcome === "created" && loseNextAnswer.delete(owner)) {
      // The note is saved, but the answer never reaches the browser: the
      // connection breaks part way through, as on a train going into a
      // tunnel. (A few bytes are written first: browsers quietly resend a
      // request whose connection closed before any answer started.)
      stats.answersLost += 1;
      req.socket.end("HTTP/1.1 2");
      return;
    }
    res.status(answer.status).set(answer.headers).json(answer.body);
  });

  app.delete("/api/notes/:id", async (req, res) => {
    const owner = res.locals.owner;
    const id = req.params.id;
    if (!/^\d{1,18}$/.test(id)) return res.status(404).json({ code: "not_found", message: "No such note." });
    const deleted = await store.transaction(async (tx) => {
      const { rows } = await tx.query("DELETE FROM notes WHERE id = $1 AND owner = $2 RETURNING id", [id, owner]);
      // A late retry of the request that created this note now gets 410
      // gone instead of bringing it back.
      if (rows.length > 0) await store.tombstoneResource(tx, owner, "note.create", id);
      return rows.length > 0;
    });
    if (!deleted) return res.status(404).json({ code: "not_found", message: "No such note." });
    res.status(204).end();
  });

  app.post("/api/demo/lose-next-answer", (_req, res) => {
    if (loseNextAnswer.size >= 10_000) loseNextAnswer.clear(); // a demo; keep it bounded
    loseNextAnswer.add(res.locals.owner);
    res.status(204).end();
  });

  // Express knows an error handler by its four parameters, so _next stays.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err, _req, res, _next) => {
    if (err?.type === "entity.parse.failed" || err?.type === "entity.too.large") {
      return res.status(400).json({ code: "bad_request", message: "The body must be JSON, at most 16 kB." });
    }
    console.error(err);
    res.status(500).json({ code: "server_error", message: "Something went wrong. Try again." });
  });

  return { app, stats, databaseLabel: database.label, close: database.close };
}
