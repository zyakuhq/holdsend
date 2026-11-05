# One draft on two devices

For 0.3, unreleased. Design: [decision 0009](decisions/0009-two-device-drafts.md). This is the hard part of offline writing, and nothing here is perfect: the aim is that **no edit is silently lost**. The library never merges text and never picks a winner.

## How it works

Each edit is one update, sent through the outbox with the update id as the Idempotency-Key. The server stores every update, gives it the next revision number (not a device clock), and never refuses it for being stale. `readDraft` from `@holdsend/core/drafts` reads the log and returns the open heads. One head means no conflict. Two or more mean two edits share a base, and a person has to settle them with an update whose `resolves` lists the ids it closes.

## Server

```ts
import { MemoryIdempotencyStore, MemoryDraftLog, acceptDraftUpdate, readDraftState } from "@holdsend/server";

const store = new MemoryIdempotencyStore();
const log = new MemoryDraftLog();

// PUT /drafts: the Idempotency-Key header is the update id.
const answer = await acceptDraftUpdate({
  store, log, owner: session.userId, headers: req.headers,
  update: { draftId: "d1", baseRev: 3, reason: "edit", writtenAt, payload: { text } },
});
// answer.body is { id, draftId, rev }

// GET /drafts/d1
const state = await readDraftState(log, session.userId, "d1");
// state.conflicted, state.heads, state.latest
```

For Postgres, run `postgresDraftSchema()` once and use `new PostgresDraftLog({ db })` with `PostgresIdempotencyStore`. The update and its idempotency record commit together.

## Limits

- Two edits to different parts of one draft still count as a conflict. A person confirms.
- Revisions follow arrival at the server, not the order people wrote.
- A conflict stays open until a person resolves it. Show conflicted drafts in your app.
- Every update is kept, so storage grows with edits. Nothing prunes it yet.
- No conflict screen is shipped yet, and no device-side helper to build `baseRev` and `resolves`; that is next.
