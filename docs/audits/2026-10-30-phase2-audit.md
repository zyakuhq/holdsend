# Phase 2 audit (2026-10-30)

Two separate reviewers read the emergency code, the notes example page and worker, and the docs. Each suspected bug was checked by hand before acting.

## Fixed

- An old message the person ignored made a new first message held. Now only messages that are held or still current count as "another message waiting". New test, checked to fail without the fix.
- The SMS number field folded stray characters into the number. It now accepts only digits, spaces, brackets, dots, dashes and a leading plus, and needs five digits.
- Docs: wrong route name in the protocol page; "Never twice" renamed "One key per message" (the page itself lists cases that can arrive twice); approval is final, now written down; the page no longer says a stale message is "never sent by surprise".

## Decided, not changed

- Approval is final (no second age check). This is intended and now documented.

## Open for the next session

- SMS hand-off keeps the text only in memory after the item is cancelled; a killed tab loses it. Needs a persisted "handed off" state.
- A flush pass may send a later message after an earlier one got a retry (order is not guaranteed). Needs an ordered mode or documentation.
- A backdated `writtenAt` can reorder messages; a fast device clock shifts the one-day rule.
- iOS multi-recipient SMS link leaves `+` unencoded; iOS link shapes need a real-device test.
- Service worker cache: ignore query strings, handle rejections, clear the timer. Register the worker before the first network await.
- Closure flags in `write()` should be reset if a store retries `decide`; normalise Unicode in `sameWords`.
- Missing browser tests: worker background path, one-day rule in the browser, another owner's messages, HTML text rendered as text.
