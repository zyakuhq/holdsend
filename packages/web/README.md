# @holdsend/web

[HoldSend](https://github.com/zyakuhq/holdsend) for browsers.

> Early and unreleased. The API may change before 0.1.0.

## What is in it

- **`IndexedDbStore`**: the outbox kept in IndexedDB, so it survives closing the tab, a crash or a reload. Every change is one readwrite transaction, which IndexedDB runs one at a time across all tabs, so two tabs can never overwrite each other.
- **`createWebStore()`**: IndexedDB when it works, otherwise an in-memory store that reports `isDurable() === false`, so you can tell the person their draft only lasts while the tab is open.
- **`SenderLock`**: one tab sends at a time (Web Locks, with a localStorage lease for older Safari).
- **`startAutoFlush()`**: sends when the connection comes back or the tab becomes visible, and backs off while items keep failing.
- **`requestBackgroundSync()` / `onBackgroundSync()`**: sending after the tab closes, where the browser supports it.

## Use it

```ts
import { Outbox, classifyResponse } from "@holdsend/core";
import { createWebStore, startAutoFlush } from "@holdsend/web";

const store = await createWebStore({ name: "my-app-outbox" });
if (!(await store.isDurable())) showWarning("Drafts are kept only while this tab stays open.");

const outbox = new Outbox({
  store,
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

const flusher = startAutoFlush(outbox, { owner: currentUser.id });

async function publish(text: string) {
  await outbox.add("post.create", { text }, { owner: currentUser.id });
  flusher.kick();
}
```

## Background sending, honestly

Only Chromium browsers implement Background Sync. Safari (including every browser on iOS) and Firefox do not. `requestBackgroundSync()` returns `"background"` only after a registration actually succeeded, and `"open_app"` otherwise. Show the person which one they got when they press Send. For urgent messages on `"open_app"` devices, offer another route, such as SMS.

## Licence

Apache-2.0
