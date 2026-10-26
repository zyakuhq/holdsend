# Changelog

All notable changes to the `@holdsend` packages. All four packages share one version number.

## 0.1.0 (unreleased)

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
