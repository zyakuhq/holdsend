// The drafts page: one draft edited on more than one device. Each edit is an
// outbox item. The page reads the server's log with readDraft; when two edits
// share a base it shows every open version and a person chooses. Nothing is
// merged for them and nothing is dropped.
import { Outbox } from "@holdsend/core";
import { editLinks, readDraft, resolveLinks } from "@holdsend/core/drafts";
import { SenderLock, createWebStore, startAutoFlush } from "@holdsend/web";
import { DRAFTS_LOCK, DRAFTS_NAME, sendDraftUpdate } from "./send.mjs";
import { demoUser } from "./session.mjs";

const $ = (id) => document.getElementById(id);

const DRAFT_ID = "shared";
const owner = demoUser();
const isOnline = () => navigator.onLine !== false;

const store = await createWebStore({ name: DRAFTS_NAME });
const outbox = new Outbox({ store, send: sendDraftUpdate, isOnline });

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const child of children) node.append(child);
  return node;
}

const when = (ms) => (ms ? new Date(ms).toLocaleString() : "unknown time");
const notice = (text) => {
  $("notice").textContent = text;
};

/** The server's log, kept on this device so the page also opens offline. */
const LOG_KEY = `holdsend-notes-draft-log:${owner}`;
let log = [];
try {
  const saved = JSON.parse(localStorage.getItem(LOG_KEY) ?? "[]");
  if (Array.isArray(saved)) log = saved;
} catch {
  /* start empty */
}

const maxRev = (list) => list.reduce((m, u) => Math.max(m, u.rev), 0);
let refreshSeq = 0;

async function refreshLog() {
  if (!isOnline()) return;
  const mySeq = ++refreshSeq;
  try {
    const res = await fetch(`/api/drafts/${DRAFT_ID}`, { headers: { "x-demo-user": owner }, cache: "no-store" });
    if (!res.ok) return;
    const updates = (await res.json()).updates;
    // An older answer that arrives last must not replace a newer one.
    if (mySeq < refreshSeq && maxRev(updates) <= maxRev(log)) return;
    if (maxRev(updates) < maxRev(log)) return;
    log = updates;
    try {
      localStorage.setItem(LOG_KEY, JSON.stringify(log));
    } catch {
      /* storage full or blocked: the page still works while it is open */
    }
  } catch {
    /* offline: keep the last log */
  }
}

/** This device's own updates that the server has not shown yet, oldest first. */
async function pending() {
  const known = new Set(log.map((u) => u.id));
  return (await outbox.list()).filter((e) => e.item.owner === owner && e.item.kind === "draft.update" && !known.has(e.item.key));
}

/**
 * Own updates added in this page that the log does not show yet. An update
 * leaves the outbox when it is sent, a moment before the log is read again;
 * until the log has it, it still counts as this device's latest edit, so a
 * quick second edit sits on it (not on a stale head) and nobody settles twice.
 * An entry that is in neither the outbox nor the log for 10 s is dropped
 * (discarded or lost), so it cannot block forever.
 */
const unconfirmed = new Map(); // key -> { reason, seenQueued }
async function syncUnconfirmed() {
  const known = new Set(log.map((u) => u.id));
  const queued = new Set((await pending()).map((e) => e.item.key));
  const now = Date.now();
  for (const [key, info] of unconfirmed) {
    if (known.has(key)) unconfirmed.delete(key);
    else if (queued.has(key)) info.seenQueued = now;
    else if (now - info.seenQueued > 10_000) unconfirmed.delete(key);
  }
}
/** This device's latest own edit the log does not show: from the outbox (survives a reload), else added in this page. */
async function ownLatest() {
  const queued = await pending();
  return queued.length ? queued[queued.length - 1].item.key : [...unconfirmed.keys()].pop();
}
/** True while this device has an edit the log does not show, in the outbox or just sent. */
async function hasUnsent() {
  await syncUnconfirmed();
  return unconfirmed.size > 0 || (await pending()).length > 0;
}
let shownHeadIds = []; // the heads on screen when the person chose
const settlingNow = () => [...unconfirmed.values()].some((i) => i.reason === "resolve");

async function addUpdate({ reason, text, links }) {
  const writtenAt = Date.now();
  // The outbox key is the update id, so a retry is the same update.
  const item = await outbox.add("draft.update", { draftId: DRAFT_ID, ...links, reason, writtenAt, payload: { text } }, { owner, writtenAt });
  unconfirmed.set(item.key, { reason, seenQueued: Date.now() });
}

async function act(fn) {
  try {
    notice((await fn()) ?? "");
  } catch (err) {
    notice(`That did not work: ${err instanceof Error ? err.message : String(err)}`);
  }
  flusher.kick();
  await render();
  document.body.dataset.saves = String(Number(document.body.dataset.saves ?? 0) + 1);
}

let composeTouched = false;
let combinedTouched = false;
let lastCombinedFrom = "";

