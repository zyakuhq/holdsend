# Third independent audit, before 0.1.0 (2026-10-26)

Three reviewers who did not write the code each took one part: the core and server API, the web and React Native packages, and everything around them (docs, examples, release workflow, project rules). They worked read-only and proved most findings with scripts or real-browser runs.

The release waits until every "before 0.1.0" item below is fixed or explicitly decided. Each fix lands with a test that fails without it. This table is updated as fixes merge.

## Core and server

| # | Severity | Finding | Before 0.1.0 |
| --- | --- | --- | --- |
| A1 | High | The server stored and replayed any status `create` returned, including 5xx and 403. A temporary failure was then replayed forever and the item could never be delivered. | Yes |
| A2 | Medium | A `policy` option with `undefined` values replaced the defaults with `undefined`, making every claim look stale (double sends, caught only by the server key) or retrying forever. The default retry delays were shared by reference. | Yes |
| A3 | Medium | Public API shape: `approve` and `retry` took their arguments in different orders and returned `null` for two different cases; the low-level state functions were exported and would lock in the state machine; `tombstoneResource` took four positional strings; `MemoryTx` exposed its internals. | Yes |
| A4 | Medium | A stored result could not carry response headers (for example `Location`), and adding them later would need a schema migration for every user. | Yes |
| A5 | Medium-low | A device clock that jumps back could freeze a claimed or delayed item until real time caught up. | Yes (cheap) |
| A6 | Medium-low | An item without an owner was sent by any owner's flush. | Yes |
| A7 | Low | A deeply nested body made fingerprinting overflow the stack (500 instead of 400); a missing body gave a confusing error. | Later |
| A8 | Low | A NUL character in a stored result body makes Postgres reject the completion. | Document |
| A9 | Low | `SendContext.attempt` docs; `waitMs`/`pollMs` not validated; one slow item can hold up a pass; no schema version on stored items. | Partly |

## Web and React Native

| # | Severity | Finding | Before 0.1.0 |
| --- | --- | --- | --- |
| B1 | Medium-high | Where storage is blocked (sandboxed iframes, blocked site data), Web Locks rejected and `SenderLock` never fell back, so nothing was ever sent. | Yes |
| B2 | Medium | `onBackgroundSync` did not understand a flush wrapped in `SenderLock.run`, so the browser dropped syncs with work still waiting. | Yes |
| B3 | Medium | `requestBackgroundSync` and `onBackgroundSync` rejected the real browser types under TypeScript, and their parameter types were not exported. | Yes |
| B4 | Medium | The packages could not be loaded with `require`, which also stops Jest (and so most React Native test setups) from resolving them. | Yes |
| B5 | Medium | `isDurable()` is true in private windows; the docs and the core contract said otherwise. Safari's eviction of unused site data was not mentioned. | Yes (docs and contract) |
| B6 | Medium | `createWebStore` fell back to memory silently on any error, including a transient one or a newer schema, hiding items already on disk. | Yes |
| B7 | Low-medium | The React Native size limit could be passed by growing an item in place. | Yes (cheap) |
| B8 | Low | A corrupt React Native outbox had no documented way out, and the error carried the whole queue. | Partly |
| B9 | Low | The default sender lock name ignores which outbox it is for; test hooks in the public types; `visibilitychange` should be heard on `document`. | Partly |

## Docs, examples and release

| # | Severity | Finding | Before 0.1.0 |
| --- | --- | --- | --- |
| C1 | High | Nothing technically required the project lead's go-ahead before a tag published, and a manual run without "dry run" could publish from any branch. | Yes |
| C2 | High | A release that failed halfway could not be finished by a re-run. | Yes |
| C3 | Medium | The release job ran every dependency's install scripts while holding write permissions. | Yes |
| C4 | Medium | NOTICE was not in the packages, as Apache-2.0 asks. | Yes |
| C5 | Medium | "Exactly once" was stated on the npm page without its condition (the server must keep the keys), and the server snippet people copy left out `requireKey: true`. | Yes |
| C6 | Medium | Status lines ("unreleased", "nothing published yet") would be wrong on release day. | At release |
| C7 | Medium | Some repository notes read as internal working notes. | Yes |
| C8 | Low | Source maps point at files that are not shipped; actions are pinned by tag; a pre-release tag would become `latest`; example servers listen on every interface; small doc errors. | Partly |

One reported item was a false alarm: the reviewer's clone still listed old branches that had already been deleted from GitHub. Only `main` exists on the repository.

## Fixes

Fixes merge in four groups (core and server; web and React Native; release workflow; docs and examples). Each group's pull request lists the finding numbers it closes.
