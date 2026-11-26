# 0022: Checks for the server store contract

Date: 2026-11-26. Status: accepted.

## Context

`@holdsend/server` ships two idempotency stores, memory and Postgres. Someone on MySQL, SQLite, Redis or DynamoDB has to write a third, and the never-twice promise holds only if that store keeps every rule in `IdempotencyStore` (packages/server/src/types.ts). The rules were tested in `packages/server/test/store-contract.test.ts`, but that file is tied to the two built-in stores (it reads the Postgres table directly) and nothing showed that its tests fail on a store that breaks a rule. [Decision 0021](0021-client-store-contract-checks.md) did the same for the client `Store`.

## Choice

- `test/idempotency-store-contract.ts`: fifteen checks, each a function that takes a harness and throws when the store breaks a rule. The harness makes a new, empty store with a clock the checks control, and writes one row of app data inside the store's transaction, so the checks can see that the record and the row commit or roll back together.
- `test/idempotency-store-contract.test.ts` runs them against `MemoryIdempotencyStore` and `PostgresIdempotencyStore` on PGlite, and against a small store written for the test with nineteen switches, each breaking one rule (a claim that reads then writes, a completion outside the transaction, a commit after the callback threw, a plain `Error` for a lost claim, a tombstone across owners, a 30-day default lifetime, and so on). Each switch must make its named check fail, every check must be failed by at least one switch, and the store with no switch must pass all fifteen.
- The checks require `ClaimLostError` from `@holdsend/server` by class, because `handleIdempotent` recognises a lost claim with `instanceof`.
- The existing server tests stay: they also check what only the built-in stores can show (the Postgres row keeps nothing after a tombstone, the schema).
- As in 0021, the checks stay in the repository, not in a published package; publishing them would add an entry point to freeze at 1.0.

## What the checks do not cover

- Claims from two processes or two servers. The concurrency check runs 25 claims in one process; a store whose atomicity comes from a lock in memory passes it and still fails across servers. production.md says to test that against the real database.
- That a tombstone keeps nothing derived from the request: the checks cannot read a store's storage. The Postgres test checks it for the built-in store.
- Durability across a restart, and behaviour under a database failover.
