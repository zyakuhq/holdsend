# @holdsend/react-native

[HoldSend](https://github.com/zyakuhq/holdsend) for React Native.

> Early: 0.1 is the first release line. The API may change before 1.0, and it is not ready for production yet.

ESM only. Load it with `import` on Node 20 or later, in browsers and in React Native. `require()` also works on Node 20.19 or later and 22.12 or later; on older Node, use `import()`.

## What is in it

- **`KeyValueStore`**: the outbox over AsyncStorage or MMKV (`fromMmkv(mmkv)`). The whole queue is saved in one write, and updates take turns, even across two store instances on the same key, within one JavaScript runtime. Nothing coordinates writes to the same key from another runtime (native code, or a second JavaScript context), so read and write the outbox only from the app's own JavaScript. A failed read or corrupt data makes the update fail; it never "starts fresh" over what the person wrote.
- **`startNativeAutoFlush()`**: sends when the network comes back, when the app returns to the foreground, and on a backoff while items keep failing. You pass the NetInfo and AppState subscriptions, so HoldSend adds no native dependency.

## Use it

```ts
import AsyncStorage from "@react-native-async-storage/async-storage";
import NetInfo from "@react-native-community/netinfo";
import { AppState } from "react-native";
import { Outbox, classifyResponse } from "@holdsend/core";
import { KeyValueStore, startNativeAutoFlush } from "@holdsend/react-native";

const outbox = new Outbox({
  store: new KeyValueStore(AsyncStorage),
  async send(item, { headers, signal }) {
    const res = await fetch("https://example.com/api/posts", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(item.payload),
      signal, // an attempt abandoned after its timeout is really cancelled
    });
    const body = await res.json().catch(() => ({}));
    return classifyResponse(res.status, body.code);
  },
});

const flusher = startNativeAutoFlush(outbox, {
  owner: user.id,
  onConnectivityChange: (cb) => NetInfo.addEventListener((s) => cb(Boolean(s.isConnected))),
  onForeground: (cb) => AppState.addEventListener("change", (s) => s === "active" && cb()).remove,
});
```

## Size limit

The queue is stored as one value. Android's AsyncStorage cannot read back a value much over 2 MB, and an unreadable queue would lock the person out of everything in it, so `KeyValueStore` refuses (with `OutboxTooLargeError`) any write that would make the queue larger than 1.5 MB, and nothing is lost. Keep photos and files out of payloads: save them to the file system and queue a reference. With MMKV, which has no such limit, pass `{ maxBytes: Infinity }` or a higher limit.

## Sending while the app is closed

iOS gives apps no reliable way to run when the connection returns. On iOS, what is waiting is sent the next time the app is open with a connection, and people should be told so. Android can run a background task; that is on the roadmap, not in this package yet.

## Licence

Apache-2.0
