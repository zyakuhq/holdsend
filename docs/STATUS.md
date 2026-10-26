# Status

The project's working memory. Every work session reads this first and updates it last.

Last updated: 2026-10-26 (night, 0.1.0 published)

## Done

- Reference design read and written up in our own words ([reference-notes.md](reference-notes.md)).
- Name, licence, governance files, CI (lint, build, types, tests, size budgets, gitleaks, PII scan with hashed denylist, company-email check on PR commits, real Postgres race tests).
- `@holdsend/core`: outbox rules, `Outbox` runtime with attempt timeouts and abort signals, keys, written-time bounds, protocol, JSON payload checks, flush scheduler.
- `@holdsend/server`: idempotency store for memory and Postgres (any `query()` driver), `handleIdempotent`, tombstones, `forgetOwner`, purge.
- `@holdsend/web`: IndexedDB store (atomic across tabs, reopens closed connections), `SenderLock`, auto-flush, honest Background Sync helpers.
- `@holdsend/react-native`: `KeyValueStore` over AsyncStorage or MMKV (shared update chain, corrupt-data and size guards), native auto-flush.
- Never-twice, never-lost fault-injection suite (fast-check), checked against deliberately broken code ([testing.md](testing.md)).
- First independent audit: 21 findings, all fixed or explained, each with a regression test ([audits/2026-10-25-first-independent-audit.md](audits/2026-10-25-first-independent-audit.md)).
- Second audit pass: 9 new findings (N1 to N9), all fixed or documented, each with a test that fails on the old code. Per-item retry delays, an `unreachable` stop after 24 hours of no answers, growing attempt timeouts, a frozen `hs1:` request fingerprint.
- Decisions 0001 to 0006.
- React example in [examples/react](../examples/react): copyable hooks (`useOutboxEntries`, `useAutoFlush`, `useOnline`) and the notes app in React, passing the same browser scenarios as the plain page in a development build (StrictMode on). Reviewed independently; findings fixed.
- Docs site at https://zyakuhq.github.io/holdsend/, built from the repository's Markdown by `scripts/build-site.mjs` and published by the Docs site workflow on every push to main. A test checks that every link on it works.
- Expo example in [examples/expo](../examples/expo): the notes app on Android and iOS over `@holdsend/react-native` (AsyncStorage store, NetInfo and AppState auto-flush, `expo-crypto` keys). Its web build runs five browser scenarios in CI; the Android and iOS bundles build, but nothing runs on a device or emulator in CI yet. Reviewed independently; findings fixed.
- Release preparation: all packages at 0.1.0 with publish metadata (public access, provenance, licence in each package), `scripts/check-packages.mjs` in `npm run check` (only build output, README and LICENSE may be published), CHANGELOG, issue and pull request templates, the Release workflow (tag `v*` publishes; manual runs can dry-run) and [releasing.md](releasing.md). The `@holdsend` npm organisation and the `NPM_TOKEN` secret exist (2026-10-26).
- Third independent audit before 0.1.0: 31 findings across core and server, web and React Native, and docs, examples and the release workflow. Every "before 0.1.0" item is fixed or decided, with regression tests ([audits/2026-10-26-third-audit.md](audits/2026-10-26-third-audit.md)).
- **0.1.0 published to npm (2026-10-26)**: `@holdsend/core`, `@holdsend/server`, `@holdsend/web` and `@holdsend/react-native`, each with provenance, after the project lead's approval. The first attempt stopped because the token asked for a one-time password; a token that allows automation fixed it. Checked by installing all four in an empty project and loading each with import and require.
- Example: a notes app (Express + Postgres or PGlite, plain browser page, service worker) in [examples/notes](../examples/notes), with browser tests in CI for airplane mode, a lost answer, two tabs, arrival ordering and the offline feed. Reviewed independently; the review's findings were fixed (background sync waits for a busy tab, the worker sends only the signed-in person's notes, keys are required, the outbox actions report what happened).

## In progress

- Moving publishing to npm trusted publishing. The workflow no longer reads a token; the project lead adds the trusted publisher to each package on npm and deletes the `NPM_TOKEN` secret and the npm token.

## Next three tasks

1. Draft the October one-page report and a Show HN post for the project lead to review (kept out of the public repo).
2. Confirm trusted publishing works on the next release (0.1.1 or 0.2.0), with no token.
3. The emergency module (Phase 2).

## After that

- Emergency module: dedupe, written time, background sending where possible, SMS hand-off, honest platform limits.
- Conflict handling for one draft edited on two devices (append-only updates with a reason). This is the hard part; say so.
- An Android background task for React Native.

## Blockers

- The project lead adds the trusted publisher to each package on npm, then deletes the `NPM_TOKEN` secret and the npm token.

## Resolved

- 2026-10-25: security@zyaku.com receives mail (confirmed by the project lead).
- 2026-10-25: `zyakuhq/holdsend` created by the project lead.
- 2026-10-25: private vulnerability reporting is enabled on the repository (confirmed by the project lead).
- 2026-10-25: at the project lead's request, `main` was rewritten so every commit uses the noreply author address; file contents are unchanged. Old branches and pull-request refs still point at the earlier commits until they are deleted.

## Open questions for the project lead

- None.

## Notes for maintainers

- The never-twice soak at 3000 runs needs `--testTimeout=600000` (the default 30 s is too short for the slow-store case).
- Never put Zyaku code, data, names or configuration in this repository. Write everything fresh; do not write reference code from memory either (see the audit's clean-room note). Run `npm run check` and gitleaks before every push.
- Merge by fast-forwarding `main` to the tested pull-request commit (not GitHub's squash merge, which stamps the account email).
- Repository secret `PII_DENYLIST` (comma-separated plaintext terms) can extend the denylist in CI without publishing it.
