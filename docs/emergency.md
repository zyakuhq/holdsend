# Emergency messages

> In development for 0.2. It is in the repository but not in a published release yet. The API may change.

`@holdsend/core/emergency` helps a short text message get out of a phone that has no signal, once, without misleading the person who wrote it. It is a delivery aid, not an emergency service. It does not contact emergency services. Any app that uses it must keep telling people to call their local emergency number first.

Why these rules: [decision 0007](decisions/0007-emergency-messages.md).

## What it does

- **Its own queue.** Emergency messages wait in a separate store, so a large upload in the app's main queue can never hold them up.
- **The first message goes by itself.** When the connection returns, the first message a person wrote is sent automatically. Messages written while it was still waiting are held, and go only when the person presses Send for each, or Send all. Choose `autoSend: "all"` or `"none"` for a different rule.
- **Repeated taps are one message.** The same words (ignoring case and extra spaces), written within ten minutes of a waiting message, return that message instead of queuing a new one.
- **Old messages ask first.** A message still waiting a day after it was written is not sent automatically. The app shows when it was written and asks.
- **Never twice.** Every message keeps one idempotency key for life, like any HoldSend item. The server's half (`handleIdempotent` with `requireKey: true`) answers a retry with the original.

## Using it

```ts
import { EmergencyOutbox, smsLink } from "@holdsend/core/emergency";
import { classifyResponse } from "@holdsend/core";
import { createWebStore } from "@holdsend/web";

const emergency = new EmergencyOutbox({
  store: await createWebStore({ name: "my-app-emergency" }), // its own database
  async send(item, { headers, signal }) {
    const res = await fetch("/api/emergency-messages", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(item.payload),
      signal,
    });
    return classifyResponse(res.status);
  },
});

const { item, duplicate, held } = await emergency.write(text, { owner: userId });
// duplicate: the same message was already waiting; show that one.
// held: it waits for the person; show Send and Send all.
await emergency.outbox.flush(userId);
```

`emergency.outbox` is an ordinary `Outbox`: use its `list()`, `subscribe()`, `flush()`, `cancel()` and `discard()`, and start auto-flush on it like any other outbox. A held message has the status `"needs_confirmation"`. `emergency.send(key)` and `emergency.sendAll(owner)` are the person's Send and Send all.

On React Native, use `new KeyValueStore(AsyncStorage, { key: "my-app:emergency" })` so the queue has its own key.

## Handing off to SMS

```ts
const result = await emergency.outbox.cancel(item.key);
const link = smsLink("+14155550199", `${item.payload.text}\n(written ${timeLabel})`);
// "cancelled": it never left the device, so it cannot also arrive by data.
// "in_flight": it may already have been sent. Tell the person it may arrive twice.
```

Open the link with `location.href = link` on the web or `Linking.openURL(link)` in React Native. It opens the phone's messaging app with the text filled in, and the person presses send there. For several recipients, pass `{ platform: "ios" }` on iPhones, which need a different link for that case. Test the links on the phones your people use.

## What each platform can do

| Where | Sent with the app closed? | What to tell the person |
| --- | --- | --- |
| Chrome, Edge and other Chromium browsers (desktop and Android) | Yes, after `requestBackgroundSync({ tag: "my-app-emergency" })` returns `"background"` | "It will be sent when the connection returns, even if you close this page." Only say this after the registration succeeded. |
| Safari (every browser on iOS) and Firefox | No | "It will be sent when this page is open and there is a connection." Offer SMS. |
| React Native on iOS | No | "It will be sent when the app is open and there is a connection." Offer SMS. |
| React Native on Android | Not yet (a background task is planned) | Same as iOS for now. Offer SMS. |
| SMS hand-off, everywhere | Only when the person presses send in the messaging app | Needs phone signal, which often works when mobile data does not. |

In the service worker, handle the emergency queue's own tag with `onBackgroundSync(event, flush, { tag: "my-app-emergency" })`, and flush only the signed-in person's messages.

## What it does not do

- Send an SMS by itself, or contact emergency services. No web page or app can send an SMS without the person pressing send.
- Guarantee delivery. It keeps trying and keeps the person informed. If the message cannot get out, it says so.
- Tell two different messages with the same words apart while both wait within the matching window. They are treated as one, on purpose.
