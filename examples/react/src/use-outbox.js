// React hooks for a HoldSend outbox. Small enough to copy into an app; they
// may become a package once their shape has settled.
import { useCallback, useEffect, useRef, useState } from "react";
import { SenderLock, startAutoFlush } from "@holdsend/web";

/** A cheap fingerprint of what the list shows, so an unchanged poll does not re-render. */
function signature(list) {
  return list.map(({ item, status }) => `${item.key}:${status}:${item.stuckReason ?? ""}:${item.attempts}`).join("|");
}

/**
 * The items waiting in `outbox`, kept current: after every change this tab
 * makes, and every `pollMs` for changes made by other tabs.
 *
 * Returns `{ entries, loaded }`. `loaded` is false until the first read, so
 * a page can tell "still loading" from "nothing waiting".
 *
 * Pass `owner` to show only that person's items: on a shared device the
 * outbox may also hold someone else's.
 */
export function useOutboxEntries(outbox, { owner, pollMs = 2000 } = {}) {
  const [state, setState] = useState({ entries: [], loaded: false });
  useEffect(() => {
    let alive = true;
    // outbox.list() is asynchronous; only the newest answer may be shown, or
    // a slow older read could put back an item that is already gone.
    let latest = 0;
    let shown = null;
    const refresh = () => {
      const call = ++latest;
      outbox
        .list()
        .then((list) => {
          if (!alive || call !== latest) return;
          const entries = owner === undefined ? list : list.filter((entry) => entry.item.owner === owner);
          const next = signature(entries);
          if (next === shown) return;
          shown = next;
          setState({ entries, loaded: true });
        })
        .catch(() => undefined);
    };
    refresh();
    const unsubscribe = outbox.subscribe(refresh);
    const timer = setInterval(refresh, pollMs);
    return () => {
      alive = false;
      unsubscribe();
      clearInterval(timer);
    };
  }, [outbox, owner, pollMs]);
  return state;
}

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
