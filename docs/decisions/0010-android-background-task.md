# 0010: Android background sending in the Expo example

Date: 2026-11-11. Status: accepted.

## Context

`runBackgroundFlush` in `@holdsend/react-native` (2026-11-09) gives a background task one time-limited flush. The Expo example did not use it, so nothing showed how to wire it, and the helper's guidance had not been checked against a real background library.

## Choice

- The Expo example uses `expo-background-task` with `expo-task-manager` (the versions Expo 58 pins). The packages themselves still depend on no background library.
- The task is defined in the bundle's global scope (imported from `index.js`) and registered on Android only. On iOS the app keeps saying that waiting notes go the next time it is open with a connection.
- It registers once and leaves an existing registration alone.
- It asks for every 15 minutes. Android decides the real timing and may wait longer.
- The task returns `Failed` only when the flush threw. `retryLater` is not used here.
- The screen says, only when registration worked, that Android may also try when the app is closed and that this is not a promise.

## Why

- Reading `expo-background-task`'s Android source (version 58) showed that the task's return value is ignored and the next run is scheduled the same way, that work only runs with a connection, and that it is skipped while the app is in the foreground. The earlier advice ("return `Failed` when `retryLater`") suggested a sooner retry that does not happen, so the README, the code comment and the changelog were corrected.
- iOS background runs come with no timing promise, and we cannot check them, so the example makes no iOS claim.

## Review

A separate agent reviewed the helper and the example before merge. It found nothing that can lose or double-send a note; its five small findings (wording about the time limit, `done` when `isOnline` says offline, the ignored return value, where the 15 minutes comes from, a wrong comment) were fixed in the docs and comments.

## Not done

- Not run on a real Android phone or an emulator, and not in CI. Proving it needs a development build on a device: write a note offline, leave the app, reconnect, and see the note arrive once.
