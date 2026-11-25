# 0021: Checks for the client Store contract

Date: 2026-11-25. Status: accepted.

## Context

The `Store` interface in `@holdsend/core` has rules a custom store must keep: each `update` is atomic against every other writer, the store keeps its own copies of what it is given and never hands out objects it keeps, nothing is saved when `fn` throws, and every field comes back unchanged. Two audits found bugs at this boundary (B5 in the third audit, HS-006 in the source review). [production.md](../production.md) told app authors there was no test suite for client stores, and each built-in store had its own tests, written separately, so nothing showed that all of them keep the same rules.

Writing the checks found one rule the interface never stated. `IndexedDbStore` keeps items in an object store keyed by `key`, so `read()` and `update()` give items in key order, not in the order the last `fn` left them. The outbox does not depend on order: it sorts by written time where order matters ([decision 0008](0008-flush-order.md)) and finds items by key.

## Choice

- `test/store-contract.ts`: nine checks, each a function that takes a harness (a way to open new stores over the same items) and throws when the store breaks a rule. `test/store-contract.test.ts` runs them against `MemoryStore`, `IndexedDbStore` (fake-indexeddb), and `KeyValueStore` over AsyncStorage and MMKV fakes.
- The same file runs eight deliberately broken stores (reads then writes in two steps, keeps the array `fn` changed, hands out its own array, saves when `fn` throws, swallows the error, drops a field, writes items one at a time, says durable while keeping nothing) and requires the matching check to fail on each.
- Order is not part of the contract. The `Store` doc comment says so, and that a store may index items by key, since the outbox never leaves two items with the same key. The checks compare items sorted by key.
- The checks stay in the repository, not in a published package. App authors copy the file. Publishing it would add an entry point to freeze at 1.0; that can wait until someone asks for it.

## What the checks do not cover

- Atomicity across tabs or processes beyond what the fakes model: two `IndexedDbStore`s over one fake database, and two `KeyValueStore`s in one runtime (the only case React Native stores promise).
- Durability on a real device. The `isDurable` check only compares the answer with what the harness expects.
- A read in the middle of a write is checked by reading repeatedly while fifteen updates run; a store whose writes finish within one turn of the event loop is never caught mid-write, which is fine because no read can see it half done either.
