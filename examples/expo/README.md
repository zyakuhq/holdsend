# Notes on a phone: the HoldSend Expo example

The [notes example](../notes) as an Expo app for Android and iOS, over [`@holdsend/react-native`](../../packages/react-native). Notes are kept in AsyncStorage until they are sent, survive the app being closed, and are never published twice, even when the server's answer is lost on the way back.

## Run it on your phone

1. Start the notes server on your computer, from the repository root. `HOST=0.0.0.0` lets your phone reach it; do this only on a network you trust, because the demo's sign-in can be forged:

   ```sh
   npm install
   npm run build
   HOST=0.0.0.0 npm start --workspace holdsend-example-notes
   ```

2. Find your computer's address on your Wi-Fi network (it usually starts with `192.168.` or `10.`). On a phone, `localhost` is the phone itself, so the app needs this address.

3. Start the app with that address:

   ```sh
   cd examples/expo
   EXPO_PUBLIC_NOTES_URL=http://YOUR-COMPUTER-ADDRESS:3000 npx expo start
   ```

   Scan the QR code with Expo Go, or press `a` for an Android emulator or `i` for the iOS simulator. On iOS, allow the local network prompt. The phone and the computer must be on the same network.

If the address is missing, the app says so at the top of the screen and keeps notes on the device until it is set.

This is a development setup. A release Android build refuses plain `http://` addresses, so a real app talks to an `https://` server.

## Try to break it

- **Airplane mode.** Turn it on, write a few notes, close the app completely, open it again: the notes are still waiting. Turn airplane mode off and they are published, once each.
- **A lost answer.** Press "Lose the answer to my next note", then write one. The server saves it but the connection breaks before the answer arrives. The app tries again with the same key, the server answers with the original, and the note appears once.
- **Cancel.** Write a note in airplane mode and cancel it before it leaves. Once a note has started sending, Cancel is refused, because it may already be on the server.

## When notes are sent

While the app is open: right away, when the connection comes back (NetInfo), when the app returns to the foreground (AppState), and on a backoff while sending keeps failing.

While the app is closed: not yet. iOS gives apps no reliable way to run when the connection returns, so on iPhone waiting notes go the next time the app is open with a connection, and the app says so. Android can run a background task; that is on the roadmap.

## What is where

| File | What it shows |
| --- | --- |
| [`src/outbox.js`](src/outbox.js) | One `Outbox` over a `KeyValueStore` on AsyncStorage, created outside React. Keys come from `expo-crypto`. |
| [`src/use-native-auto-flush.js`](src/use-native-auto-flush.js) | `useNativeAutoFlush` and `useConnected`: sending wired to NetInfo and AppState. Copy it into your app. |
| [`src/use-outbox-entries.js`](src/use-outbox-entries.js) | `useOutboxEntries`, the same hook as in the [React example](../react). |
| [`src/App.js`](src/App.js) | The screen: compose, the outbox with Cancel, Send, Try again and Discard, each saying what really happened, and the published list. |
| [`test/e2e.test.mjs`](test/e2e.test.mjs) | Browser tests of the app's web build, run on every pull request. |

## How it is tested

Every pull request bundles the app for the web and runs it in Chromium against the notes server: offline and back, an app restart with notes waiting, a lost answer, cancel, and a note the server refuses. The web build runs the same code (the AsyncStorage store, the auto-flush, the screen) through react-native-web, so these tests check the app's logic.

They do not replace a phone. Nothing in CI runs on an Android or iOS device or emulator yet, so check the steps above on a real phone before you rely on them. One difference is known: in a desktop browser NetInfo does not report going offline, so the web build listens to the browser's own online and offline events instead.

## Demo shortcuts

- **Signing in.** The app makes up an id, keeps it on the device and sends it in an `X-Demo-User` header. A real app takes the owner from its session.
- **The lost-answer button** exists only to show the problem. Do not ship it.

## Licence

Apache-2.0
