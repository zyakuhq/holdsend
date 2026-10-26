# @holdsend/web

[HoldSend](https://github.com/zyakuhq/holdsend) for browsers.

> Early: 0.1.0 is the first release. The API may change before 1.0, and it is not ready for production yet.

## What is in it

- **`IndexedDbStore`**: the outbox kept in IndexedDB, so it survives closing the tab, a crash or a reload. Every change is one readwrite transaction, which IndexedDB runs one at a time across all tabs, so two tabs can never overwrite each other. If the browser closes the connection (iOS Safari does after backgrounding), the store reopens it.
- **`createWebStore()`**: IndexedDB when it works (after one retry), otherwise an in-memory store that reports `isDurable() === false`, so you can tell the person their draft only lasts while the tab is open. Pass `onFallback` to log why. Two limits no page can detect: a private window usually reports `true` (its storage lasts until the window closes), and Safari may clear a site's storage after about a week without a visit.
- **`SenderLock`**: one tab sends at a time (Web Locks, with a localStorage lease for older Safari). Correctness does not depend on it; it avoids sending the same request from two tabs.
- **`startAutoFlush()`**: sends when the connection comes back or the tab becomes visible, and backs off while items keep failing. With more than one outbox on a page, give each its own lock: `startAutoFlush(outbox, { lock: new SenderLock({ name: "my-outbox-sender" }) })`.
- **`requestBackgroundSync()` / `onBackgroundSync()`**: sending after the tab closes, where the browser supports it.

## Use it

```ts
import { Outbox, classifyResponse } from "@holdsend/core";
import { createWebStore, startAutoFlush } from "@holdsend/web";

const store = await createWebStore({ name: "my-app-outbox" });
if (!(await store.isDurable())) showWarning("Drafts are kept only while this tab stays open.");

const outbox = new Outbox({
  store,
  async send(item, { headers, signal }) {
    const res = await fetch("/api/posts", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(item.payload),
      signal, // an attempt abandoned after its timeout is really cancelled
    });
    const body = await res.json().catch(() => ({}));
    return classifyResponse(res.status, body.code);
  },
});

const flusher = startAutoFlush(outbox, { owner: currentUser.id });

async function publish(text: string) {
  await outbox.add("post.create", { text }, { owner: currentUser.id });
  flusher.kick();
}
```

## Background sending, honestly

Only Chromium browsers implement Background Sync. Safari (including every browser on iOS) and Firefox do not. `requestBackgroundSync()` returns `"background"` only after a registration actually succeeded, and `"open_app"` otherwise. Show the person which one they got when they press Send. For urgent messages on `"open_app"` devices, offer another route, such as SMS.

In the service worker, `onBackgroundSync(event, flush)` rejects when the flush left items waiting, so the browser wakes the worker again later instead of treating the sync as done. The browser only does this a few times (Chrome: about three, with growing gaps; `event.lastChance` is true on the last one) and then drops the sync. So register again with `requestBackgroundSync()` whenever the app opens or comes back online with items still waiting, and do not tell the person a message will go "in the background" once the last chance has passed. The worker has no session of its own: when the person signs in, keep their owner id (and whatever your `send` needs to authenticate) in IndexedDB for the worker to read.

## Licence

Apache-2.0
