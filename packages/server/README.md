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
    requireKey: true,            // a request without a key could not be told apart from its retry
    create: async (tx, { writtenAt }) => {
      const { rows } = await tx.query(
        "INSERT INTO posts (body, written_at) VALUES ($1, $2) RETURNING id",
        [req.body.text, writtenAt === null ? null : new Date(writtenAt)],
      );
      // Only a 2xx answer is stored and replayed. Anything else rolls back
      // and frees the key, so a retry runs create again.
      return { status: 201, body: { id: rows[0].id }, headers: { Location: `/api/posts/${rows[0].id}` }, resourceRef: String(rows[0].id) };
    },
  });
  res.status(answer.status).set(answer.headers).json(answer.body);
});
```

When a post is deleted, call `store.tombstoneResource(tx, { owner, operation: "post.create", resourceRef: postId })` inside the delete's transaction.

## Keeping it tidy and private

- **Store a small result.** What `create` returns is kept and replayed for as long as the record lives (forever by default). Usually `{ id }` is enough. Do not put the person's content or other personal data in it unless the client needs it back.
- **Purge on a schedule.** Run `store.purgeExpired()` every hour or so. It removes expired records and claims nobody finished.
- **Erase an owner.** When an account is deleted or a person asks for erasure, call `store.forgetOwner(userId)` after the account itself is gone.

## Browsers: CORS

If the client runs on another origin, the server must allow and expose the headers:

```
Access-Control-Allow-Headers: Content-Type, Idempotency-Key, Written-At
Access-Control-Expose-Headers: Idempotent-Replayed
```

## The written time

`writtenAt` is the time the author says they wrote the post. It is accepted only on keyed requests and only within bounds (at most two minutes ahead, at most 30 days back), but any client can send it, so treat it as the author's claim. Store it in its own column and show it as such. **Order feeds by arrival time, never by written time.**

## Stores

- `PostgresIdempotencyStore`: any client with `query(text, params)` (node-postgres, PGlite). Tested against a real Postgres engine.
- `MemoryIdempotencyStore`: the same contract in memory, for tests.

Both pass the same contract test suite.

## Licence

Apache-2.0
