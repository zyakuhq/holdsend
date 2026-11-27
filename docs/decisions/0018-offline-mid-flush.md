# 0018: A flush that stopped offline says so

Date: 2026-11-19. Status: accepted.

## Context

Reported, with tests and a first fix, by an outside contributor in pull request [#81](https://github.com/zyakuhq/holdsend/pull/81).

A pass stops when `isOnline()` says offline, before the first item or between two items. The items it did not reach stay in the store, but nothing in `FlushReport` said so: `retry`, `busy` and `nextCheckInMs` were all empty. So `onBackgroundSync` in `@holdsend/web` resolved the sync event and the browser dropped the sync, and `runBackgroundFlush` in `@holdsend/react-native` answered `done`. Nothing was lost or sent twice, but the items waited until the app flushed on its own. Two of the contributor's tests failed on `main`, which confirmed the bug.

## Choice

- `FlushReport` gets an optional `deferredOffline: true`. A pass sets it when it stopped offline and, in the same store update that already ends every pass, at least one item is still sendable for that pass's owner (the same rule a flush uses to pick items, so items held for a person, items in their retry delay, stuck items and other owners' items do not count). At the end of the whole flush, the store is read again for those owners. The total is set only if sendable items remain after any queued passes.
- `onBackgroundSync` treats it as work left and rejects, so the browser may wake the worker again (its own retry limit still applies).
- `runBackgroundFlush` treats it as `waiting` with `retryLater: true`. Before, an outbox that was offline at the start gave `done`.
- The field is optional, so code that builds or reads `FlushReport` keeps working.

## Concurrency and failures

The final read also checks for a flush queued while it was pending. That pass runs before the shared promise resolves, and the final read is repeated if needed. A failed read rejects the flush so the caller can retry later.

## Limits

Rejecting a sync event asks the browser to try again; it does not make it. Browsers retry a few times and then drop the sync, so apps still register again when they open or come back online. On React Native, `expo-background-task` ignores the result (decision 0010); `retryLater` helps only libraries that act on it.
