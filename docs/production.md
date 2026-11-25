# Before you ship

HoldSend is not 1.0 yet, and its README will not say "ready for production" until the gates at the end of this page are met. This page is the list to work through before you put it in front of real people, package by package. Every item comes from a rule elsewhere in these docs; the link says where.

## The server (`@holdsend/server`)

- [ ] **Every endpoint that creates something uses `handleIdempotent` with `requireKey: true`.** Without it, a request with no `Idempotency-Key` runs with no protection. ([server README](../packages/server/README.md#what-exactly-once-depends-on))
- [ ] **The owner comes from the authenticated session**, never from the request body or a header the client sets.
- [ ] **Records live as long as a client may retry.** Leave `completedTtlMs` unset unless your clients are certain to give up sooner. A phone can stay offline for weeks.
- [ ] **`purgeExpired()` runs on a schedule** (every hour or so), and **`forgetOwner(userId)` runs when an account is erased**.
- [ ] **The stored result is small**, usually `{ id }`. It is replayed for as long as the record lives, so keep personal content out of it.
- [ ] **Postgres in production, not memory.** `MemoryIdempotencyStore` is for tests; it forgets everything on restart.
- [ ] **The written time is shown, never used to order a feed.** Store it in its own column. ([protocol](protocol.md))
- [ ] **CORS allows `Idempotency-Key` and `Written-At` and exposes `Idempotent-Replayed`** when the client runs on another origin.
- [ ] **Your own monitoring counts outcomes.** Every answer from `handleIdempotent` has an `outcome` (`created`, `replayed`, `conflict`, `unkeyed`, `key_required` and a few more). Alert on `unkeyed` and `key_required` (a client sending without keys) and watch `conflict`.

## The browser (`@holdsend/web`)

- [ ] **`createWebStore()` and a check of `isDurable()`.** When it is `false`, tell the person their drafts last only while the tab is open. A private window and Safari's seven-day storage limit cannot be detected; say so in your help pages.
- [ ] **One `SenderLock` name per outbox** if the page has more than one.
- [ ] **Background sending is promised only when `requestBackgroundSync()` returned `"background"`.** Safari, every browser on iOS, and Firefox return `"open_app"`. ([web README](../packages/web/README.md#background-sending-honestly))
- [ ] **The service worker sends only the signed-in person's items**, reading the owner from storage you write at sign-in, and sends nothing when nobody is signed in.

## React Native (`@holdsend/react-native`)

- [ ] **Payloads stay small.** The queue is one stored value and `KeyValueStore` refuses a queue over 1.5 MB. Put photos and files on the file system and queue a reference. ([low-end devices](low-end.md))
- [ ] **Only the app's own JavaScript reads and writes the outbox key.** Nothing coordinates writes from native code or a second JavaScript context.
- [ ] **No screen promises "sent while the app is closed".** iOS gives no reliable way to do it, and the Android background task has not run on a real phone yet.

## Every app

- [ ] **Each item's status is visible to the person**: waiting, sending, needs confirmation, stuck, sent. Use `ItemStatus`, not `ItemState`.
- [ ] **Stuck items offer Try again and Discard**, and a `retry()` that reports `newKey: true` asks before sending, because only that case can publish twice.
- [ ] **Items that need confirmation show when they were written** before the person presses Send.
- [ ] **A custom `Store` keeps the `Store` contract**: each `update` is atomic, it keeps its own copies, and it saves items unchanged. Run it through the checks in [test/store-contract.ts](../test/store-contract.ts) (copy the file; it is not published as a package), and use the built-in stores where you can. ([stored item format](protocol.md#the-stored-item-format))
- [ ] **Emergency messages, if you use them**: the screen says it is not an emergency service and tells people to call their local emergency number first; SMS links are tested on the phones your people use. ([emergency messages](emergency.md))
- [ ] **Drafts on two devices, if you use them**: the API is early. It changed in 0.3 ([upgrading](upgrading.md)), and any further change keeps it outside the 1.0 promise until 1.1 ([decision 0015](decisions/0015-drafts-and-the-1.0-promise.md)). ([drafts](drafts.md))

## What 1.0 needs before the README changes

These are the project's own gates. Each one is tracked in [STATUS.md](STATUS.md).

1. **The API is frozen.** The items of [decision 0013](decisions/0013-api-review-for-1.0.md) are settled ([decision 0015](decisions/0015-drafts-and-the-1.0-promise.md)) and the breaking one is made; `api/*.api.txt` becomes the 1.0 record at the freeze. The migration guide from 0.2 is [upgrading.md](upgrading.md).
2. **Phone features have run on phones.** SMS links on a real iPhone and a real Android phone, and the Android background task on a real phone or an emulator in CI (the emulator part is met by the emulator job in CI, [decision 0016](decisions/0016-android-emulator-ci.md), which forces the job rather than waiting for Android; the SMS links still wait). Until then those features stay outside the 1.0 promise and say so.
3. **A final audit by reviewers who did not write the code**, with every finding fixed or explained, like the four audits in [docs/audits](audits).
4. **Someone other than the project has run it.** At least one app outside this repository has used a release without hitting a bug that loses or duplicates an item.
