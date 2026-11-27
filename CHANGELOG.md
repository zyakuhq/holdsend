# Changelog

All notable changes to the `@holdsend` packages. All four packages share one version number.

## Unreleased

Planned as 0.3.0. One draft edited on two devices, the Android background flush run on an emulator in CI, and the fixes and API tidying found while preparing for 1.0. One breaking change, in the draft helpers, which were marked early in 0.2.0. Three behaviour changes need no code edit but are worth checking: `postgresSchema()` must be sent whole, and an offline flush now counts as work left for `onBackgroundSync` and `runBackgroundFlush`. Every edit is listed in docs/upgrading.md. Saved queues need no migration.

- Fixed: the Postgres stores changed a JSON value that was a string whose text looks like JSON. A draft update whose payload was the string `"42"` came back as the number 42, the string `"null"` came back as no payload at all, and a replayed answer whose body was the string `"42"` came back as the number 42. `PostgresDraftLog` and `PostgresIdempotencyStore` now read their JSONB columns as text and parse that, so every driver gives back exactly what was stored. Object and array payloads and bodies, the usual case, were never affected. The memory stores were right. Found by the new draft log checks. Decision 0023.
- The server `DraftLog` contract has checks: `test/draft-log-contract.ts` in the repository runs ten of them against `MemoryDraftLog` and `PostgresDraftLog`, and nineteen deliberately broken logs show each check can fail. Copy the file to test a draft log for another database; it is not published. Decision 0023.
- The server `IdempotencyStore` contract has checks too: `test/idempotency-store-contract.ts` in the repository runs fifteen of them against the memory and Postgres stores, and twenty-seven deliberately broken stores show each check can fail. Copy the file to test a store for another database; it is not published. Two rules the stores already kept are now written in the `IdempotencyStore` doc comments: only the same request may take over a stale claim, and a tombstone never expires and is never purged. No package code changed. Decision 0022.
- The client `Store` contract has checks: `test/store-contract.ts` in the repository runs nine of them against every built-in store, and ten deliberately broken stores show each check can fail. Copy the file to test a custom store; it is not published. The contract now says what the stores already did: `fn` is synchronous, items may come back in any order (`IndexedDbStore` returns them by key; items written in the same millisecond keep the store's order), and a store may index items by key, since the outbox never leaves two with the same one. No package code changed. Decision 0021.
- Before a release, `npm run smoke:packed` installs the tarballs `npm pack` makes in an empty folder and runs the Node smoke test there, so a version bump that misses a dependency or a subpath left out of a tarball fails before anything is published. CI runs it on Node 22 and 20.0.0. No package code changed. Decision 0020.
- `postgresSchema()` no longer locks the table when there is nothing to do. Its `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` and `CREATE INDEX IF NOT EXISTS` lines lock the table before they check, so an instance that ran the schema at startup while a backup or a long transaction had the table open waited for it, and every claim after it waited too. Nothing was lost or sent twice. The column and indexes are now looked up in the catalog first, inside a `DO` block, and created only when missing. Two instances that start at once now wait for each other on an advisory lock instead of one failing. If you or a migration tool split the text on `;` to send it one statement at a time, send it whole instead. Reported with a reproduction by an outside reporter (#54). Decision 0019.
- When the device went offline before or during a flush and sendable items were left, the report looked finished: `onBackgroundSync` resolved, so the browser dropped the sync, and `runBackgroundFlush` said `done`. Nothing was lost; the items waited for the app's next flush. `FlushReport` now has an optional `deferredOffline: true` in that case; `onBackgroundSync` rejects so the browser may retry, and `runBackgroundFlush` returns `waiting` with `retryLater: true` (an outbox offline at the start used to give `done`). Items waiting for a person, in a retry delay, or of another owner do not count. Reported with tests by an outside contributor (#81). Decision 0018.
- CI runs the Expo example's Android background task on an emulator (Android 14, release build): a note written while the server is unreachable is sent by the task, in a process Android started with no screen, and published once. Only when the code it covers changes; it forces the job, so it does not show how often Android runs it. Decision 0016.
- The Expo example's release build crashed at launch: Expo's template turns R8 on, and R8 removed the constructor Room uses for WorkManager's database (which `expo-background-task` runs on). The example now keeps it with a small config plugin, `examples/expo/plugins/keep-work-database.js`. If your app uses `expo-background-task` with R8, check a release build. No package code changed.
- **Breaking (drafts, early API):** `DraftState` keeps only what a screen acts on. `count`, `repeats` and `dangling` moved under `log` (type `DraftLogInfo`): `state.count` is now `state.log.count`. Applies to `readDraft` and `readDraftState`. Decision 0015, which also sets when drafts join the 1.0 promise. Edits listed in docs/upgrading.md.
- Every item that has left the device without a confirmed outcome says why, in `lastAttempt`: `"no_answer"` (no HTTP answer, a timeout, or a sender that died mid-send; it may already be on the server, and the next try uses the same key), `"server_busy"` (408, 429, 5xx and similar; retried with backoff) or `"refused"` (any other 4xx, or a key that holds different content). It is for display only, never used to decide whether to send, and is cleared on delivery and when a person retries or approves the item (`approve()` left it in place until a review before 0.3.0 found it). An item whose sender died during its last allowed attempt has no value; docs/protocol.md says how to show it.
- `outbox.sendNow(owner)`: the person's "Send now". One pass over the same queue, with the same items and the same keys, without waiting for the backoff of earlier failures.
- The core's size budget is 5.25 KB (decision 0014).
- `AutoFlusher` (web) and `NativeAutoFlusher` (React Native) are now type aliases of `FlushScheduler` from `@holdsend/core`, the same shape, and are marked deprecated. Existing code keeps working; the old names stay until 2.0.
- The library's bookkeeping fields on `OutboxItem`, and `ItemState` and `ItemStatus`, say in their doc comments how to use them. docs/protocol.md describes the stored item format and what 1.x promises about it.
- docs/production.md: a checklist per package before you ship, and what 1.0 still needs.
- Types only, nothing changes at run time: `@holdsend/server` exports `PoolLike` (the argument of `pgPoolTransaction`) and `@holdsend/react-native` exports `Unsubscribe`; `EmergencyOutbox.send` declares `Promise<RetryResult>` instead of a type that named an internal file; `AcceptDraftUpdateOptions.headers` is written as `HeaderSource | undefined` (the same type). The API record check now fails on any type that points into an internal file. Proposed changes for 1.0: docs/decisions/0013-api-review-for-1.0.md.
- The public TypeScript API of every entry point is recorded in `api/*.api.txt`; `npm run check` and CI fail when it changes without the record being updated, so every API change shows up in review. No package code changed.

## 0.2.0 (2026-11-13)

The emergency module, the Android background flush for React Native, and early helpers for one draft edited on two devices (finished for 0.3). Packages that do not use the new parts need no changes.

- Early, for 0.3 (the API may still change): `@holdsend/core/drafts`, for one draft edited on two devices. `readDraft` and `ancestorsOf` read an update log and list the open heads; `editLinks` and `resolveLinks` build the link fields of a new update (`resolveLinks` closes only the heads a person saw, and throws when the chosen id is not an open head). Nothing is merged and no winner is picked: two heads are a conflict a person settles. Guide: docs/drafts.md.
- Early, for 0.3: `@holdsend/server` stores draft updates with `acceptDraftUpdate`, `MemoryDraftLog`, `PostgresDraftLog` and `postgresDraftSchema()`, and reads them with `readDraftState`. Every update is kept with a revision number from the server, and is committed together with its idempotency record, so a retry is the same update. `checkDraftUpdate` checks one before storing (payload at most 256 KiB of plain JSON). `onMemoryCommit` lets another in-memory store (such as `MemoryDraftLog`) commit or roll back with a `MemoryIdempotencyStore` transaction.
- docs/low-end.md: what a long queue costs in `KeyValueStore` (each change rewrites the whole queue, so bytes written grow with the square of its length), measured on a laptop, with advice for slow phones.

- `@holdsend/react-native`: `runBackgroundFlush(outbox, { owner, budgetMs })`, one time-limited flush for the callback of an Android background task (WorkManager through a library such as `expo-background-task`). It reports `done`, `waiting`, `out-of-time` or `failed`, and whether an earlier run would help (`expo-background-task` ignores the task's result when it schedules the next run, so there map only `failed`). Unit tests only; not yet run on a real phone.
- The Expo example registers an Android background task (`expo-background-task`) that sends waiting notes with `runBackgroundFlush`, and says on screen that Android decides when it runs. Not yet run on a real phone or emulator.
- New, in development: `@holdsend/core/emergency`, for short emergency messages. Messages wait in their own queue. The first message goes by itself when the connection returns, and later ones wait for the person to press Send. The same words tapped again are one message, a message waiting for a day asks before sending, and `smsLink` builds an SMS hand-off. It is a delivery aid, not an emergency service. The SMS links have not been tried on a real phone yet. Guide: docs/emergency.md.
- `add()` takes a `decide` option that runs inside the store's atomic update. It can return a queued item instead of adding a new one, or hold the new item until a person approves it. Held items have `held: true` and show as `"needs_confirmation"`. `decide` gets copies, so it cannot change the queue.
- `add()` takes `askAfterMs`: the item asks a person before it is sent once it is that old, whatever the sending outbox's policy. It is stored on the item as `askBy`, so service workers follow it too.
- The core README no longer lists state-machine functions that stopped being exported in 0.1.0.
- The notes example has an emergency page (`/emergency`), with browser tests: the first message goes by itself and later ones wait, repeated taps are one message, the SMS hand-off can be undone, the service worker's background sync sends only the first message, a day-old message asks first, another person on the same browser never sends someone else's messages, and text that looks like HTML is shown as text.
- An item whose written time is later than now by more than `staleClaimMs` (the device clock ran ahead and was set back since) now asks a person before it is sent, like an old item, because its real age is unknown. Before, it could go out stale until real time caught up.
- Emergency messages: `write()` refuses a `writtenAt` in the future; matching treats the different Unicode forms of the same letters as the same words; a retried store update no longer leaves a wrong `duplicate` or `held` in the result; `smsLink` encodes `+` in the iOS multi-recipient link, where a bare `+` can be read as a space.
- Every package exports `./package.json`, so tools that read `@holdsend/<name>/package.json` (bundlers, React Native's Metro, version checks) no longer fail with `ERR_PACKAGE_PATH_NOT_EXPORTED`.

## 0.1.1 (2026-10-27)

No API changes. Fixes and documentation from an independent source review of 0.1.0.

### @holdsend/core

- `add()` keeps its own copy of the payload, so changing the object afterwards cannot change what is sent, even with a custom store that keeps references. The `Store` contract now says stores must keep their own copies.

### @holdsend/server

- A new section, "What exactly once depends on": `requireKey: true` on every create, keeping records as long as clients may retry (and why `completedTtlMs` is risky), and the owner from the session.
- A new test against a real Postgres server: when `purgeExpired()` removes the claim of a request that is still running, that request cannot commit, and only the retry's post exists.

### @holdsend/react-native

- The README says that store updates take turns within one JavaScript runtime only.

### All packages

- The READMEs say which Node versions can load the packages: `import` on Node 20 or later, `require()` on Node 20.19 or later and 22.12 or later. On older Node 20 releases `require()` fails with `ERR_REQUIRE_ESM`.
- CI loads all four packages on Node 20.0.0, the oldest version they support, and checks that a write whose answer was lost is still published exactly once.
- Releases are staged on npm and go live only after a maintainer approves them with two-factor authentication. They are published from GitHub Actions with trusted publishing and provenance, with no npm token.

## 0.1.0 (2026-10-26)

The first release. Early: the API may still change before 1.0, and nothing here is ready for production yet.

### @holdsend/core

- `Outbox`: keeps what people write while they are offline and publishes each item once, with one idempotency key per item for life.
- The written time travels with every item, separately from the arrival time, and is never used for ordering.
- Cancel works only while an item has never left the device. Items written more than 30 days ago wait for the person to approve them.
- Attempts time out and are aborted; items wait longer between tries; an item with no answer for a day stops and asks the person. Claims let several senders share one queue safely.
- `classifyResponse` for HTTP answers, and a flush scheduler with backoff.

### @holdsend/server

- An idempotency store for Postgres (any `query()` driver, including PGlite) and for memory.
- `handleIdempotent`: claim, create and complete in one transaction; replays, `409 key_conflict`, `409 in_progress` and `410 gone`.
- A frozen, versioned request fingerprint (`hs1:`), `forgetOwner` for erasure, and purging.

### @holdsend/web

- `IndexedDbStore`, atomic across tabs and reopened when the browser closes it; `createWebStore` falls back to memory and says so.
- `SenderLock` (Web Locks, with a localStorage lease), `startAutoFlush`, and Background Sync helpers that report honestly what the browser can do.

### @holdsend/react-native

- `KeyValueStore` over AsyncStorage or MMKV, with guards for corrupt data and Android's size limit.
- `startNativeAutoFlush`, wired to NetInfo and AppState by the app.

### Examples and docs

- A notes app as a plain web page, in React and on Android and iOS with Expo, tested in a real browser on every pull request.
- A docs site at https://zyakuhq.github.io/holdsend/.
