// The notes page in React, built on the hooks in use-outbox.js.
import { useCallback, useEffect, useRef, useState } from "react";
import { requestBackgroundSync } from "@holdsend/web";
import { SENDER_LOCK } from "../../notes/src/send.mjs";
import { useAutoFlush, useOnline, useOutboxEntries } from "./use-outbox.js";

const STATUS_TEXT = {
  waiting: "Waiting for a connection",
  sending: "Sending",
  needs_confirmation: "Written more than 30 days ago. Send it now, or discard it?",
  sent: "Sent",
};
const STUCK_TEXT = {
  attempts_exhausted: "Could not be sent. The server kept failing.",
  key_conflict: "The server already has a different note under this key.",
  refused: "The server refused this note.",
  unreachable: "Could not reach the server for a long time.",
};

const isOnline = () => navigator.onLine !== false;
const when = (iso) => (iso ? new Date(iso).toLocaleString() : "unknown");

/** The published list, with the last good copy kept for offline reloads. */
function usePublishedNotes(owner) {
  const cacheKey = `holdsend-notes-feed:${owner}`;
  const [state, setState] = useState({ notes: [], note: "", loaded: false });
  // Only the newest request may update the list: a slow failed fetch must
  // not replace a newer good one.
  const latest = useRef(0);

  const refresh = useCallback(async () => {
    const call = ++latest.current;
    try {
      const res = await fetch("/api/notes", { headers: { "x-demo-user": owner }, cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const { notes } = await res.json();
      try {
        localStorage.setItem(cacheKey, JSON.stringify(notes));
      } catch {
        /* the offline copy is a nicety */
      }
      if (call === latest.current) setState({ notes, note: "", loaded: true });
    } catch {
      if (call !== latest.current) return;
      let saved = null;
      try {
        saved = JSON.parse(localStorage.getItem(cacheKey) ?? "null");
      } catch {
        /* nothing saved */
      }
      setState((current) => {
        // Keep what is on screen; fall back to the saved copy on a fresh load.
        const notes = current.loaded && current.notes.length > 0 ? current.notes : (saved ?? []);
        const shown = notes.length > 0;
        return {
          notes,
          note: shown ? "Offline: showing the list as it was last loaded." : "Offline: the published list will load when the connection returns.",
          loaded: true,
        };
      });
    }
  }, [owner, cacheKey]);

  return [state, refresh];
}

/** A short preview of a note, to tell screen-reader users which note a button acts on. */
function preview(text) {
  return text.length > 40 ? `${text.slice(0, 40)}…` : text;
}

function ItemButton({ label, item, onClick }) {
  return (
    <button type="button" aria-label={`${label}: ${preview(item.payload.text)}`} onClick={onClick}>
      {label}
    </button>
  );
}

export function App({ outbox, owner, durable }) {
  const online = useOnline();
  const { entries, loaded: outboxLoaded } = useOutboxEntries(outbox, { owner });
  const [published, refreshPublished] = usePublishedNotes(owner);
  const [notice, setNotice] = useState("");
  const [background, setBackground] = useState("");
  const [loseNote, setLoseNote] = useState("");
  const [text, setText] = useState("");
  const [saving, setSaving] = useState(false);

  /** Registers a background sync while notes are waiting; the browser drops a sync after a few failed tries. */
  const registerBackgroundSync = useCallback(async () => {
    const waiting = (await outbox.list()).some((entry) => entry.item.owner === owner);
    if (!waiting) return;
    const support = await requestBackgroundSync({ tag: "holdsend" });
    setBackground(
      support === "background"
        ? "This browser can also send waiting notes after you close the tab."
        : "This browser sends notes only while this page is open.",
    );
  }, [outbox, owner]);

  const kick = useAutoFlush(outbox, {
    owner,
    lockName: SENDER_LOCK,
    isOnline,
    onReport: (report) => {
      if (report === "skipped") return;
      if (report.sent > 0) void refreshPublished();
      if (report.retry > 0 || report.busy > 0 || report.nextCheckInMs !== undefined) void registerBackgroundSync();
    },
  });

  // On load, and again whenever the connection comes back.
  useEffect(() => {
    void refreshPublished();
    void registerBackgroundSync();
  }, [online, refreshPublished, registerBackgroundSync]);

  // Ready once both lists are on screen (effects run after React has drawn them).
  useEffect(() => {
    if (published.loaded && outboxLoaded) document.body.dataset.ready = "true";
  }, [published.loaded, outboxLoaded]);

  /** Runs a person's action on one item, then tells them what happened. */
  async function act(fn) {
    try {
      setNotice((await fn()) ?? "");
    } catch (err) {
      setNotice(`That did not work: ${err instanceof Error ? err.message : String(err)}`);
    }
    kick();
  }

  const actions = {
    cancel: async (item) => {
      const result = await outbox.cancel(item.key);
      return result === "in_flight" ? "Too late to cancel: this note has started sending and may already be published. It will be finished, not sent twice." : undefined;
    },
    approve: async (item) => {
      const result = await outbox.approve(item.key);
      return result.ok && result.newKey ? "Sending with a new key. If an earlier version reached the server, there may be two copies." : undefined;
    },
    retry: async (item) => {
      if (item.stuckReason === "key_conflict") {
        // A new key can publish a second copy if the server's request was an earlier version of this note.
        if (!window.confirm("The server holds a different note under this note's key. Send this one as a new note? You may end up with two.")) return undefined;
      }
      await outbox.retry(item.key);
      return undefined;
    },
    discard: async (item) => {
      const result = await outbox.discard(item.key);
      if (result === "discarded_may_exist") return "Removed from this device. An earlier attempt may have reached the server, so check the published list.";
      if (result === "in_flight") return "It is being sent right now. Try again in a moment.";
      return undefined;
    },
  };

  async function onSubmit(event) {
    event.preventDefault();
    const value = text.trim();
    if (!value || saving) return;
    setSaving(true);
    try {
      await outbox.add("note.create", { text: value }, { owner });
      setText("");
      kick();
      await registerBackgroundSync();
    } catch (err) {
      setNotice(`Could not keep this note on the device: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSaving(false);
    }
  }

  async function onDelete(id) {
    const res = await fetch(`/api/notes/${id}`, { method: "DELETE", headers: { "x-demo-user": owner } }).catch(() => null);
    setNotice(res?.ok ? "" : "Deleting needs a connection.");
    await refreshPublished();
  }

  async function onLoseAnswer() {
    try {
      const res = await fetch("/api/demo/lose-next-answer", { method: "POST", headers: { "x-demo-user": owner } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setLoseNote("The server will save your next note but drop its answer. Watch it still appear once.");
    } catch {
      setLoseNote("Needs a connection.");
    }
  }

  return (
    <>
      <h1>HoldSend notes, in React</h1>
      <p className="lead">Write with or without a connection. Every note is published exactly once.</p>
      <p id="connection" role="status" data-online={String(online)}>
        {online ? "Online" : "Offline: notes are kept on this device and sent when the connection returns."}
      </p>
      <p id="durability">{durable ? "" : "This browser cannot keep notes on the device. Anything waiting is lost if you close the tab."}</p>
      <p id="background" className="hint">
        {background}
      </p>

      <form id="compose" onSubmit={onSubmit}>
        <label htmlFor="text">New note</label>
        <textarea id="text" maxLength={2000} required value={text} onChange={(event) => setText(event.target.value)} />
        <button type="submit" id="send" disabled={saving}>
          Send
        </button>
      </form>

      <p id="notice" role="status">
        {notice}
      </p>

      <h2>Waiting on this device</h2>
      <p id="outbox-empty" className="hint" hidden={!outboxLoaded || entries.length > 0}>
        Nothing waiting.
      </p>
      <ul id="outbox">
        {entries.map(({ item, status }) => (
          <li key={item.key} data-status={status}>
            <p className="note-text">{item.payload.text}</p>
            <p className="meta">
              {status === "stuck" ? (STUCK_TEXT[item.stuckReason] ?? "Stopped.") : STATUS_TEXT[status]} · written {new Date(item.writtenAt).toLocaleString()}
            </p>
            {status === "waiting" && <ItemButton label="Cancel" item={item} onClick={() => act(() => actions.cancel(item))} />}
            {status === "needs_confirmation" && (
              <>
                <ItemButton label="Send" item={item} onClick={() => act(() => actions.approve(item))} />
                <ItemButton label="Discard" item={item} onClick={() => act(() => actions.discard(item))} />
              </>
            )}
            {status === "stuck" && (
              <>
                <ItemButton label="Try again" item={item} onClick={() => act(() => actions.retry(item))} />
                <ItemButton label="Discard" item={item} onClick={() => act(() => actions.discard(item))} />
              </>
            )}
          </li>
        ))}
      </ul>

      <h2>Published</h2>
      <p id="feed-note" className="hint">
        {published.note}
      </p>
      <p id="feed-empty" className="hint" hidden={!published.loaded || published.notes.length > 0}>
        No notes yet.
      </p>
      <ul id="feed">
        {published.notes.map((note) => (
          <li key={note.id} data-id={note.id}>
            <p className="note-text">{note.text}</p>
            <p className="meta">
              Written {when(note.writtenAt)} (the writer&apos;s clock) · arrived {when(note.arrivedAt)}
            </p>
            <button type="button" aria-label={`Delete: ${preview(note.text)}`} onClick={() => onDelete(note.id)}>
              Delete
            </button>
          </li>
        ))}
      </ul>

      <details>
        <summary>Try to break it</summary>
        <p className="hint">
          Turn on airplane mode (or &quot;Offline&quot; in the browser&apos;s developer tools), write a few notes, reload the page, then go back online. Open
          the page in two tabs. Or make the server lose the answer to your next note:
        </p>
        <button type="button" id="lose-answer" onClick={onLoseAnswer}>
          Lose the answer to my next note
        </button>
        <p id="lose-answer-note" className="hint">
          {loseNote}
        </p>
      </details>
    </>
  );
}
