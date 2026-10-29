# @holdsend/core

The platform-independent part of [HoldSend](https://github.com/zyakuhq/holdsend): an outbox that keeps what a person writes while offline and sends it when the connection returns, with one idempotency key per item for life.

Exactly once needs the server's half too: the server must store each key with its result and answer a retry with the original. [`@holdsend/server`](https://www.npmjs.com/package/@holdsend/server) does that for Postgres; the wire contract is in [the protocol](https://zyakuhq.github.io/holdsend/docs/protocol.html).

No runtime dependencies. Under 5 KB minified and gzipped (a CI budget).

ESM only. Load it with `import` on Node 20 or later, in browsers and in React Native. `require()` also works on Node 20.19 or later and 22.12 or later; on older Node, use `import()`.

> Early: 0.1 is the first release line. The API may change before 1.0, and it is not ready for production yet.

## What is in it

- `Outbox`: add, list, cancel, approve, retry, discard and flush.
- `MemoryStore`: an in-memory store for tests. Platform packages provide durable stores.
- `statusOf` and `needsConfirmation`, for showing items. The rest of the state machine is internal, so it can change without breaking anyone.
- In development for 0.2, not in a published release yet: `@holdsend/core/emergency`, for short emergency messages (the first goes by itself, later ones wait for the person, repeated taps are one message, SMS hand-off). See [emergency messages](https://github.com/zyakuhq/holdsend/blob/main/docs/emergency.md).
- The wire protocol: `requestHeaders`, `classifyResponse`, `classifyThrown`.
- Written-time rules shared with servers: `acceptWrittenAt`, `wasWrittenOffline`.

See the [main README](https://github.com/zyakuhq/holdsend#readme) and [docs/protocol.md](https://github.com/zyakuhq/holdsend/blob/main/docs/protocol.md).

## Licence

Apache-2.0
