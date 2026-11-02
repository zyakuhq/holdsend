# Phase 2 audit (2026-10-30)

Two separate reviewers read the emergency code, the notes example page and worker, and the docs. Each suspected bug was checked by hand before acting.

## Fixed

- (2026-10-31) The SMS hand-off now survives a closed or killed page in the notes example: handed-off messages are kept on the device (localStorage, per person), shown again on the next visit, and can be put back or marked sent. A message that may already have left by data is reported but not kept for undo. New browser test.
- An old message the person ignored made a new first message held. Now only messages that are held or still current count as "another message waiting". New test, checked to fail without the fix.
- The SMS number field folded stray characters into the number. It now accepts only digits, spaces, brackets, dots, dashes and a leading plus, and needs five digits.
- Docs: wrong route name in the protocol page; "Never twice" renamed "One key per message" (the page itself lists cases that can arrive twice); approval is final, now written down; the page no longer says a stale message is "never sent by surprise".

- (2026-11-02) Notes example service worker: cache lookups ignore query strings (new browser test, fails without the fix), a failed cache write cannot break the page, the slow-network timer is cleared, and both pages register the worker before their first await.

## Decided, not changed

- (2026-11-01) Flush order: oldest first, no ordered delivery, by [decision 0008](../decisions/0008-flush-order.md), with a test.
- Approval is final (no second age check). This is intended and now documented.

## Open for the next session

- The hand-off record lives in the example app, not the library; apps need their own. Moving a "handed off" state into the core is not decided.
- A backdated `writtenAt` can reorder messages; a fast device clock shifts the one-day rule.
- iOS multi-recipient SMS link leaves `+` unencoded; iOS link shapes need a real-device test.
- Closure flags in `write()` should be reset if a store retries `decide`; normalise Unicode in `sameWords`.
- Missing browser tests: worker background path, one-day rule in the browser, another owner's messages, HTML text rendered as text.
