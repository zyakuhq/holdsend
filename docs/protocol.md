# The HoldSend wire protocol

A short contract between a client that queues writes and a server that stores them. Any server can implement it; `@holdsend/server` will be a reference implementation.

## Request

Every attempt for one item carries the same two headers:

```
Idempotency-Key: example-item-0001
Written-At: 2026-10-25T08:15:00.000Z
```

- `Idempotency-Key`: 8 to 128 characters of letters, digits, `_`, `-`, `:` or `.`. One per item, the same on every attempt.
- `Written-At`: when the person wrote it, ISO 8601 with a zone. Optional; apps leave it out for content whose writing time is sensitive.

The body is whatever the app sends. HoldSend adds nothing to it.

## What the server does

1. Scope the key to the authenticated person and the operation: the record is unique on (person, operation, key).
2. Claim the key with an insert that cannot succeed twice (a unique index).
3. Create the resource and mark the key's record complete **in the same transaction**, storing a hash of the request body.
4. On a later request with the same key:
   - same body hash, completed: return the original result (`2xx`, optionally `Idempotent-Replayed: true`);
   - different body hash: `409` with code `key_conflict`;
   - still being processed: `409` with code `in_progress`;
   - created and deleted since: `410` with code `gone`.
5. If `Written-At` is present and a key is present, keep it only within bounds (see below), in a separate field from the arrival time. Any client can send it: it is the author's claim, never a fact the server checked.
6. A different request under a key whose claim is unfinished is a conflict too, even if that claim is old: the original request may still be retried.
7. Only a successful (2xx) answer is stored and replayed. Any other answer is rolled back and the key freed, so the client's retry runs again; replaying a temporary failure forever would mean the item is never delivered.

Records for content that can wait long in a queue should live as long as the content, not a fixed number of days: a retry can arrive weeks later.

## Emergency messages

The server side of [emergency messages](emergency.md) is the ordinary protocol with three choices. The notes example's `/api/emergency-messages` route is the reference (its sign-in is a demo header that anyone can forge; take the owner from your own session).

- **Require the key.** Call `handleIdempotent` with `requireKey: true`. A message without a key cannot be told apart from its own retry, so it is refused instead of risking two copies.
- **Keep records as long as a phone may retry.** A message written with no signal can wait a long time before its last attempt. Set `completedTtlMs` at least as long as the longest wait you allow, so a late retry gets the original answer instead of creating a second message. The client stops sending a message after a day without an answer and asks the person first, but a person can approve it later. Approval is final: once approved, a message is sent without asking again, however long it waits.
- **Keep the written time apart from the arrival time.** `Written-At` is the sender's claim, kept within the bounds below. Show both to whoever reads the message, and never order by the written time.

The server never promises that a message was read by anyone. It promises only that it was stored once.

## The request fingerprint

`@holdsend/server` stores a fingerprint of each request, so a reused key with different content can be told apart. The format is frozen, because stored fingerprints must keep matching for as long as their records live:

```
hs1:<hex SHA-256 of UTF-8 "<operation length>:<operation>|<canonical JSON>">
```

Canonical JSON is the content with object keys sorted at every level and properties whose value is `undefined` left out, serialised with `JSON.stringify`. Only plain JSON is accepted. Any future change to this format gets a new tag (`hs2:` and so on), and stores keep accepting the old tag for records written with it.

## Response codes the client understands

| Answer | Meaning for the item |
| --- | --- |
| `2xx` | Sent. Removed from the outbox. |
| `410` + `gone` | Sent once and deleted since. Never sent again. |
| `409` + `key_conflict` | Final for this key. Stuck; a person's retry gets a new key. |
| `409` + `in_progress` | An earlier attempt is still running. Try later; this attempt does not count. |
| `401`, `403`, `408`, `425`, `429`, `5xx`, no answer | No definite answer. Try later with the same key. |
| Other `4xx` | Refused. Stuck; a person's retry keeps the key. |

The error code is read from a JSON body field `code`. Clients pass it to `classifyResponse(status, code)`.

## Browsers

A browser client on another origin needs CORS to allow `Idempotency-Key` and `Written-At` (`Access-Control-Allow-Headers`) and to expose `Idempotent-Replayed` (`Access-Control-Expose-Headers`).

## Written time bounds

`acceptWrittenAt(raw, now)` in `@holdsend/core`:

- must be ISO 8601 with a zone, at most 40 characters;
- more than two minutes in the future: ignored;
- within two minutes in the future: clamped to now;
- more than 30 days in the past: ignored.

A bad value never fails the request. The item is stored without a written time.

**Order feeds by arrival time. Never by written time.** The written time comes from a device clock nobody can check.

## The stored item format

What a `Store` keeps on the device is a JSON array of `OutboxItem` objects (see `packages/core/src/types.ts`). A custom store must save each item exactly as it gets it and return it unchanged: no field renamed, dropped or converted. Order is not kept: a store may return items in any order. The checks in [test/store-contract.ts](../test/store-contract.ts) test a store against these rules.

| Field | Set by | Meaning |
| --- | --- | --- |
| `key`, `kind`, `payload`, `owner`, `writtenAt` | the app, through `add()` | What to send, for whom, and when it was written. `payload` is plain JSON. |
| `held`, `askBy` | the app, through `add()` options | The item waits for a person, or asks after a time. |
| `state`, `attempts`, `stuckReason`, `lastError`, `lastAttempt`, `sentAt`, `approvedAt`, `retryAt` | the library | Where the item is and why. Read them; do not write them. |
| `touched`, `claimedAt`, `claimToken`, `failures`, `noAnswerSince`, `timeouts` | the library | Bookkeeping for claims, retries and timeouts. Never set or change them. |

### Why the last attempt did not finish

`lastAttempt` says why an item that has left the device has no confirmed outcome yet. It is stored from the item's last attempt, for display only: the outbox never reads it to decide whether to send.

| Value | What happened | What the person can be told |
| --- | --- | --- |
| `"no_answer"` | No HTTP answer: the network failed, the attempt timed out, or a sender died in the middle (another sender took the item over). | It may already be on the server. The next try uses the same key, so the server answers with the original instead of creating a second copy. |
| `"server_busy"` | The server answered "not now": 408, 429 or 5xx (also 401, 403 and 425, which may change by themselves, and 409 `in_progress` while the server is still working on this key). | It is retried automatically, with growing waits. |
| `"refused"` | The server refused the request: any other 4xx, or 409 `key_conflict` (the key holds different content). | Sending the same request again will not help. The item is stuck until a person retries or discards it. |

"No connection" is not a value: it is the device's state right now, not something about the item, so read it from the platform when you draw the screen. `lastAttempt` is cleared when the item is delivered and when a person retries or approves it.

One case has no value: a sender that died during the item's last allowed attempt. Nothing takes the item over, so nothing records the lost answer. `statusOf` shows it as `stuck` while its `state` is still `"sending"`; tell the person what `"no_answer"` says, because it may already be on the server.

`outbox.sendNow(owner)` is the person's "Send now": one pass over the same queue, with the same items and the same keys, without waiting for the backoff of earlier failures. Items that wait for a person (stuck, or needing confirmation) still need `retry()` or `approve()`.

Promise for 1.x: a 1.x release only adds optional fields to this format and never renames or removes one, so a queue saved by any 1.x version is read correctly by every later 1.x version. A change that needs a migration of saved queues waits for 2.0 and comes with that migration.
