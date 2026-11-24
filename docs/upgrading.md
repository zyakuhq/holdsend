# Upgrading

What to change in your code when you move to a new release. Releases before 1.0 may break the API in a minor version; every such break is listed here with the edit it needs. From 1.0 on, breaking changes need a major version ([decision 0012](decisions/0012-api-record.md)), except in parts the changelog marks as outside the promise (the draft helpers may be one, see [decision 0015](decisions/0015-drafts-and-the-1.0-promise.md)).

## 0.2 to 0.3 (not released yet)

### Must change

- **Drafts: three fields of `DraftState` moved under `log`.** This affects you only if you read them from `readDraft` (`@holdsend/core/drafts`) or `readDraftState` (`@holdsend/server`). [Decision 0015](decisions/0015-drafts-and-the-1.0-promise.md).

  | 0.2 | 0.3 |
  | --- | --- |
  | `state.count` | `state.log.count` |
  | `state.repeats` | `state.log.repeats` |
  | `state.dangling` | `state.log.dangling` |

  `conflicted`, `heads`, `latest`, `unresolved` and `ids` did not change. The new type of `state.log` is `DraftLogInfo`, exported from `@holdsend/core/drafts`. TypeScript reports every place to edit.

### Behaves differently (no code edit, but check)

These do not change any type, so TypeScript will not point at them.

- **`postgresSchema()` (`@holdsend/server`) must be sent whole.** The text now holds a `DO` block. If you or a migration tool split it on `;` and send one statement at a time, the split pieces fail. Send the whole string in one `query()` call, or copy it into one migration file. In return, running it at startup no longer locks the table when the column and indexes already exist, and two instances that start at once wait for each other instead of one failing. [Decision 0019](decisions/0019-schema-without-boot-locks.md).
- **`onBackgroundSync` (`@holdsend/web`) also rejects when the device went offline before or during the flush** and sendable items were left. In 0.2 that flush counted as done, so the browser dropped the sync and the items waited for the app's next flush. Now the browser may wake the service worker again, a few times at most. If your worker logs or reports a rejected sync as an error, expect more of them on bad connections. [Decision 0018](decisions/0018-offline-mid-flush.md).
- **`runBackgroundFlush` (`@holdsend/react-native`) returns `waiting` with `retryLater: true`** in the same case, including when the outbox was already offline at the start (0.2 said `done`). If you map the outcome to your background task library's result, check what you do with `waiting`.
- `FlushReport` has a new optional field, `deferredOffline: true`, for that case. If your own code decides whether work remains from a flush report, read it too.

### May change (old code keeps working)

- `AutoFlusher` (`@holdsend/web`) and `NativeAutoFlusher` (`@holdsend/react-native`) are deprecated names for `FlushScheduler` from `@holdsend/core`. The shapes are the same. The old names stay until 2.0.

### New, nothing to change

- `item.lastAttempt` says why an item that left the device has no confirmed outcome yet (`no_answer`, `server_busy`, `refused`). If you wrote your own `Store`, save and return it unchanged, like the other fields the library keeps ([stored item format](protocol.md#the-stored-item-format)).
- `outbox.sendNow(owner)` for a "Send now" button.
- `PoolLike` (`@holdsend/server`) and `Unsubscribe` (`@holdsend/react-native`) are exported, so you can name them.

Saved queues need no migration: 0.3 reads items stored by 0.2.

## 0.1 to 0.2

No changes needed for apps that do not use the new parts (emergency messages, drafts, the Android background flush). See the [changelog](../CHANGELOG.md).
