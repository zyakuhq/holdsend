# Emergency messages

> In development for 0.2. It is in the repository but not in a published release yet. The API may change.

`@holdsend/core/emergency` helps a short text message get out of a phone that has no signal, once, without misleading the person who wrote it. It is a delivery aid, not an emergency service. It does not contact emergency services. Any app that uses it must keep telling people to call their local emergency number first.

Why these rules: [decision 0007](decisions/0007-emergency-messages.md). To try it, run the notes example and open `/emergency` ([examples/notes](../examples/notes)).

## What it does

- **Its own queue.** Give emergency messages their own store and their own sender lock (see below), so a large upload in the app's main queue cannot hold them up.
- **The first message goes by itself.** When the connection returns, the first message a person wrote is sent automatically. Messages written while it was still waiting are held, and go only when the person presses Send for each, or Send all. Choose `autoSend: "all"` or `"none"` for a different rule.
- **Repeated taps are one message.** The same words (ignoring case and extra spaces), written within ten minutes of when a waiting message was written, return that message instead of queuing a new one. A message stuck after the server refused it is not matched, so writing it again queues a new one.
- **Old messages ask first.** A message still waiting a day after it was written is not sent automatically. The app shows when it was written and asks. This rule, and whether a message is held, are stored with each message, so a service worker or any other sender over the same store follows them too. Approval is final: once the person presses Send, the message is sent without another age check.
- **One key per message.** Every message keeps one idempotency key for life, like any HoldSend item. The server's half (`handleIdempotent` with `requireKey: true`) answers a retry with the original.

## Using it

```ts
import { EmergencyOutbox, smsLink } from "@holdsend/core/emergency";
import { classifyResponse } from "@holdsend/core";
import { SenderLock, createWebStore, startAutoFlush } from "@holdsend/web";

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

// Its own sender lock, so the main queue's sending never blocks this one.
const flusher = startAutoFlush(emergency.outbox, { owner: userId, lock: new SenderLock({ name: "my-app-emergency" }) });

const { item, duplicate, held } = await emergency.write(text, { owner: userId });
// duplicate: the same message was already waiting; show that one.
// held: it waits for the person; show Send and Send all.
flusher.kick();

// The person pressed Send, or Send all:
await emergency.send(key);
await emergency.sendAll(userId);
flusher.kick();
```

`emergency.outbox` is an ordinary `Outbox`: use its `list()`, `subscribe()`, `flush()`, `cancel()` and `discard()`. A held message has the status `"needs_confirmation"`, like a message waiting because of its age. `emergency.send(key)` and `emergency.sendAll(owner)` are the person's Send and Send all. They only approve: flush or kick auto-flush afterwards. Send all also approves messages waiting because of their age, so show when each was written next to it.

On React Native, use `new KeyValueStore(AsyncStorage, { key: "my-app:emergency" })` so the queue has its own key.

## Handing off to SMS

```ts
const result = await emergency.outbox.cancel(item.key);
const link = smsLink("+14155550199", `${item.payload.text}\n(written ${timeLabel})`);
// "cancelled": it never left the device, so it cannot also arrive by data.
// "in_flight": it may already have been sent. Tell the person it may arrive twice.
```

Open the link with `location.href = link` on the web or `Linking.openURL(link)` in React Native. It opens the phone's messaging app with the text filled in, and the person presses send there. One recipient uses the standard form. For several recipients, pass `{ platform: "ios" }` on iPhones, which need a different link for that case. How phones read these links has changed between versions, so test them on the phones your people use.

After `cancel` the message is no longer in the queue, so the library cannot show it again. If the page is closed or killed before the person presses send in the messaging app, the text is gone unless your app kept it. Keep the text and its written time on the device (the notes example uses `localStorage`, per person, and does not store the phone number; the person types it again), show it again on the next visit, and offer "Put it back in the queue" (call `write()` with the same text and `writtenAt`) and "I sent it". The library does not do this for you yet.

## What each platform can do

| Where | Sent with the app closed? | What to tell the person |
| --- | --- | --- |
| Chrome, Edge and other Chromium browsers (desktop and Android) | Usually, after `requestBackgroundSync({ tag: "my-app-emergency" })` returns `"background"`, while the browser itself is running. The browser gives up after a few failed tries, and then the message waits until the page is opened. | "It will be sent when the connection returns, even if you close this page." Only say this after the registration succeeded. |
| Safari (every browser on iOS) and Firefox | No | "It will be sent when this page is open and there is a connection." Offer SMS. |
| React Native on iOS | No | "It will be sent when the app is open and there is a connection." Offer SMS. |
| React Native on Android | Not yet (a background task is planned) | Same as iOS for now. Offer SMS. |
| SMS hand-off, everywhere | Only when the person presses send in the messaging app | Needs phone signal, which often works when mobile data does not. |

In the service worker, handle the emergency queue's own tag with `onBackgroundSync(event, flush, { tag: "my-app-emergency" })`. Flush only the signed-in person's messages, under the same lock name as the pages (`new SenderLock({ name: "my-app-emergency" })`). A plain `Outbox` over the emergency store is enough there: held messages and the one-day rule travel with each message.

## What it does not do

- Send an SMS by itself, or contact emergency services. No web page or app can send an SMS without the person pressing send.
- Guarantee delivery. It keeps trying and keeps the person informed. If the message cannot get out, it says so.
- Tell two different messages with the same words apart while both wait within the matching window. They are treated as one, on purpose.
