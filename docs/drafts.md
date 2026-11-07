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

## Rules for your app

- Send one device's updates one at a time, in order, and give each `baseId` (the update it was written on). Updates sent at once can arrive out of order and show up as a false conflict (reported, never lost).
- Keep `writtenAt` the same on every retry of an update, because it is part of what the key stands for. It is for display only; it is not checked against the clock.
- A payload is plain JSON up to 256 KiB, without NUL characters or lone surrogates. Larger or malformed updates are answered 400 and not stored. Set your own request size limit too.
- Postgres needs the default READ COMMITTED transaction level (`pgPoolTransaction` uses it).
- `readDraftState` loads the whole log of one draft, so keep drafts to a sensible number of edits.

## On the device

`editLinks` and `resolveLinks` from `@holdsend/core/drafts` build the link fields, so an app does not hand-write them:

```ts
import { readDraft, editLinks, resolveLinks } from "@holdsend/core/drafts";

const state = readDraft(logFromServer, "d1");
// A normal edit. Pass this device's own latest unsent update as `mine`.
const links = editLinks(state, lastOwnUpdate);
// A person settled a conflict: base on their chosen head, close the others.
const settle = resolveLinks(state, chosenId); // { baseId, baseRev, resolves }
```

`editLinks` never closes a head. `resolveLinks` does, so call it only after a person has seen the heads side by side.

## Limits

- Two edits to different parts of one draft still count as a conflict. A person confirms.
- Revisions follow arrival at the server, not the order people wrote. On Postgres they follow commit order; the in-memory log (tests, one process) numbers them when the write starts, so they can differ from commit order there.
- A conflict stays open until a person resolves it. Show conflicted drafts in your app.
- Every update is kept, so storage grows with edits. Nothing prunes it yet.
- The conflict screen is an example, not a library component: see `/drafts` in [examples/notes](../examples/notes) (`src/drafts-client.mjs`). It shows every open version side by side, lets a person keep one or write a version using both, and refuses to settle while this device still has unsent edits. It sends only while the page is open (no background sending for drafts yet).
