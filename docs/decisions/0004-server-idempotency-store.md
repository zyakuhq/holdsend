# 0004: Server idempotency store

Date: 2026-10-25. Status: accepted.

## Context

Exactly-once publishing needs the server: a client can only promise one key per item. The server has to turn every arrival of that key into one write, including arrivals that race each other, arrive while the first is still running, or arrive weeks later.

## Choice

- A record per (owner, operation, key), where owner is the authenticated identity. Keys are never global.
- The claim is a short statement of its own (insert, or read what is there). The write and the completion of the record happen in one transaction, and completion is guarded by the claim token. The claim is not held open across the write.
- A claim not finished within `staleClaimMs` (default five minutes) can be taken over. This is safe because the dead owner never committed: its completion would fail on the token and roll its write back.
- Completed records are kept forever by default. A TTL is available for operations whose retries cannot arrive late.
- Deleting a resource turns its record into a tombstone that answers `410 gone`. The tombstone keeps no request hash and no result.
- The request fingerprint has a versioned, frozen format (`hs1:` plus a SHA-256), written down in [protocol.md](../protocol.md). Changing it would make every stored record look like a conflict, so a change means a new tag, never an edit. (Added 2026-10-25 after the second audit pass.)
- Stores share one interface and one contract test suite. Postgres is tested against a real Postgres engine (PGlite), not a mock.
- No runtime dependency on a database driver: anything with `query(text, params)` works.

- Only 2xx results are stored and replayed (added 2026-10-26 after the third audit). A failed `create` is answered, rolled back and its key freed, so a temporary failure is not replayed forever. Stored results may carry response headers, kept in their own column. `tombstoneResource` takes `{ owner, operation, resourceRef }`.

## Why

- Holding a transaction open across a slow write (uploads, moderation) lets a burst of slow requests exhaust a connection pool. A claim row serialises duplicates just as well.
- Making completion part of the write's transaction means a committed write always has a completed record, so no retry can create a second copy, and a failed write never leaves a record claiming it succeeded.
- Content written offline can wait weeks; a record with a short expiry would let a late retry create a duplicate.

## Consequences

- Apps must pass the transaction client (`tx`) to their own writes. A write made outside `tx` is not covered.
- `staleClaimMs` must be longer than the slowest write. A write slower than that may be taken over; it then fails safely (rolls back) and the client's retry is answered with the other write.
