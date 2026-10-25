# 0006: React Native store and a shared flush scheduler

Date: 2026-10-25. Status: accepted.

## Context

React Native apps keep data in AsyncStorage or MMKV, both plain key-value stores with no transactions. The web package already had logic for when to flush (reconnect, foreground, backoff), and React Native needs the same logic with different signals.

## Choice

- The whole queue is one JSON value under one key, written in a single call. Updates are serialised through one chain per (backend, key), shared by all store instances, so a second instance created by mistake cannot interleave with the first. `fromMmkv` returns the same adapter for the same MMKV instance for the same reason.
- A read that fails, or a stored value that is not a valid list, fails the update and leaves storage untouched (`CorruptOutboxError`). The store never replaces unreadable data with an empty queue.
- The "when to flush" logic moved into `@holdsend/core` as `createFlushScheduler`. The web and React Native packages only wire their platform signals and locks to it.
- No dependency on NetInfo, AppState or any native module: the app passes subscribe functions.

## Why

- Treating a failed read as an empty queue and saving would silently delete everything the person wrote. Failing loudly is the only safe choice.
- One scheduler means one place to get backoff and coalescing right, tested once.
