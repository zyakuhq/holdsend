# @holdsend/core

The platform-independent part of [HoldSend](https://github.com/zyakuhq/holdsend): an outbox that keeps what a person writes while offline and sends it exactly once when the connection returns.

No runtime dependencies. ESM. About 4.5 KB minified and gzipped, with a CI budget of 5 KB.

> Early and unreleased. The API may change before 0.1.0.

## What is in it

- `Outbox`: add, list, cancel, approve, retry, discard and flush.
- `MemoryStore`: an in-memory store for tests. Platform packages provide durable stores.
- The rules as pure functions (`claim`, `settle`, `cancel`, `approve`, `retry`, `discard`, `statusOf`, ...), for anyone building their own runtime.
- The wire protocol: `requestHeaders`, `classifyResponse`, `classifyThrown`.
- Written-time rules shared with servers: `acceptWrittenAt`, `wasWrittenOffline`.

See the [main README](https://github.com/zyakuhq/holdsend#readme) and [docs/protocol.md](https://github.com/zyakuhq/holdsend/blob/main/docs/protocol.md).

## Licence

Apache-2.0
