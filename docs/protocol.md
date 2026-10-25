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

Records for content that can wait long in a queue should live as long as the content, not a fixed number of days: a retry can arrive weeks later.

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
