# Status

The project's working memory. Every work session reads this first and updates it last.

Last updated: 2026-10-29 (evening, emergency page in the notes example)

## Done

- Emergency messages, first part (2026-10-29, unreleased): [decision 0007](decisions/0007-emergency-messages.md), `@holdsend/core/emergency` (`EmergencyOutbox`, `smsLink`), and in the core `add({ decide, askAfterMs })` with `held` and `askBy` stored on each item. Reviewed by a separate agent before merge; its eleven findings were fixed, each new test checked to fail without its fix. Guide: [emergency.md](emergency.md).
- Every package exports `./package.json` (2026-10-29, unreleased).
- The notes example has an emergency page at `/emergency` (2026-10-29), with five browser tests: the first message goes by itself and later ones wait for Send all, repeated taps are one message, the SMS hand-off can be undone, and the page opens offline.
- `npm run check` includes a secret scan with secretlint from npm, so no session needs to download gitleaks (CI still runs gitleaks on every pull request).
- October report and Show HN post drafted for the project lead (2026-10-29), kept out of the public repo.
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
- **0.1.1 published to npm (2026-10-27)**, the first release through trusted publishing and staged publishing: the workflow staged all four packages with no token, and the project lead approved them in GitHub and then on npmjs.com with 2FA. Checked by installing all four from npm and running `scripts/smoke-node.mjs` on Node 20.0.0 and 22. npm now shows the trusted publisher as Valid (checked on `@holdsend/core`).
- Independent source review of 0.1.0 (2026-10-27): six risks, HS-001 to HS-006. Two reproduced and fixed with tests (payload copy at `add()`, a real Postgres purge-during-request test), three documented as guarantee boundaries, one already handled by design ([audits/2026-10-27-source-review.md](audits/2026-10-27-source-review.md)).
- Third independent audit before 0.1.0: 31 findings across core and server, web and React Native, and docs, examples and the release workflow. Every "before 0.1.0" item is fixed or decided, with regression tests ([audits/2026-10-26-third-audit.md](audits/2026-10-26-third-audit.md)).
- **0.1.0 published to npm (2026-10-26)**: `@holdsend/core`, `@holdsend/server`, `@holdsend/web` and `@holdsend/react-native`, each with provenance, after the project lead's approval. The first attempt stopped because the token asked for a one-time password; a token that allows automation fixed it. Checked by installing all four in an empty project and loading each with import and require.
- Example: a notes app (Express + Postgres or PGlite, plain browser page, service worker) in [examples/notes](../examples/notes), with browser tests in CI for airplane mode, a lost answer, two tabs, arrival ordering and the offline feed. Reviewed independently; the review's findings were fixed (background sync waits for a busy tab, the worker sends only the signed-in person's notes, keys are required, the outbox actions report what happened).

## In progress

- Phase 2, the emergency module (v0.2). The library part is merged. The core is at 5,113 of its 5,120-byte budget: new core features need a budget decision or must live in a subpath.

## Next three tasks

1. A section on emergency messages in docs/protocol.md (the server route in the notes example is the reference: `handleIdempotent`, `requireKey: true`, records kept as long as a phone may retry).
2. The Phase 2 audit by separate reviewers (core emergency code, the example page and service worker, the docs), and fixes.
3. Release 0.2.0 after the project lead's go-ahead (two approvals: GitHub, then npm with 2FA).

## After that

- Conflict handling for one draft edited on two devices (append-only updates with a reason). This is the hard part; say so.
- An Android background task for React Native.

## Blockers

- The Show HN post waits for the project lead's yes.
- The nightly engineering run on 27 and 28 October stopped because it could not download gitleaks. Fixed on 2026-10-29: `npm run check` now runs secretlint, and the task's prompt allows that.

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
