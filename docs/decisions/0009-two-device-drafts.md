# 0009: One draft on two devices (design note, proposed)

Date: 2026-11-03. Status: proposed. Step 1 of the next steps is built (2026-11-04, unreleased): `readDraft` and `ancestorsOf` in `@holdsend/core/drafts`. The server helper is not built yet.

## The problem

A person edits one draft on a phone and a laptop. Both are offline for a while, both save edits, both later reach the server. The outbox already makes each send happen once. It does not decide what the draft should say when two devices changed the same base version.

This is the hard part of Phase 3. We say plainly: no design here is perfect, and the aim is that **no edit is silently lost**, not that the two versions merge by themselves.

## Options looked at

1. **Last writer wins.** Simple, and wrong: the earlier edit disappears with no trace. Written time comes from a phone clock, so "last" is also unreliable ([decision 0003](0003-written-at-header.md)). Rejected.
2. **Automatic merge (a CRDT or operational transform).** Gives a merged text without asking, but needs a large library or a lot of new code to audit, the core is at its size budget, and a wrong merge of a person's words is hard to notice. Not for v0.3. Apps that already use one can send its updates through the outbox as ordinary items.
3. **Append-only updates with a reason, and a person resolves.** Every edit is a new update that is never overwritten. The server records which version each edit was based on. When two edits share a base, both are kept and the draft is marked "conflicted" until someone picks or combines them. Chosen.

## Choice (proposed)

Lives in a new subpath, `@holdsend/core/drafts`, so the core's size budget is untouched. Each edit is one outbox item whose payload carries:

- `draftId`: which draft.
- `baseRev`: the revision this device last saw from the server (or none for a new draft).
- `reason`: a short label the app sets (`"edit"`, `"resolve"`, `"restore"`), so history reads sensibly.
- `resolves`: for a resolving update, the ids of the updates it settles.
- The outbox key is the update id, so a retry cannot add the edit twice.

Server side (`@holdsend/server`, a helper over the existing idempotency store):

- An update is always accepted, never refused for being stale. It gets the next revision number from the server, not from any device clock.
- If `baseRev` is the current head, the draft moves forward. If it is older, the draft is marked conflicted and lists the heads that are not yet resolved.
- A `resolve` update closes the heads it names. Only a person triggers it; the library never resolves by itself.
- The server returns the current head, the unresolved heads and their payloads, so the app can show both versions side by side.

What the library will not do: merge text, choose a winner, or order edits by written time. Written time is shown to the person to help them choose, and nothing more.

## Honest limits

- Two edits to different parts of the same draft still count as a conflict. A person has to confirm. This is deliberate.
- Revisions are ordered by arrival at the server, which may differ from the order people wrote them.
- A person who never opens the conflicted draft leaves it conflicted. The app should show it, and the guide will say so.
- Deleting a draft on one device while another edits it is a conflict too: the delete is an update with a reason, and the edit keeps the draft alive until someone resolves it.

## Test plan (before any code is called done)

- Fault-injection scenarios like the never-twice suite: two devices, random offline periods, lost answers, retries, restarts. The check is that every accepted edit is still reachable from the head or a listed conflict, and no edit appears twice.
- Deliberately broken versions (last-writer-wins, a stale base refused, a retry adding a second copy) must make those tests fail.
- A real Postgres race test: two requests with the same base arriving at once give two heads, never one lost.

## Open questions

- Where should the draft log live in Postgres: one row per update with a unique `(draft_id, update_id)`, or a JSON array per draft? Leaning to one row per update; needs a size and index check.
- Does the web example need a conflict screen in this release, or does the helper plus a guide come first?
- How long may a conflict stay open before the server stops accepting edits based on old revisions? Leaning to never; storage cost to be measured.

## Built so far

`readDraft(log, draftId?)` returns the open heads, whether the draft is conflicted, the latest head, and any references that point nowhere (reported, never an error). An update's parents are its `baseId` (or else `baseRev`) and the ids it `resolves`; a head is an update nobody else has as a parent. Repeated ids count once. Input order and written time do not change the result. A scenario suite and a fault-injection suite (three devices, lost answers, retries, resolves) check that every accepted edit is reachable from a head and none appears twice; last-writer-wins, double-counting a retry and dropping a stale-base edit each make it fail.

## Next steps

1. (Done) Add the types and a pure function that, given the update log, returns the head and unresolved heads, with the scenario suite above.
2. Add the server helper over the idempotency store (memory and Postgres).
3. Review by a separate agent before merge, since this is high stakes.
