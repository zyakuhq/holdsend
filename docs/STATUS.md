# Status

The project's working memory. Every work session reads this first and updates it last.

Last updated: 2026-10-25

## Done

- Read the reference design and wrote [reference-notes.md](reference-notes.md) in our own words.
- Chose the name HoldSend and the Apache-2.0 licence ([0001](decisions/0001-name-and-licence.md)).
- Monorepo set up: npm workspaces, strict TypeScript, ESM, ESLint, Vitest.
- `@holdsend/core` v0: outbox state machine, keys, written-time bounds, wire protocol, `Outbox` runtime and `MemoryStore`. 57 tests, including lost answers, two senders on one store, stale claims, old items and cancel rules. 3.2 KB min+gzip, no runtime dependencies.
- Governance files: LICENSE, NOTICE, README, CONTRIBUTING, CODE_OF_CONDUCT, SECURITY, GOVERNANCE.
- CI: lint, typecheck, tests, build, size budget, gitleaks on full history, PII scan with a hashed denylist. Local pre-push hook runs the same scans.
- Decisions 0002 (core state model) and 0003 (written time in a header).

## In progress

- Publishing the repository: waiting for `zyakuhq/holdsend` to be created (the automation account cannot create repositories in the organisation).

## Next three tasks

1. Push to `zyakuhq/holdsend` once it exists, confirm CI is green, turn on private vulnerability reporting.
2. `@holdsend/server`: in-memory idempotency store with the full contract (claim, complete in one transaction, replay, conflict, in progress, gone), then the Postgres adapter.
3. `@holdsend/web`: IndexedDB store with an atomic `update` and the cross-tab lock (Web Locks, with a lease fallback), with concurrency tests.

## Blockers

- The repository `zyakuhq/holdsend` must be created by an organisation admin (empty, public, no README or licence), and this automation given push access to it.

## Resolved

- 2026-10-25: security@zyaku.com receives mail (confirmed by the project lead).

## Notes for the next session

- Never put Zyaku code, data, names or configuration in this repository. Run `npm run check` and the pre-push hook before every push.
- Repository secret `PII_DENYLIST` (comma-separated plaintext terms) can extend the denylist in CI without publishing it.
