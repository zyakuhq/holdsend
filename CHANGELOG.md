# Changelog

All notable changes to the `@holdsend` packages. All four packages share one version number.

## Unreleased

- New, in development: `@holdsend/core/emergency`, for short emergency messages. Messages wait in their own queue. The first message goes by itself when the connection returns, and later ones wait for the person to press Send. The same words tapped again are one message, a message waiting for a day asks before sending, and `smsLink` builds an SMS hand-off. It is a delivery aid, not an emergency service. Guide: docs/emergency.md.
- `add()` takes a `decide` option that runs inside the store's atomic update. It can return a queued item instead of adding a new one, or hold the new item until a person approves it. Held items have `held: true` and show as `"needs_confirmation"`.
- The core README no longer lists state-machine functions that stopped being exported in 0.1.0.
- Every package exports `./package.json`, so tools that read `@holdsend/<name>/package.json` (bundlers, React Native's Metro, version checks) no longer fail with `ERR_PACKAGE_PATH_NOT_EXPORTED`.

## 0.1.1 (2026-10-27)

No API changes. Fixes and documentation from an independent source review of 0.1.0.

### @holdsend/core

- `add()` keeps its own copy of the payload, so changing the object afterwards cannot change what is sent, even with a custom store that keeps references. The `Store` contract now says stores must keep their own copies.

### @holdsend/server

- A new section, "What exactly once depends on": `requireKey: true` on every create, keeping records as long as clients may retry (and why `completedTtlMs` is risky), and the owner from the session.
- A new test against a real Postgres server: when `purgeExpired()` removes the claim of a request that is still running, that request cannot commit, and only the retry's post exists.

### @holdsend/react-native

- The README says that store updates take turns within one JavaScript runtime only.

### All packages

- The READMEs say which Node versions can load the packages: `import` on Node 20 or later, `require()` on Node 20.19 or later and 22.12 or later. On older Node 20 releases `require()` fails with `ERR_REQUIRE_ESM`.
- CI loads all four packages on Node 20.0.0, the oldest version they support, and checks that a write whose answer was lost is still published exactly once.
- Releases are staged on npm and go live only after a maintainer approves them with two-factor authentication. They are published from GitHub Actions with trusted publishing and provenance, with no npm token.

## 0.1.0 (2026-10-26)

The first release. Early: the API may still change before 1.0, and nothing here is ready for production yet.

### @holdsend/core

- `Outbox`: keeps what people write while they are offline and publishes each item once, with one idempotency key per item for life.
- The written time travels with every item, separately from the arrival time, and is never used for ordering.
- Cancel works only while an item has never left the device. Items written more than 30 days ago wait for the person to approve them.
- Attempts time out and are aborted; items wait longer between tries; an item with no answer for a day stops and asks the person. Claims let several senders share one queue safely.
- `classifyResponse` for HTTP answers, and a flush scheduler with backoff.

### @holdsend/server

- An idempotency store for Postgres (any `query()` driver, including PGlite) and for memory.
- `handleIdempotent`: claim, create and complete in one transaction; replays, `409 key_conflict`, `409 in_progress` and `410 gone`.
- A frozen, versioned request fingerprint (`hs1:`), `forgetOwner` for erasure, and purging.

### @holdsend/web

- `IndexedDbStore`, atomic across tabs and reopened when the browser closes it; `createWebStore` falls back to memory and says so.
- `SenderLock` (Web Locks, with a localStorage lease), `startAutoFlush`, and Background Sync helpers that report honestly what the browser can do.

### @holdsend/react-native

- `KeyValueStore` over AsyncStorage or MMKV, with guards for corrupt data and Android's size limit.
- `startNativeAutoFlush`, wired to NetInfo and AppState by the app.

### Examples and docs

- A notes app as a plain web page, in React and on Android and iOS with Expo, tested in a real browser on every pull request.
- A docs site at https://zyakuhq.github.io/holdsend/.
