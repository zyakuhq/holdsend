# Status

The project's working memory. Every work session reads this first and updates it last.

Last updated: 2026-10-25 (evening of day one)

## Done

- Reference design read and written up in our own words ([reference-notes.md](reference-notes.md)).
- Name, licence, governance files, CI (lint, build, types, tests, size budgets, gitleaks, PII scan with hashed denylist, company-email check on PR commits, real Postgres race tests).
- `@holdsend/core`: outbox rules, `Outbox` runtime with attempt timeouts and abort signals, keys, written-time bounds, protocol, JSON payload checks, flush scheduler.
- `@holdsend/server`: idempotency store for memory and Postgres (any `query()` driver), `handleIdempotent`, tombstones, `forgetOwner`, purge.
- `@holdsend/web`: IndexedDB store (atomic across tabs, reopens closed connections), `SenderLock`, auto-flush, honest Background Sync helpers.
- `@holdsend/react-native`: `KeyValueStore` over AsyncStorage or MMKV (shared update chain, corrupt-data and size guards), native auto-flush.
- Never-twice, never-lost fault-injection suite (fast-check), checked against deliberately broken code ([testing.md](testing.md)).
- First independent audit: 21 findings, all fixed or explained, each with a regression test ([audits/2026-10-25-first-independent-audit.md](audits/2026-10-25-first-independent-audit.md)).
- Decisions 0001 to 0006.

## In progress

- Nothing open.

## Next three tasks

1. Examples: a vanilla web page, a React app and an Express + Postgres server, wired end to end, plus a demo that works in airplane mode.
2. A 30-second quick start in the README and a small docs site (GitHub Pages, plain Markdown).
3. Prepare v0.1.0: CHANGELOG, issue templates, "good first issue" labels, package metadata. Publishing to npm needs the `@holdsend` npm organisation and credentials from the project lead.

## After that

- Emergency module: dedupe, written time, background sending where possible, SMS hand-off, honest platform limits.
- Conflict handling for one draft edited on two devices (append-only updates with a reason). This is the hard part; say so.
- An Android background task for React Native.

## Blockers

- None now. At v0.1.0: npm organisation `@holdsend` and publish credentials.

## Resolved

- 2026-10-25: security@zyaku.com receives mail (confirmed by the project lead).
- 2026-10-25: `zyakuhq/holdsend` created by the project lead; this automation has push access.
- 2026-10-25: private vulnerability reporting is enabled on the repository (confirmed by the project lead).

## Open questions for the project lead

- Five early merge commits list a company email address as author. Removing it needs a history rewrite of a public repository; that is the project lead's call. New merges keep the noreply address, and CI blocks company addresses in pull requests.

## Notes for the next session

- Never put Zyaku code, data, names or configuration in this repository. Write everything fresh; do not write reference code from memory either (see the audit's clean-room note). Run `npm run check` and gitleaks before every push.
- Merge by fast-forwarding `main` to the tested pull-request commit (not GitHub's squash merge, which stamps the account email).
- Repository secret `PII_DENYLIST` (comma-separated plaintext terms) can extend the denylist in CI without publishing it.
