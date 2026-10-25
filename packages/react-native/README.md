# @holdsend/react-native

[HoldSend](https://github.com/zyakuhq/holdsend) for React Native.

> Early and unreleased. The API may change before 0.1.0.

## What is in it

- **`KeyValueStore`**: the outbox over AsyncStorage or MMKV (`fromMmkv(mmkv)`). The whole queue is saved in one write, and updates take turns, even across two store instances on the same key. A failed read or corrupt data makes the update fail; it never "starts fresh" over what the person wrote.
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
  async send(item, { headers }) {
    const res = await fetch("https://example.com/api/posts", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(item.payload),
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

## Sending while the app is closed

iOS gives apps no reliable way to run when the connection returns. On iOS, what is waiting is sent the next time the app is open with a connection, and people should be told so. Android can run a background task; that is on the roadmap, not in this package yet.

## Licence

Apache-2.0
