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
- Separating `refused` (the server said no to this request) from `conflict` (the key holds a different request) lets a person retry a refusal with the same key, while a conflict, and only a conflict, gets a new key.

## Consequences

- Platform stores must implement a real atomic `update`. A store that loses a write breaks exactly-once on the client side; the server key still prevents duplicates, but cancel and status would be wrong. Each platform package will ship its own concurrency tests.
