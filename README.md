# HoldSend

**Write offline. Publish exactly once.**

HoldSend is a small open-source library for apps where people write things that must not be lost: posts, reports, field notes, messages. It keeps what a person writes on the device while there is no connection, and publishes it once when the connection returns. Not zero times. Not twice. Even when answers get lost, someone taps twice, two tabs are open, or the app is killed halfway through a send.

> **Status: early.** The core state machine and its tests are in this repository today. Storage adapters, the server package and the emergency module are being built in the open. Nothing here is ready for production yet, and this README says so until it is. See [docs/STATUS.md](docs/STATUS.md).

Supported by an Emergent Ventures grant (Mercatus Center).

## Why

Networks fail at the worst moments: in a flood, at a protest, on a train, in a village with one bar of signal. Most apps handle this badly in one of two ways. They lose what you wrote, or they send it twice when the first answer never came back. HoldSend is built for the places where either mistake matters.

## What it does

| Promise | How |
| --- | --- |
| Nothing written is lost on close, force-close or reload | Items live in durable device storage. If storage is not durable (some private browsing modes), the app is told so it can warn the person. |
| Published exactly once | Every item gets one idempotency key for life. The server stores the key and the result in one transaction and answers a retry with the original. |
| No double sends across tabs or senders | Claims are taken inside one atomic storage update; a dead sender's claim expires and is taken over with the same key. |
| The truth about time | Each item carries when it was written. The server keeps that separately from when it arrived, and feeds keep ordering by arrival, so nobody can backdate a post. |
| People can see and cancel what is waiting | An outbox lists every item. Cancel works only while an item has never left the device, because after that it may already exist on the server. |
| Old items ask first | Anything written more than 30 days ago waits for the person to press Send, and then goes with its same key. |

## Packages

| Package | What | State |
| --- | --- | --- |
| [`@holdsend/core`](packages/core) | Outbox state machine, keys, written-time rules, wire protocol. No runtime dependencies. | Working, tested, unreleased |
| `@holdsend/web` | IndexedDB store, cross-tab lock, Background Sync helper | Roadmap |
| `@holdsend/react-native` | AsyncStorage and MMKV stores | Roadmap |
| `@holdsend/server` | Idempotency store for Postgres, plus an in-memory one for tests | Roadmap |

## A first look at the core

```ts
import { MemoryStore, Outbox, classifyResponse } from "@holdsend/core";

const outbox = new Outbox<{ text: string }>({
  store: new MemoryStore(), // platform packages will provide durable stores
  async send(item, { headers }) {
    const res = await fetch("/api/posts", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(item.payload),
    });
    const body = await res.json().catch(() => ({}));
    return classifyResponse(res.status, body.code);
  },
});

await outbox.add("post.create", { text: "Bridge on 4th street is flooded" });
await outbox.flush(); // call again whenever the connection comes back
```

The wire contract is short and documented in [docs/protocol.md](docs/protocol.md).

## Honest limits

- Exactly once needs the server's help. HoldSend's client gives every item one key for life; the server must store that key and its result together. `@holdsend/server` will be a reference implementation.
- A person's device clock decides the written time. The server bounds it (no more than two minutes ahead, no more than 30 days back) and only ever shows it, never sorts by it.
- Background sending after the app closes depends on the platform. Some browsers can do it; iOS cannot do it for web apps today. HoldSend will tell the app which case it is in, so it can tell the person the truth.
- Emergency features in this library are a delivery aid, not an emergency service.

## Contributing

Issues and pull requests are welcome. Start with [CONTRIBUTING.md](CONTRIBUTING.md). Decisions and their reasons are recorded in [docs/decisions](docs/decisions).

## Licence

[Apache-2.0](LICENSE). Copyright 2026 Zyaku Inc. and HoldSend contributors.
