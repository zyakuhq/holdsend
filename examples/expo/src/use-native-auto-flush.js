// Sends a HoldSend outbox from a React Native app while a component is
// mounted: on start, when the network comes back (NetInfo), when the app
// returns to the foreground (AppState), and on a backoff while items keep
// failing. Small enough to copy into an app.
import { useCallback, useEffect, useRef, useState } from "react";
import { AppState, Platform } from "react-native";
import NetInfo from "@react-native-community/netinfo";
import { startNativeAutoFlush } from "@holdsend/react-native";

/**
 * Calls `listener(connected)` now and whenever connectivity changes. Returns
 * an unsubscribe. On phones this is NetInfo. In a desktop browser NetInfo
 * listens only to navigator.connection, which does not report going offline,
 * so the web build uses the browser's own online and offline events.
 */
export function subscribeConnectivity(listener) {
  if (Platform.OS === "web" && typeof window !== "undefined") {
    const update = () => listener(navigator.onLine !== false);
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    update();
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }
  return NetInfo.addEventListener((state) => listener(state.isConnected !== false));
}

/** Whether the device has a network connection. Unknown counts as connected. */
export function useConnected() {
  const [connected, setConnected] = useState(true);
  useEffect(() => subscribeConnectivity(setConnected), []);
  return connected;
}

/**
 * Only `outbox`, `owner` and `enabled` restart sending when they change;
 * `onReport` is read through a ref. Pass `enabled: false` until you know who
 * is signed in. Returns a stable `kick()` to call after `outbox.add()`.
 */
export function useNativeAutoFlush(outbox, { owner, enabled = true, onReport } = {}) {
  const flusher = useRef(null);
  const reportRef = useRef(onReport);
  useEffect(() => {
    reportRef.current = onReport;
  });

  useEffect(() => {
    if (!enabled) return undefined;
    let started = null;
    const options = {
      onConnectivityChange: subscribeConnectivity,
      onForeground: (listener) => {
        const subscription = AppState.addEventListener("change", (state) => {
          if (state === "active") listener();
        });
        return () => subscription.remove();
      },
      // A stopped flusher may still finish a pass; its report is not ours.
      onReport: (report) => {
        if (flusher.current === started) reportRef.current?.(report);
      },
    };
    if (owner !== undefined) options.owner = owner;
    started = startNativeAutoFlush(outbox, options);
    flusher.current = started;
    return () => {
      started.stop();
      if (flusher.current === started) flusher.current = null;
    };
  }, [outbox, owner, enabled]);

  return useCallback(() => flusher.current?.kick(), []);
}
