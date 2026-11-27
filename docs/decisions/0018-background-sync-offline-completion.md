# 0018: Background Sync completion after an offline interruption

Date: 2026-11-19. Status: proposed.

## Context

A flush can send one item, then stop when connectivity disappears before sending the next. The remaining item stays in the outbox, but the flush report may contain no retry, busy, or next-check time. Background Sync then treats the flush as complete and resolves the sync event.

The browser may stop retrying even though sendable work remains.

## Choice

Add an optional `deferredOffline` field to `FlushReport`. It is set to `true` when a flush stops because connectivity was lost and sendable items for that flush remain.

Before returning the aggregate report, the outbox checks the stored items again. This avoids reporting unfinished work when another queued flush has already sent the remainder.

Background Sync treats `deferredOffline: true` as unfinished work and rejects the event, allowing the browser to retry.

The field is optional so existing consumers of `FlushReport` remain compatible. Items requiring a person's confirmation do not count as automatically sendable work.

## Limits

Background Sync is browser-dependent. Rejecting the event requests another attempt but does not guarantee one. Browsers may stop retrying after a limited number of attempts, so applications still need to register again when appropriate.
