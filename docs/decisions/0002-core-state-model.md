# 0002: Core state model

Date: 2026-10-25. Status: accepted.

## Context

`@holdsend/core` has to run the same rules on every platform and be testable without a browser or a device. The rules decide when an item may be sent, what a failed attempt means, and what a person may do with an item (cancel, approve, retry, discard).

## Choice

- The rules are **pure functions over an array of items** (`transitions.ts`). They take the time and any new key as arguments and do no I/O.
- An item has four stored states: `waiting`, `sending`, `sent`, `stuck`. What a person sees (`statusOf`) is derived from the state, the clock and two flags: `touched` (an attempt ever started) and `approvedAt`.
- Storage is an interface with one hard rule: `update(fn)` is atomic with respect to every other writer. Platform packages keep that promise with their own locks and transactions.
- Every change runs inside one `update`, so it decides against the queue as it is at that instant.
- A sender takes a random claim token. Only the holder of the current token may record a failure. "Sent" is accepted from anyone.
- An attempt's result is one of five outcomes: `sent`, `retry`, `busy`, `conflict`, `refused`. `classifyResponse` maps HTTP to these.

## Why

- Pure rules are executed by tests, not just read, and the same tests protect every platform.
- Deriving the visible status instead of storing it avoids a whole class of bugs where a stored label goes stale (an item shown as "sending" for months).
- Separating `refused` (the server said no to this request) from `conflict` (the key holds a different request) lets a person retry a refusal with the same key, while a conflict, and only a conflict, gets a new key. That new key is reported (`newKey: true`) because it can publish a second copy if the request under the old key was an earlier version of the same content.

## Amended 2026-10-25 after the first independent audit

- Attempts with no answer (thrown fetch, timeout) no longer count against `maxAttempts`; only answers from the server do.
- Every attempt has a timeout (`attemptTimeoutMs`, default two minutes) and an AbortSignal.
- An item added with a key from an earlier live attempt is marked as possibly sent, so it cannot be cancelled.
- Payloads must be plain JSON and are checked when added.
- `flush` reports `nextCheckInMs` when another sender holds items, and the scheduler looks again then.

## Amended 2026-10-25 after the second audit pass

- Each item waits before its next try (`retryDelaysMs`, from one second growing to five minutes), so a flush asked for again at once, or from a change listener, does not resend it.
- Attempts with no answer still do not count against `maxAttempts`, but they no longer go on forever: after `giveUpAfterMs` (default 24 hours) of nothing but no-answers, the item becomes stuck as `unreachable` and the person decides. Any answer from the server resets that clock.
- Each attempt abandoned at its timeout doubles the next one (up to 16 times `attemptTimeoutMs`), so an upload slower than the timeout can still finish.
- `approve` reports `{ key, newKey }` like `retry`, because approving an item whose key was refused gives it a new key.

## Amended 2026-10-26 after the third audit

- Policy options are merged without letting `undefined` replace a default, and every value is checked (`resolvePolicy`). The result is frozen.
- `approve()` and `retry()` return `{ ok: true, key, newKey }` or `{ ok: false, reason }`, and take their arguments in the same order. The state machine's own functions (claim, settle, renewal) are no longer exported, so they can change without breaking anyone.
- A claim or a backoff stamped while the device clock was ahead no longer freezes an item until real time catches up.
- Items added without an owner are sent only by a flush for no owner, never by a flush for one signed-in person.

## Consequences

- Platform stores must implement a real atomic `update`. A store that loses a write breaks exactly-once on the client side; the server key still prevents duplicates, but cancel and status would be wrong. Each platform package will ship its own concurrency tests.
