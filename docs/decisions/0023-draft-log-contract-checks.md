# 0023: Checks for the draft log contract

Date: 2026-11-27. Status: accepted.

## Context

`@holdsend/server` keeps the updates of a draft in a `DraftLog` (packages/server/src/drafts.ts), with a memory and a Postgres version. Someone on another database writes a third, and `readDraft` is only right if that log keeps the rules: a retry adds nothing, every update keeps a revision above the ones it could have seen, and nothing from another owner or draft shows up. Decisions [0021](0021-client-store-contract-checks.md) and [0022](0022-server-store-contract-checks.md) did the same for the client `Store` and the server `IdempotencyStore`.

## Choice

- `test/draft-log-contract.ts`: ten checks, each a function that takes a harness and throws when the log breaks a rule. The harness makes a new, empty log and gives the transaction of the idempotency store it is used with, since `acceptDraftUpdate` appends inside that transaction.
- The revision rule is written as "each new update gets a revision above every update committed before it", not "revisions follow commit order". That is what `readDraft` needs (a parent must have a lower revision than its child, and a device can only name an update it has seen, so one that committed), and it is what `MemoryDraftLog` keeps: it takes the revision when `append` runs, so two open transactions can commit in the other order. `PostgresDraftLog` keeps the stronger rule with its advisory lock.
- A field that is null, undefined or an empty list counts as absent, as it does for `readDraft`.
- `test/draft-log-contract.test.ts` runs the checks against both built-in logs (Postgres on PGlite) and against a small log written for the test with twenty switches, each breaking one rule. Each switch must make its named check fail with the expected message, every check must be failed by at least one switch, and the log with no switch must pass all ten.
- A payload is compared exactly, so a log that drops a null or an empty list inside it fails; only the update's own optional fields count as absent when empty.
- `concurrentTransactions` is required in the harness, so a copied harness skips the before-commit check only on purpose.
- `test/contracts-real-postgres.test.ts` runs both sets of server checks through node-postgres on a real database in CI's `postgres` job, so the fix is checked with that driver too, and the before-commit check runs on Postgres. The idempotency check that a takeover between completion and commit is refused does not run there: the takeover waits for the row lock the open completion holds, which is the safe outcome, so the check cannot finish in one process.
- Reviewed by a separate agent before merge. Its findings are fixed: empty values inside a payload were hidden by the comparison, a copied harness could skip a check silently, the fix was not checked with node-postgres, and the concurrency and rollback checks did not state what they expect of a database or a harness.
- As in 0021 and 0022, the checks stay in the repository, not in a published package.

## What the checks found

The Postgres draft log changed a payload that was a string whose text looks like JSON: `"42"` came back as the number 42, and `"null"` came back as no payload. `fromRow` parsed any string it got from the driver, to cover drivers that return JSONB as text, so it could not tell a string value from JSON text. `PostgresIdempotencyStore` did the same with a replayed body. Both now select their JSONB columns with `::text` and always parse, so every driver returns the JSON itself. A string case was added to the idempotency store's replay check too; both cases fail on the old code. Object and array values were never affected.

## What the checks do not cover

- Appends from two processes or two servers at once. The concurrency check runs 25 transactions in one process.
- A log on a database that aborts one of two conflicting transactions (SERIALIZABLE, CockroachDB) fails the concurrency check unless it retries by itself. That is meant: `acceptDraftUpdate` does not retry, so the device would only send again later.
- The same id appended twice at the same time. `acceptDraftUpdate` never does that, because the idempotency claim lets only one request with a key run; a log used without it must handle it itself.
