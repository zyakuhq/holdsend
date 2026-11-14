# 0013: What 1.0 should rename, merge or remove

Date: 2026-11-14. Status: proposed. To be accepted, changed or rejected before the 1.0 API freeze (Phase 4).

## Context

Decision 0012 records every public declaration in `api/*.api.txt`. From 1.0 on, removing or changing anything in that record needs a major version. So 1.0 is the last cheap moment to fix names and shapes. This note reads the 0.2.0 record end to end and lists what should change, what should stay, and what was already fixed because the fix breaks nobody.

Rule used: change something only when it confuses a reader, ties users to an internal file layout, or promises something we do not want to keep. A name that is merely not to taste stays. Every rename costs every user an edit.

## Fixed now (no one's code breaks)

These change only type declarations, not what any function does or returns at run time.

- `EmergencyOutbox.send` had an inferred return type that named an internal file (`import("./transitions.js").RetryResult`). It now says `Promise<RetryResult>`. `scripts/api-surface.mjs` now fails when any recorded type points into an internal file, so this cannot come back unnoticed.
- `PoolLike` (`@holdsend/server`, the argument of `pgPoolTransaction`) and `Unsubscribe` (`@holdsend/react-native`, returned by the auto-flush listeners) were part of the API but not exported, so users could not name them. Both are exported now.
- `AcceptDraftUpdateOptions.headers` was typed as `Parameters<typeof handleIdempotent>[0]["headers"]`; it now says `HeaderSource | undefined`, the same type.
- Parameter names in declarations: `acceptDraftUpdate(o)` is now `acceptDraftUpdate(options)` and `PostgresDraftLog.append(tx, owner, u)` is now `append(tx, owner, update)`. Names of parameters are not part of TypeScript compatibility, but editors show them.

## Proposed for 1.0

1. **One type for "something you can kick and stop".** `FlushScheduler` (core), `AutoFlusher` (web) and `NativeAutoFlusher` (React Native) are the same shape, `{ kick(): void; stop(): void }`. Proposal: keep `FlushScheduler` in core as the one type; in 1.0 `AutoFlusher` and `NativeAutoFlusher` become type aliases of it, marked deprecated in their doc comments, and are removed in 2.0. Nothing breaks, because the shapes are already equal.
2. **The draft helpers are either frozen or clearly outside the promise.** `@holdsend/core/drafts` and the draft exports of `@holdsend/server` are "early, for 0.3" (decision 0011). Proposal: they join the 1.0 promise only if, by the 1.0 freeze, an example app has used them through at least one release with no API change. If not, 1.0 ships them under the same names but the changelog and README say the drafts API is outside the semver promise until 1.1. Decide at the freeze, not now.
3. **`DraftState` keeps only what an app acts on.** `count`, `repeats` and `dangling` are diagnostics about the log, not something a screen needs. Proposal: keep `conflicted`, `heads`, `latest`, `unresolved` and `ids` at the top, and move the three diagnostics under one field, `log: { count, repeats, dangling }`. Breaking, so only with item 2.
4. **`OutboxItem` says which fields are the library's.** `claimedAt`, `claimToken`, `touched`, `failures`, `noAnswerSince` and `timeouts` are bookkeeping that a custom `Store` must save and return unchanged, but that an app should never set. Proposal: no rename (they are stored on devices, and a rename would need a migration of saved queues), but each gets a doc comment "kept by the library; store it unchanged", and docs/protocol.md gets a short section on the stored item format and that 1.x only adds optional fields to it.
5. **`ItemState` and `ItemStatus` stay, with better docs.** The names are one letter apart: `ItemState` is what is stored (`waiting`, `sending`, `sent`, `stuck`), `ItemStatus` is what to show (adds `needs_confirmation`). A rename would touch every app that shows status. Proposal: keep both names; the doc comment of each names the other and says when to use which.

## Looked at and kept

- `MemoryIdempotencyStore.size`: useful in tests that check purging; harmless.
- `onMemoryCommit`: needed by anyone writing another in-memory store that commits with the idempotency store (as `MemoryDraftLog` does).
- `sameWords` (emergency): lets an app show "this is the same message" with the same rule the outbox uses.
- `classifyResponse` and `classifyThrown`: the documented way to write a `Sender`.
- `KEY_PATTERN`: a plain regular expression with no global flag, so sharing it holds no state.
- `EmergencyOutboxOptions.policy` repeats the field it inherits; harmless, and it is where its doc comment lives.

## Not decided here

- Whether the core's 5,120-byte size budget moves for 1.0. Item 1 and the doc comments in item 4 add no run-time code.
- The migration guide. It will be written from this list once the items above are accepted or rejected.
