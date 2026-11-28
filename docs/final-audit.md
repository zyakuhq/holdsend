# Brief for the final audit before 1.0

This is the third of the four gates in [Before you ship](production.md#what-10-needs-before-the-readme-changes). It is written now so the audit can start on the day 0.3.0 is tagged. The people who run it must not have written the code they review. An agent counts as a reviewer only if it did not write that code.

The audit reads the code at the 0.3.0 tag, plus whatever lands on `main` before the freeze. Anything that changes a package after the audit starts is read again before 1.0.

## What 1.0 promises

The audit tries to break these promises. Each one is a sentence in the README's table, a rule in [protocol.md](protocol.md), or a contract in the API record.

1. **Never lost.** An item that was added and not cancelled or discarded stays in the store until the server confirms it, through reloads, force-closes, crashes during a storage write, and a second tab or sender. This holds only where storage is durable: when `isDurable()` is `false` (some private browsing modes), the app is told so it can warn the person.
2. **Never twice.** An item is created on the server at most once, whatever happens to requests and answers on the way, how many senders flush at once, and how often the person presses Try again. The documented exceptions: `retry()` or `approve()` reporting `newKey: true` (an item whose key the server refused as a conflict), which the app must ask about first; and a server whose `completedTtlMs` drops a record before the client's last retry.
3. **Cancel is safe.** `cancel()` works only while the item has never left the device.
4. **Written time is honest.** The written time travels with the item and reaches the app's `create` apart from arrival time. On the server, `acceptWrittenAt` ignores a time more than two minutes ahead or more than 30 days back and clamps one up to two minutes ahead to now, and a bad value never fails the request ([protocol](protocol.md#written-time-bounds)). On the device, an item whose written time is in the future asks the person first. Ordering feeds by arrival is the app's job; the docs tell it to.
5. **Old items ask first.** An item older than `confirmAfterMs` (30 days by default, one day in `EmergencyOutbox`), or older than its own `askAfterMs`, which can only make it ask sooner, waits for `approve()`. It then goes with its same key, unless the server had refused that key as a conflict (see 2).
6. **The server store keeps its contract.** One claim wins; the record and the app's row commit in one transaction; a lost claim throws `ClaimLostError`; tombstones, purging and `forgetOwner` touch only what they should.
7. **The platform stores keep the `Store` contract**: each `update` is atomic, they keep their own copies, and items come back unchanged.
8. **Honest limits.** Nothing says an item was or will be sent in the background when the platform gives no such promise (`requestBackgroundSync()` returning `"open_app"`, iOS, the React Native background task).

Drafts on two devices join the promise only if both conditions of [decision 0015](decisions/0015-drafts-and-the-1.0-promise.md) hold at the freeze: the drafts API has not changed since 0.3.0, and this audit covers the drafts code and finds nothing that needs an API change. The audit report says which way the second went.

SMS links stay outside the promise until they have run on a real iPhone and a real Android phone (gate 2).

## What to read

| Area | Files | About |
| --- | --- | --- |
| Core | `packages/core/src` | Outbox state machine, claims, keys, written time, protocol, flush scheduler, emergency outbox, drafts. About 1,900 lines. |
| Server | `packages/server/src` | `handleIdempotent`, memory and Postgres stores, request fingerprint, schema, draft helpers and logs. About 1,300 lines. |
| Web | `packages/web/src` | IndexedDB store, `SenderLock`, auto-flush, Background Sync helpers. About 650 lines. |
| React Native | `packages/react-native/src` | `KeyValueStore`, native auto-flush, `runBackgroundFlush`. About 350 lines. |
| Public API | `api/*.api.txt` | What 1.0 freezes. Every exported name, and whether each one should exist. |
| Docs that make promises | `README.md`, `packages/*/README.md`, `docs/protocol.md`, `docs/production.md`, `docs/emergency.md`, `docs/drafts.md`, `docs/low-end.md`, `docs/upgrading.md` | Every promise must match the code. A promise the code does not keep is a finding. |
| What gets published | `scripts/check-packages.mjs`, `scripts/smoke-packed.mjs`, [decision 0020](decisions/0020-smoke-test-the-tarballs.md) | Only build output, README and licence files are published, and the packed tarballs install and load. |
| Contract checks | `test/store-contract.ts`, `test/idempotency-store-contract.ts`, `test/draft-log-contract.ts` | Apps copy these to test their own stores, so a check that passes a broken store is a finding. |

The examples (`examples/`) are not in the 1.0 promise, but a pattern there that apps will copy and that loses or doubles an item is a finding.

Earlier audits are in [docs/audits](audits). Their findings have regression tests (`audit-regressions`, `second-audit-regressions`, `third-audit-regressions` and `review-2026-10-27` test files under `packages/*/test`, and the tests named in each write-up). Reading them first saves time; finding the same bug again means a fix did not hold, which matters more than a new bug.

## Where to look hardest

These are the places past reviews found bugs, or where the reasoning is subtle.

- **Claims and takeover.** A sender that dies mid-attempt, a claim that expires while the first sender is still waiting for its answer, and the order in which `settle` and a takeover can run.
- **The Postgres transaction.** Claim, app work and completion in one transaction; what happens when the connection drops between them; the advisory lock in `PostgresDraftLog`; `postgresSchema()` with long transactions open.
- **Answers from the server.** `classifyResponse` and the status table in [protocol.md](protocol.md#response-codes-the-client-understands): a wrong mapping retries what must not be retried, or gives up on what must. The `hs1:` request fingerprint (`packages/server/src/hash.ts`) decides whether a retry is the same request.
- **JSON round trips.** Values that look like other values (the 2026-11-27 fix: a string `"42"` came back as a number). Every place that reads a stored value back.
- **Clocks.** A device clock ahead of or behind the server, set back after writing, and the 30-day rule across that.
- **Storage that fails or lies.** An IndexedDB connection closed by the browser, quota errors, a private window, AsyncStorage values that are cut off or not JSON, a queue near the 1.5 MB limit.
- **Offline in the middle of a flush**, `deferredOffline`, and what Background Sync and `runBackgroundFlush` report then ([decision 0018](decisions/0018-offline-mid-flush.md)).
- **Emergency messages.** Repeated taps as one message, the first message going by itself, the SMS hand-off and putting an item back.
- **Drafts.** Two devices editing one draft, conflicts, retries of the same update, and an update that names a parent the server never saw.

## How to run everything

```sh
npm ci
npm run check            # lint, build, types, tests, size, API record, packages, PII, secrets, commits
npm run test:soak -- --testTimeout=600000   # never-twice suite, 3000 histories (1000 for the slow-store case)
npm run e2e              # browser tests of the three examples (needs Chromium)
HOLDSEND_PG_URL=postgres://... npx vitest run --no-file-parallelism \
  packages/server/test/real-postgres.test.ts \
  packages/server/test/drafts-real-postgres.test.ts \
  packages/server/test/schema-locks-real-postgres.test.ts \
  test/contracts-real-postgres.test.ts
```

The real Postgres tests need an empty database the tests may write to. CI runs them on Postgres 16 in the `postgres` job. The soak run needs the longer timeout: the default of 30 seconds is too short for the slow-store case. The Android background task runs only in the Android emulator workflow (`.github/workflows/android.yml`).

A reviewer who finds a bug writes a test that fails on the code as it is. The fix lands with that test.

## How to report

One write-up in `docs/audits/`, named by date, in the same shape as the earlier ones:

| # | Finding | Kind | What we did |
| --- | --- | --- | --- |

- **Kind** is one of: loses an item, sends twice, wrong state shown, docs promise too much, API (would change a frozen name or type), weak test, other.
- Anything that loses or doubles an item blocks 1.0 until it is fixed and its test passes.
- An API finding is fixed before the freeze or written down as a decision; for drafts, any API finding keeps drafts outside the promise until 1.1.
- Everything else is fixed or explained in the write-up before 1.0.
- A section "Checked and found correct" lists what was read and held up, so the next reader knows what was covered.

The audit is closed when every finding has a row in "What we did" and `main` is green.
