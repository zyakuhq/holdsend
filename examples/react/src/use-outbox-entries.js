// The waiting items of a HoldSend outbox, for React on any platform (web or
// React Native). Small enough to copy into an app.
//
// This file lives in both examples/react/src and examples/expo/src, so each
// example stands on its own; test/examples.test.ts checks the copies match.
import { useEffect, useState } from "react";

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
