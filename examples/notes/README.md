# Notes: the HoldSend example

A small notes app that keeps working without a connection and publishes every note exactly once. It is a demo, not a template for production, but every part of it is wired the way a real app would wire HoldSend.

## Run it

From the repository root:

```sh
npm install
npm run build
npm start --workspace holdsend-example-notes
```

Open http://localhost:3000. It uses PGlite (Postgres in WebAssembly, in memory) unless `DATABASE_URL` points at a real Postgres.

## Try to break it

- **Airplane mode.** Load the page once, then go offline (airplane mode, or "Offline" in the browser's developer tools). Write a few notes. Reload the page: it still loads, and the notes are still waiting. Go back online and they are published, once each.
- **A lost answer.** Open "Try to break it" and press "Lose the answer to my next note". The server saves your next note but the connection breaks before the answer arrives. The page tries again with the same key, the server answers with the original, and the note appears once.
- **Two tabs.** Open the page in two tabs, go offline, write in both, go back online. Each note is published once.
- **Cancel.** Write a note offline and cancel it before it leaves. Once a note has started sending, Cancel is refused, because it may already be on the server.

## What is where

| File | What it shows |
| --- | --- |
| [`src/app.mjs`](src/app.mjs) | The server. `handleIdempotent` around the insert, `requireKey: true`, the written time in its own column, the feed ordered by arrival, a tombstone on delete. |
| [`src/client.mjs`](src/client.mjs) | The page. An `Outbox` over IndexedDB, auto-flush, one sender across tabs, and the outbox shown to the person with Cancel, Send, Try again and Discard, each telling the truth about what happened. |
| [`src/send.mjs`](src/send.mjs) | How one note is sent. The outbox adds `Idempotency-Key` and `Written-At`. |
| [`src/sw.mjs`](src/sw.mjs) | The service worker. Keeps the page available offline and sends in the background where the browser supports Background Sync. |
| [`src/session.mjs`](src/session.mjs) | Tells the service worker who is signed in, so it only ever sends that person's notes. |
| [`src/emergency-client.mjs`](src/emergency-client.mjs) and [`public/emergency.html`](public/emergency.html) | The emergency page at `/emergency`: its own queue, sender lock and background sync tag. The first message goes by itself, later ones wait for Send or Send all, repeated taps are one message, and there's an SMS hand-off that takes the message out of the queue (and can put it back). A demo, not an emergency service. |
| [`test/emergency.mjs`](test/emergency.mjs) | The emergency page's browser checks, against the server's own list of messages. |
| [`test/scenarios.mjs`](test/scenarios.mjs) | The checks above, run in Chromium on every pull request against this page and the [React version](../react). They count the server's notes, not what the page shows. |

## Demo shortcuts

- **Signing in.** The browser makes up an id and sends it in an `X-Demo-User` header. A real app takes the owner from its session and never from the request.
- **Background sending.** Only Chromium browsers support Background Sync. The page says which case you are in. Safari and Firefox send only while the page is open.
- **The lost-answer button** exists only to show the problem. Do not ship it.

## Licence

Apache-2.0
