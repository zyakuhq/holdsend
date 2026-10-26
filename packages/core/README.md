# @holdsend/core

The platform-independent part of [HoldSend](https://github.com/zyakuhq/holdsend): an outbox that keeps what a person writes while offline and sends it when the connection returns, with one idempotency key per item for life.

Exactly once needs the server's half too: the server must store each key with its result and answer a retry with the original. [`@holdsend/server`](https://www.npmjs.com/package/@holdsend/server) does that for Postgres; the wire contract is in [the protocol](https://zyakuhq.github.io/holdsend/docs/protocol.html).

No runtime dependencies. ESM. Under 5 KB minified and gzipped (a CI budget).

> Early: 0.1.0 is the first release. The API may change before 1.0, and it is not ready for production yet.

## What is in it

- `Outbox`: add, list, cancel, approve, retry, discard and flush.
- `MemoryStore`: an in-memory store for tests. Platform packages provide durable stores.
- The rules as pure functions (`claim`, `settle`, `cancel`, `approve`, `retry`, `discard`, `statusOf`, ...), for anyone building their own runtime.
- The wire protocol: `requestHeaders`, `classifyResponse`, `classifyThrown`.
- Written-time rules shared with servers: `acceptWrittenAt`, `wasWrittenOffline`.

See the [main README](https://github.com/zyakuhq/holdsend#readme) and [docs/protocol.md](https://github.com/zyakuhq/holdsend/blob/main/docs/protocol.md).

## Licence

Apache-2.0
