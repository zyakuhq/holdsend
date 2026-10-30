// The emergency page: short messages in their own queue. The first goes by
// itself when the connection returns; later ones wait for the person. A demo
// of a delivery aid, not an emergency service.
import { EmergencyOutbox, smsLink } from "@holdsend/core/emergency";
import { SenderLock, createWebStore, requestBackgroundSync, startAutoFlush } from "@holdsend/web";
import { EMERGENCY_LOCK, EMERGENCY_NAME, EMERGENCY_TAG, sendEmergency } from "./send.mjs";
import { demoUser, writeSignedInOwner } from "./session.mjs";

const $ = (id) => document.getElementById(id);

const owner = demoUser();
await writeSignedInOwner(owner); // so the service worker sends only this person's messages
const isOnline = () => navigator.onLine !== false;

const store = await createWebStore({ name: EMERGENCY_NAME });
const emergency = new EmergencyOutbox({ store, send: sendEmergency, isOnline });
const outbox = emergency.outbox;

const STUCK_TEXT = {
  attempts_exhausted: "Not sent: the server kept failing.",
  key_conflict: "Not sent: the server holds a different message under this key.",
  refused: "Not sent: the server refused it.",
  unreachable: "Not sent: the server could not be reached for a long time.",
};

function statusText(item, status) {
  if (status === "waiting") return "Will be sent by itself when the connection returns.";
  if (status === "sending") return "Sending.";
  if (status === "needs_confirmation") {
    return item.held && item.approvedAt === undefined
      ? "Waiting for you. It is not sent until you press Send."
      : "Written more than a day ago. Send it now, or discard it?";
  }
  if (status === "stuck") return STUCK_TEXT[item.stuckReason] ?? "Stopped.";
  return "Sent.";
}

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const child of children) node.append(child);
  return node;
}

function notice(text) {
  $("notice").textContent = text;
}

async function act(fn) {
  try {
    notice((await fn()) ?? "");
  } catch (err) {
    notice(`That did not work: ${err instanceof Error ? err.message : String(err)}`);
  }
  flusher.kick();
  await render();
}

/** The last message handed to SMS, so it can be put back. */
let handedOff = null;

const actions = {
  send: async (item) => {
    await emergency.send(item.key);
  },
  retry: async (item) => {
    await outbox.retry(item.key);
  },
  discard: async (item) => {
    const result = await outbox.discard(item.key);
    if (result === "discarded_may_exist") return "Removed from this device. An earlier attempt may have reached the server.";
    return undefined;
  },
  sms: async (item) => {
    const number = phoneNumber($("sms-number").value);
    if (number === null) return "Enter a phone number for the SMS first.";
    let link;
    try {
      link = smsLink(number, `${item.payload.text}\n(written ${new Date(item.writtenAt).toLocaleString()})`, {
        platform: /iPad|iPhone|iPod/.test(navigator.userAgent) ? "ios" : "other",
      });
    } catch {
      return "Enter a phone number for the SMS first.";
    }
    if (!link.startsWith("sms:")) return "Could not build the SMS link.";
    // Take it out of the queue first, so it cannot also arrive by data.
    const result = await outbox.cancel(item.key);
    handedOff = result === "cancelled" ? { text: item.payload.text, writtenAt: item.writtenAt } : null;
    $("sms-link").setAttribute("href", link);
    $("sms-note").textContent =
      result === "cancelled"
        ? "Removed from the queue, so it will not also be sent by data. Press send in your messaging app. If you don't, put it back."
        : "This message may already have been sent, so it may arrive twice.";
    $("sms-undo").hidden = handedOff === null;
    $("sms-handoff").hidden = false;
    return undefined;
  },
};

/**
 * The number as "+" and digits, rebuilt from numeric values, so nothing typed
 * in the field other than digits can reach the link. Null if it is not a
 * phone number. Keeps leading zeros (local numbers often start with one).
 */
function phoneNumber(typed) {
  const plus = typed.trim().startsWith("+");
  if (!/^\+?[0-9\s().-]+$/.test(typed.trim())) return null;
  const digits = typed.replace(/[^0-9]/g, "");
  if (digits.length < 5 || digits.length > 15) return null;
  const zeros = digits.length - digits.replace(/^0+/, "").length;
  const rest = digits.slice(zeros);
  return (plus ? "+" : "") + "0".repeat(zeros) + (rest === "" ? "" : String(Number(rest)));
}