async function render() {
  await syncUnconfirmed();
  const state = readDraft(log, DRAFT_ID);
  const waiting = await pending();
  const settling = settlingNow();

  // The draft box shows the newest text, unless the person has started typing.
  const mine = waiting.length ? waiting[waiting.length - 1].item.payload.payload.text : undefined;
  const shown = mine ?? state.latest?.payload?.text ?? "";
  if (!composeTouched && document.activeElement !== $("text")) $("text").value = shown;

  const conflicted = state.conflicted && !settling;
  $("conflict").hidden = !conflicted;
  $("compose").hidden = conflicted;
  if (conflicted) shownHeadIds = state.heads.map((h) => h.id);
  if (conflicted) {
    $("conflict-note").textContent = `${state.heads.length} edits were made from the same earlier version, so both are kept. Choose one, or write a version that uses both. The others stay in the history.`;
    $("heads").replaceChildren(
      ...state.unresolved.map((head, n) =>
        el(
          "li",
          { "data-head": head.id },
          el("p", { class: "meta" }, `Version ${n + 1} · written ${when(head.writtenAt)} on the writer's clock · arrived as revision ${head.rev}`),
          el("p", { class: "note-text" }, head.payload?.text ?? ""),
          el(
            "button",
            { type: "button", "data-action": "keep", onclick: () => act(() => keep(head.id)) },
            `Keep version ${n + 1}`,
          ),
        ),
      ),
    );
    const joined = state.unresolved.map((h) => h.payload?.text ?? "").join("\n\n---\n\n");
    // Refill only if the versions changed and the person has not typed.
    if (!combinedTouched && lastCombinedFrom !== joined) {
      $("combined").value = joined;
      lastCombinedFrom = joined;
    }
  } else {
    combinedTouched = false;
    lastCombinedFrom = "";
  }

  $("outbox-empty").hidden = waiting.length > 0;
  $("outbox").replaceChildren(
    ...waiting.map(({ item, status }) =>
      el(
        "li",
        { "data-status": status, "data-reason": item.payload.reason },
        el("p", { class: "note-text" }, item.payload.payload.text),
        el("p", { class: "meta" }, `${item.payload.reason} · ${status === "stuck" ? "Stopped: the server did not take it." : "waiting to be sent"} · written ${when(item.writtenAt)}`),
        ...(status === "stuck"
          ? [
              el("button", { type: "button", "data-action": "retry", onclick: () => act(async () => void (await outbox.retry(item.key))) }, "Try again"),
              el("button", { type: "button", "data-action": "discard", onclick: () => act(async () => void (await outbox.discard(item.key))) }, "Discard"),
            ]
          : []),
      ),
    ),
  );
  $("history-note").textContent = log.length === 0 ? "Nothing on the server yet." : `${log.length} edit${log.length === 1 ? "" : "s"}, all kept.`;
  $("history").replaceChildren(
    ...log.map((u) =>
      el(
        "li",
        { "data-id": u.id, "data-reason": u.reason },
        el("p", { class: "meta" }, `Revision ${u.rev} · ${u.reason} · written ${when(u.writtenAt)}${u.resolves?.length ? ` · settles ${u.resolves.length} other${u.resolves.length === 1 ? "" : "s"}` : ""}`),
        el("p", { class: "note-text" }, u.payload?.text ?? ""),
      ),
    ),
  );
  return state;
}

/** A person chose one version: base on it, close the others. */
async function keep(headId) {
  if (await hasUnsent()) return "Your own edits are not on the server yet. Settle this after they are.";
  const state = readDraft(log, DRAFT_ID);
  const head = state.heads.find((h) => h.id === headId);
  if (!head) return "That version is no longer open. Look again.";
  await addUpdate({ reason: "resolve", text: head.payload?.text ?? "", links: resolveLinks(state, headId, shownHeadIds) });
  return "Saved your choice. It is sent when the connection allows.";
}

$("compose").addEventListener("submit", (event) => {
  event.preventDefault();
  void act(async () => {
    const text = $("text").value;
    const state = readDraft(log, DRAFT_ID);
    await syncUnconfirmed();
    const last = await ownLatest();
    // An edit sits on this device's own latest unsent edit, so two offline
    // edits from one phone are one line, not a conflict with itself.
    await addUpdate({ reason: "edit", text, links: editLinks(state, last ? { id: last } : undefined) });
    composeTouched = false;
    return isOnline() ? "" : "Saved on this device. It is sent when the connection returns.";
  });
});

$("combine").addEventListener("submit", (event) => {
  event.preventDefault();
  void act(async () => {
    if (await hasUnsent()) return "Your own edits are not on the server yet. Settle this after they are.";
    const state = readDraft(log, DRAFT_ID);
    if (!state.conflicted) return "Nothing to settle any more.";
    await addUpdate({ reason: "resolve", text: $("combined").value, links: resolveLinks(state, undefined, shownHeadIds) });
    combinedTouched = false;
    return "Saved. It is sent when the connection allows.";
  });
});

$("text").addEventListener("input", () => {
  composeTouched = true;
});
$("combined").addEventListener("input", () => {
  combinedTouched = true;
});

const flusher = startAutoFlush(outbox, {
  owner,
  isOnline,
  lock: new SenderLock({ name: DRAFTS_LOCK }),
  onReport: (report) => {
    if (report !== "skipped" && report.sent > 0) void refreshLog().then(render);
    else void render();
  },
});
outbox.subscribe(() => void render());

function renderConnection() {
  $("connection").textContent = isOnline() ? "Online" : "Offline: edits are kept on this device.";
  $("connection").dataset.online = String(isOnline());
}
window.addEventListener("online", () => {
  renderConnection();
  void refreshLog().then(render);
});
window.addEventListener("offline", renderConnection);
// Another device's edits and other tabs change the draft; look again now and then.
setInterval(() => void refreshLog().then(render), 2000);

renderConnection();
await refreshLog();
await render();
document.body.dataset.ready = "true";
