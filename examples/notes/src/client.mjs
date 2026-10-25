// The page: write notes with or without a connection, see what is waiting,
// and see what the server published.
import { Outbox } from "@holdsend/core";
import { SenderLock, createWebStore, requestBackgroundSync, requestPersistentStorage, startAutoFlush } from "@holdsend/web";
import { OUTBOX_NAME, SENDER_LOCK, sendNote } from "./send.mjs";
import { writeSignedInOwner } from "./session.mjs";

const $ = (id) => document.getElementById(id);

/** The demo's stand-in for signing in: a random id kept in this browser. */
function demoUser() {
  const make = () => `demo-${crypto.randomUUID()}`;
  try {
    let id = localStorage.getItem("holdsend-notes-user");
    if (!id) {
      id = make();
      localStorage.setItem("holdsend-notes-user", id);
    }
    return id;
  } catch {
    return make();
  }
}

const owner = demoUser();
await writeSignedInOwner(owner); // so the service worker sends only this person's notes
const isOnline = () => navigator.onLine !== false;

const store = await createWebStore({ name: OUTBOX_NAME });
const durable = await store.isDurable();
// Ask the browser not to clear waiting notes when space runs low.
if (durable) void requestPersistentStorage();
const outbox = new Outbox({ store, send: sendNote, isOnline });

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

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const child of children) node.append(child);
  return node;
}

function when(iso) {
  return iso ? new Date(iso).toLocaleString() : "unknown";
}

function notice(text) {
  $("notice").textContent = text;
}

/** Runs a person's action on one item, then tells them what happened. */
async function act(fn) {
  try {
    const message = await fn();
    notice(message ?? "");
  } catch (err) {
    notice(`That did not work: ${err instanceof Error ? err.message : String(err)}`);
  }
  flusher.kick();
  await renderOutbox();
}

const actions = {
  cancel: async (item) => {
    const result = await outbox.cancel(item.key);
    if (result === "in_flight") return "Too late to cancel: this note has started sending and may already be published. It will be finished, not sent twice.";
    return undefined;
  },
  approve: async (item) => {
    const result = await outbox.approve(item.key);
    return result?.newKey ? "Sending with a new key. If an earlier version reached the server, there may be two copies." : undefined;
  },
  retry: async (item) => {
    if (item.stuckReason === "key_conflict") {
      // A new key can publish a second copy if the server's request was an
      // earlier version of this note. Ask first.
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

function button(label, action, item) {
  return el("button", { type: "button", onclick: () => act(() => actions[action](item)) }, label);
}

async function renderOutbox() {
  // Only this person's notes: on a shared device, the outbox may hold others'.
  const entries = (await outbox.list()).filter((entry) => entry.item.owner === owner);
  const list = $("outbox");
  list.replaceChildren();
  $("outbox-empty").hidden = entries.length > 0;
  for (const { item, status } of entries) {
    const text = status === "stuck" ? STUCK_TEXT[item.stuckReason] ?? "Stopped." : STATUS_TEXT[status];
    const buttons = [];
    if (status === "waiting") buttons.push(button("Cancel", "cancel", item));
    if (status === "needs_confirmation") buttons.push(button("Send", "approve", item), button("Discard", "discard", item));
    if (status === "stuck") buttons.push(button("Try again", "retry", item), button("Discard", "discard", item));
    list.append(
      el(
        "li",
        { "data-status": status },
        el("p", { class: "note-text" }, item.payload.text),
        el("p", { class: "meta" }, `${text} · written ${new Date(item.writtenAt).toLocaleString()}`),
        ...buttons,
      ),
    );
  }
  return entries;
}

const FEED_CACHE = `holdsend-notes-feed:${owner}`;

function showFeed(notes) {
  const list = $("feed");
  list.replaceChildren();
  $("feed-empty").hidden = notes.length > 0;
  for (const note of notes) {
    list.append(
      el(
        "li",
        { "data-id": note.id },
        el("p", { class: "note-text" }, note.text),
        el("p", { class: "meta" }, `Written ${when(note.writtenAt)} (the writer's clock) · arrived ${when(note.arrivedAt)}`),
        el(
          "button",
          {
            type: "button",
            onclick: async () => {
              const res = await fetch(`/api/notes/${note.id}`, { method: "DELETE", headers: { "x-demo-user": owner } }).catch(() => null);
              notice(res?.ok ? "" : "Deleting needs a connection.");
              await renderFeed();
            },
          },
          "Delete",
        ),
      ),
    );
  }
}

async function renderFeed() {
  try {
    const res = await fetch("/api/notes", { headers: { "x-demo-user": owner }, cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const { notes } = await res.json();
    $("feed-note").textContent = "";
    showFeed(notes);
    try {
      localStorage.setItem(FEED_CACHE, JSON.stringify(notes));
    } catch {
      /* the offline copy is a nicety */
    }
  } catch {
    let saved = null;
    try {
      saved = JSON.parse(localStorage.getItem(FEED_CACHE) ?? "null");
    } catch {
      /* nothing saved */
    }
    $("feed-note").textContent = saved ? "Offline: showing the list as it was last loaded." : "Offline: the published list will load when the connection returns.";
    if (saved) showFeed(saved);
  }
}

function renderConnection() {
  $("connection").textContent = isOnline() ? "Online" : "Offline: notes are kept on this device and sent when the connection returns.";
  $("connection").dataset.online = String(isOnline());
}

/**
 * Registers a background sync while notes are waiting. The browser drops a
 * sync after a few failed tries, so this runs again whenever work is left.
 */
async function registerBackgroundSync() {
  if ((await renderOutbox()).length === 0) return;
  const support = await requestBackgroundSync({ tag: "holdsend" });
  $("background").textContent =
    support === "background"
      ? "This browser can also send waiting notes after you close the tab."
      : "This browser sends notes only while this page is open.";
}

const flusher = startAutoFlush(outbox, {
  owner,
  isOnline,
  lock: new SenderLock({ name: SENDER_LOCK }),
  onReport: (report) => {
    void renderOutbox();
    if (report === "skipped") return;
    if (report.sent > 0) void renderFeed();
    if (report.retry > 0 || report.busy > 0 || report.nextCheckInMs !== undefined) void registerBackgroundSync();
  },
});
outbox.subscribe(() => void renderOutbox());

$("compose").addEventListener("submit", async (event) => {
  event.preventDefault();
  const text = $("text").value.trim();
  if (!text) return;
  await outbox.add("note.create", { text }, { owner });
  $("text").value = "";
  flusher.kick();
  await registerBackgroundSync();
});

$("lose-answer").addEventListener("click", async () => {
  try {
    const res = await fetch("/api/demo/lose-next-answer", { method: "POST", headers: { "x-demo-user": owner } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    $("lose-answer-note").textContent = "The server will save your next note but drop its answer. Watch it still appear once.";
  } catch {
    $("lose-answer-note").textContent = "Needs a connection.";
  }
});

window.addEventListener("online", () => {
  renderConnection();
  void renderFeed();
  void registerBackgroundSync();
});
window.addEventListener("offline", renderConnection);
// Other tabs change the same outbox; look again now and then.
setInterval(() => void renderOutbox(), 2000);

if (!durable) $("durability").textContent = "This browser cannot keep notes on the device. Anything waiting is lost if you close the tab.";
renderConnection();
await renderFeed();
await registerBackgroundSync();

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(() => undefined);
}
document.body.dataset.ready = "true";
