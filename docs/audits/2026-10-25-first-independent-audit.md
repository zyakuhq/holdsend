# First independent audit, 25 October 2026

A separate reviewer, who had not written the code, audited the whole repository: correctness against HoldSend's promises, security, test quality, honesty of the docs, and the clean-room rule. Fourteen findings were proved with throwaway tests before being reported. All findings below are fixed unless marked otherwise. Each fix has a regression test that was run against the code before the fix and failed there.

## Findings and what changed

| # | Severity | Finding | Fix |
| --- | --- | --- | --- |
| 1 | High | A request that never settles held its item, and every later flush, forever | Every attempt has a timeout (`attemptTimeoutMs`, default 2 min) and an `AbortSignal` |
| 2 | High | Cancel could report "cancelled" for an item queued with the key of a live attempt that may have reached the server | Such items start as possibly sent and cannot be cancelled |
| 3 | Medium-high | On a network that looks connected but is not, items became stuck within about 2 minutes and were not sent when the connection returned | Attempts with no answer do not use up the attempt budget |
| 4 | Medium | A claim left by a tab killed mid-send was not looked at again without an outside event | `flush` reports `nextCheckInMs`; the scheduler looks again then |
| 5 | Medium | Docs claimed a new key after a key conflict cannot duplicate | `retry` reports `newKey: true`; docs say a second copy is possible and to ask first |
| 6 | Medium | The service-worker helper told the browser a sync was done when items were still waiting | It rejects, so the browser tries again |
| 7 | Medium | Flushes requested for several owners during a flush dropped all but the last | Queued per owner; all run |
| 8 | Medium | The IndexedDB store never recovered a connection the browser closed | It reopens once and carries on |
| 9 | Medium | The Postgres store failed with drivers that report no row count | Every changing statement uses `RETURNING` |
| 10 | Medium | Server records kept personal data forever with no way to erase it | `forgetOwner()`; docs say to keep stored results small |
| 11 | Medium | A large queue could exceed what Android's AsyncStorage can read back, locking the person out | Writes over 1.5 MB are refused with `OutboxTooLargeError`; nothing is lost |
| 12 | Medium | Clean room: a few small fragments were token-identical to the private reference implementation | See below |
| 13 | Low-medium | A company email address appears as the author of earlier merge commits | Merges now keep the noreply author; CI fails a pull request whose commits use a company address. The existing history is unchanged (see below) |
| 14 | Low | The PII scanner spelled out an internal log path in plain text | Moved into the hashed denylist; the hosting list is now generic |
| 15 | Low | Approving an old item whose key was refused resent it with the same key | It gets a new key |
| 16 | Low | `Map`, `Set` and other non-JSON values were stored and hashed as `{}` | Refused when added and when hashed |
| 17 | Low | Different content could take over a stale claim | It is a conflict |
| 18 | Low | Waiting for an in-progress duplicate polled every 50 ms | Doubling backoff up to 500 ms |
| 19 | Low | Long table names made index names collide | Index names come from a short hash of the table name |
| 20 | Low | Stale or overclaiming docs | README, STATUS, protocol and package docs updated (CORS, purge scheduling, written time is the author's claim) |
| 21 | Test gaps | The fault-injection suite never queued after a live attempt; Postgres races were tested on a single connection only | Added the live-attempt step (reverting fix 2 now fails the suite); CI now runs race tests against a real Postgres 16 server with ten connections |

## Clean room (finding 12), in plain words

The project's rule is that HoldSend is written from scratch and copies nothing from Zyaku's private code. The reference was read to understand its behaviour, and the code was written afterwards without copying files. Even so, the audit found that a few small pieces written from memory came out token-for-token the same as the reference: the type names and part of the body of the cross-tab lock, the shape of a canonical-JSON helper, and the regular expression and checks for parsing the written time, plus three function names. These were small and generic, but they broke the rule, so all of them were rewritten independently with different structure and names: `SenderLock` (new types, result shape, lease format and implementation), `canonicalJson` and `hashRequest`, the written-time parser, and the helpers now called `parseIdempotencyKey` and `writtenAtFromRequest`. Nothing else showed meaningful overlap.

## Not changed, and why

- Earlier merge commits carry a company email address as author. Removing it means rewriting published history, which is the project lead's decision.
- Two tabs can both win the localStorage lease in a rare race on browsers without Web Locks. Claims and the server key make this safe; it only costs a duplicate request.

## Second pass (same day)

A second independent pass checked every fix above: 14 confirmed fixed, 6 partly fixed, and 1 left unchanged by decision (the earlier commit emails). It also found nine new issues. All nine are now fixed or documented, each with a test that fails on the code before its fix.

| # | Severity | Finding | Fix |
| --- | --- | --- | --- |
| N1 | Medium-high | Attempts with no answer retried forever with no sign to the person, and an upload slower than the timeout was abandoned and restarted forever | Per-item retry delays; after 24 hours of no answers the item is stuck as `unreachable`; each timed-out attempt doubles the next timeout |
| N2 | Medium | Near the React Native size limit, even updates that send or remove items were refused, so a full outbox could never drain | Only updates that add items are refused for size |
| N3 | Medium | A flush asked for in the moment a running flush finished could be dropped | Finishing and checking the queue happen in one synchronous step |
| N4 | Medium | A `send` function that threw before returning a promise broke the flush | Treated as no answer |
| N5 | Medium | Calling `flush` from a change listener resent a failing item in a tight loop | Per-item retry delays (see N1) |
| N6 | Low | The Background Sync docs did not say the browser gives up after a few tries | Docs explain `lastChance` and registering again from the page |
| N7 | Low | The request fingerprint format was not fixed, so a later change would turn every stored record into a conflict | Versioned (`hs1:`), frozen and documented, with a fixed test vector |
| N8 | Low | A late close event from an old IndexedDB connection could drop the newer one | Only the connection that closed is forgotten |
| N9 | Low | `approve` changed an item's key without saying so | It returns `{ key, newKey }` |

Also from the second pass: a sentence in the reference notes overstated what a key conflict proves (corrected), and claim renewal during a long attempt had no test (added, with fake timers).

