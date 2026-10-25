# 0005: Web store and tab coordination

Date: 2026-10-25. Status: accepted.

## Context

In a browser, the outbox is shared by every tab of the origin (and a service worker). Two tabs can change it at the same moment, and two tabs can come back online at the same moment.

## Choice

- One IndexedDB row per item, keyed by the idempotency key.
- `update` runs read, change and write in a single readwrite transaction. IndexedDB serialises readwrite transactions on the same object store across all tabs and workers of an origin, so no extra write lock is needed. The change function must be synchronous, and the store rejects one that is not.
- A separate `SenderLock` (Web Locks, falling back to a localStorage lease) decides which tab sends. It reduces duplicate requests; correctness does not depend on it, because claims are atomic and the server key turns any duplicate into a replay.
- When IndexedDB is unavailable, `createWebStore` returns a memory store that reports itself as not durable, rather than pretending.
- `requestBackgroundSync` reports `"background"` only after a successful registration.

## Why

- Using the database's own transaction for atomicity is simpler and stronger than a lock around separate reads and writes, which is what a lost update needs to happen.
- A test that only appended distinct items passed even against a deliberately broken, non-atomic store, because separate rows do not conflict. The concurrency test now does forty read-modify-writes of one field from two tabs, which the broken store fails.
