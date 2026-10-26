// React hooks for a HoldSend outbox. Small enough to copy into an app; they
// may become a package once their shape has settled.
import { useCallback, useEffect, useRef, useState } from "react";
import { SenderLock, startAutoFlush } from "@holdsend/web";

// useOutboxEntries works on any platform (web and React Native); it lives in
// its own file so a React Native app can import it without the web package.
export { useOutboxEntries } from "./use-outbox-entries.js";

/**
 * Sends waiting items while the component is mounted: now, when the
 * connection comes back, when the tab becomes visible, and on a backoff while
 * items keep failing. One tab sends at a time (`lockName`).
 *
 * Only `outbox`, `owner` and `lockName` restart sending when they change.
 * `isOnline` and `onReport` are read through refs, so passing new functions
 * on every render is fine.
 *
 * Returns `kick`, to call after `outbox.add()` so the new item goes at once.
 */
export function useAutoFlush(outbox, { owner, lockName, isOnline, onReport } = {}) {
  const flusher = useRef(null);
  const latest = useRef({ isOnline, onReport });
  useEffect(() => {
    latest.current = { isOnline, onReport };
  });

  useEffect(() => {
    let started = null;
    const options = {
      isOnline: () => (latest.current.isOnline ? latest.current.isOnline() : navigator.onLine !== false),
      // A stopped flusher may still finish a pass; its report is not ours.
      onReport: (report) => {
        if (flusher.current === started) latest.current.onReport?.(report);
      },
    };
    if (owner !== undefined) options.owner = owner;
    if (lockName !== undefined) options.lock = new SenderLock({ name: lockName });
    started = startAutoFlush(outbox, options);
    flusher.current = started;
    return () => {
      started.stop();
      if (flusher.current === started) flusher.current = null;
    };
  }, [outbox, owner, lockName]);

  return useCallback(() => flusher.current?.kick(), []);
}

/** True while the browser says it is online; updates on `online` and `offline` events. */
export function useOnline() {
  const [online, setOnline] = useState(() => navigator.onLine !== false);
  useEffect(() => {
    const update = () => setOnline(navigator.onLine !== false);
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);
  return online;
}