function button(label, action, item) {
  const preview = item.payload.text.length > 40 ? `${item.payload.text.slice(0, 40)}…` : item.payload.text;
  return el("button", { type: "button", "aria-label": `${label}: ${preview}`, "data-action": action, onclick: () => act(() => actions[action](item)) }, label);
}

async function render() {
  const entries = (await outbox.list()).filter((entry) => entry.item.owner === owner);
  $("outbox").replaceChildren();
  $("outbox-empty").hidden = entries.length > 0;
  $("send-all").hidden = !entries.some((e) => e.status === "needs_confirmation");
  for (const { item, status } of entries) {
    const buttons = [];
    if (status === "needs_confirmation") buttons.push(button("Send", "send", item));
    if (status === "stuck") buttons.push(button("Try again", "retry", item));
    if (!item.touched) buttons.push(button("Send by SMS", "sms", item));
    if (status === "needs_confirmation" || status === "stuck") buttons.push(button("Discard", "discard", item));
    $("outbox").append(
      el(
        "li",
        { "data-status": status, "data-held": String(item.held === true && item.approvedAt === undefined) },
        el("p", { class: "note-text" }, item.payload.text),
        el("p", { class: "meta" }, `${statusText(item, status)} · written ${new Date(item.writtenAt).toLocaleString()}`),
        ...buttons,
      ),
    );
  }
  return entries;
}

async function renderReceived() {
  try {
    const res = await fetch("/api/emergency-messages", { headers: { "x-demo-user": owner }, cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const { messages } = await res.json();
    $("received-note").textContent = messages.length === 0 ? "Nothing received yet." : "";
    $("received").replaceChildren(
      ...messages.map((m) =>
        el(
          "li",
          {},
          el("p", { class: "note-text" }, m.text),
          el("p", { class: "meta" }, `Written ${new Date(m.writtenAt ?? m.arrivedAt).toLocaleString()} · arrived ${new Date(m.arrivedAt).toLocaleString()}`),
        ),
      ),
    );
  } catch {
    $("received-note").textContent = "Offline: the server's list loads when the connection returns.";
  }
}

function renderConnection() {
  $("connection").textContent = isOnline() ? "Online" : "Offline: messages are kept on this device.";
  $("connection").dataset.online = String(isOnline());
}

/** Says honestly whether this browser can send after the page is closed. */
async function registerBackgroundSync() {
  if ((await render()).length === 0) return;
  const support = await requestBackgroundSync({ tag: EMERGENCY_TAG });
  $("background").textContent =
    support === "background"
      ? "This browser can also send the first message after you close this page, while the browser is running."
      : "This browser sends messages only while this page is open. Use SMS if you have to leave.";
}

const flusher = startAutoFlush(outbox, {
  owner,
  isOnline,
  // Its own lock, so the notes queue sending never holds this one up.
  lock: new SenderLock({ name: EMERGENCY_LOCK }),
  onReport: (report) => {
    void render();
    if (report === "skipped") return;
    if (report.sent > 0) void renderReceived();
    if (report.retry > 0 || report.busy > 0 || report.nextCheckInMs !== undefined) void registerBackgroundSync();
  },
});
outbox.subscribe(() => void render());

$("compose").addEventListener("submit", (event) => {
  event.preventDefault();
  const text = $("text").value;
  if (!text.trim()) return;
  void act(async () => {
    const { duplicate, held } = await emergency.write(text, { owner });
    $("text").value = "";
    await registerBackgroundSync();
    if (duplicate) return "This message is already waiting. It will be sent once.";
    if (held) return "Saved. An earlier message is still waiting, so this one waits until you press Send.";
    return isOnline() ? "" : "Saved on this device. It will be sent by itself when the connection returns.";
  });
});

$("send-all").addEventListener("click", () =>
  act(async () => {
    await emergency.sendAll(owner);
    return undefined;
  }),
);

$("sms-undo").addEventListener("click", () =>
  act(async () => {
    if (!handedOff) return undefined;
    await emergency.write(handedOff.text, { owner, writtenAt: handedOff.writtenAt });
    handedOff = null;
    $("sms-handoff").hidden = true;
    return "Put back in the queue.";
  }),
);

window.addEventListener("online", () => {
  renderConnection();
  void renderReceived();
  void registerBackgroundSync();
});
window.addEventListener("offline", renderConnection);
// Other tabs and the service worker change the same queue; look again now and then.
setInterval(() => void render(), 2000);

renderConnection();
await renderReceived();
await registerBackgroundSync();
await render();

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(() => undefined);
}
document.body.dataset.ready = "true";
