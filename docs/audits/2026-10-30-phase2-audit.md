# Phase 2 audit (2026-10-30)

Two separate reviewers read the emergency code, the notes example page and worker, and the docs. Each suspected bug was checked by hand before acting.

## Fixed

- (2026-10-31) The SMS hand-off now survives a closed or killed page in the notes example: handed-off messages are kept on the device (localStorage, per person), shown again on the next visit, and can be put back or marked sent. A message that may already have left by data is reported but not kept for undo. New browser test.
- An old message the person ignored made a new first message held. Now only messages that are held or still current count as "another message waiting". New test, checked to fail without the fix.
- The SMS number field folded stray characters into the number. It now accepts only digits, spaces, brackets, dots, dashes and a leading plus, and needs five digits.
- Docs: wrong route name in the protocol page; "Never twice" renamed "One key per message" (the page itself lists cases that can arrive twice); approval is final, now written down; the page no longer says a stale message is "never sent by surprise".

- (2026-11-02) Notes example service worker: cache lookups ignore query strings (new browser test, fails without the fix), a failed cache write cannot break the page, the slow-network timer is cleared, and both pages register the worker before their first await.

- (2026-11-03) Clock and written time: an item whose written time is later than now by more than `staleClaimMs` (the clock was set back after writing) asks first, in every outbox; `EmergencyOutbox.write()` refuses a future `writtenAt`. The fault-injection suite, whose histories include clocks up to two hours fast, now models the person pressing Send on such items. Backdated times: documented that `writtenAt` decides the order of tries, the one-day rule and matching, so apps pass only the real time.
- (2026-11-03) `write()` resets its result flags on every run of `decide`, so a store that retries an update reports the last run; `sameWords` uses Unicode NFKC; the iOS multi-recipient SMS link encodes `+`. Each with a test that fails on the old code.

- (2026-11-03) Four browser tests for the emergency page, each checked to fail on code broken on purpose: the service worker's background sync sends only the first message with every page closed (fired through the browser's own sync event); a message waiting a day asks before it is sent; on a shared browser another person neither sees nor sends someone else's messages; a message that looks like HTML is shown as text in both lists.

## Decided, not changed

- (2026-11-01) Flush order: oldest first, no ordered delivery, by [decision 0008](../decisions/0008-flush-order.md), with a test.
- Approval is final (no second age check). This is intended and now documented.
- (2026-11-03) The SMS hand-off record stays in apps for 0.2. The core is at its size budget, and what an app should keep (text, written time, never the phone number) is written down in the guide with the notes example as a working copy. Revisit before 1.0 if more than one app needs the same code.

## Open for the next session

- iOS link shapes need a test on a real device (the `+` encoding is fixed).
