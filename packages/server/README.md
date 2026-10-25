# @holdsend/server

The server half of [HoldSend](https://github.com/zyakuhq/holdsend). It turns a client's retries into one write.

> Early and unreleased. The API may change before 0.1.0.

## What it does

For every request that carries an `Idempotency-Key`:

1. **Claim** the key with a short statement. One concurrent request wins.
2. **Create** your resource inside a transaction.
3. **Complete** the key's record **in that same transaction**, guarded by the claim. The write and its record commit together or not at all.
4. A **retry** with the same key and the same content gets the original answer back (`Idempotent-Replayed: true`).
5. The same key with **different** content is refused (`409 key_conflict`).
6. A retry that arrives while the first attempt is **still running** waits briefly, then gets the original or `409 in_progress`.
7. A key whose resource was **deleted** answers `410 gone`, so a late retry never brings it back.

Records for completed writes are kept forever by default: something written offline can wait weeks before its last retry.

## Use it

```ts
import pg from "pg";
import { PostgresIdempotencyStore, pgPoolTransaction, postgresSchema, handleIdempotent } from "@holdsend/server";

const pool = new pg.Pool();
await pool.query(postgresSchema()); // or copy the SQL into your migrations

const store = new PostgresIdempotencyStore({ db: pool, transaction: pgPoolTransaction(pool) });

app.post("/api/posts", async (req, res) => {
  const answer = await handleIdempotent({
    store,
    owner: req.user.id,          // from the session, never from the body
    operation: "post.create",
    headers: req.headers,
    content: req.body,           // what makes two requests "the same"
    create: async (tx, { writtenAt }) => {
      const { rows } = await tx.query(
        "INSERT INTO posts (body, written_at) VALUES ($1, $2) RETURNING id",
        [req.body.text, writtenAt === null ? null : new Date(writtenAt)],
      );
      return { status: 201, body: rows[0], resourceRef: String(rows[0].id) };
    },
  });
  res.status(answer.status).set(answer.headers).json(answer.body);
});
```

When a post is deleted, call `store.tombstoneResource(tx, owner, "post.create", postId)` inside the delete's transaction.

## The written time

`writtenAt` is the time the person wrote the post, from their device, already bounded (at most two minutes ahead, at most 30 days back) and accepted only on keyed requests. Store it in its own column and show it. **Order feeds by arrival time, never by written time.**

## Stores

- `PostgresIdempotencyStore`: any client with `query(text, params)` (node-postgres, PGlite). Tested against a real Postgres engine.
- `MemoryIdempotencyStore`: the same contract in memory, for tests.

Both pass the same contract test suite.

## Licence

Apache-2.0
