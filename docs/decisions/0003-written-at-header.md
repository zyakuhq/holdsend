# 0003: The written time travels in a header

Date: 2026-10-25. Status: accepted.

## Context

Every item records when it was written. The server needs that time to show "written offline". The server also hashes the request to decide whether a retry under the same key is the same request.

If the written time were a body field, every server would have to remember to leave it out of the hash, or a retry from a device whose stored item gained the field later would be rejected as a conflict.

## Choice

The client sends `Written-At: <ISO 8601 with zone>` as a request header, next to `Idempotency-Key`. The body is exactly what the app wrote.

The server accepts the time only when an idempotency key is present, bounds it with `acceptWrittenAt` (at most two minutes ahead, at most 30 days back, clamped to arrival), stores it separately from the arrival time, and never orders by it.

An app can leave the header out for content whose writing time is sensitive (`omitWrittenAt`).

## Why

- The request hash stays a hash of the content, with nothing to exclude.
- One shared function (`acceptWrittenAt`) gives clients and servers the same bounds.
- A header is easy to strip at a proxy if an operator decides not to accept written times at all.
