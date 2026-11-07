// How a note is sent. Shared by the page and the service worker.
import { classifyResponse } from "@holdsend/core";

export const OUTBOX_NAME = "holdsend-notes-example";
/** One name for the page and the worker, so only one of them sends at a time. */
export const SENDER_LOCK = `${OUTBOX_NAME}-sender`;

/** Posts one note. The outbox adds the Idempotency-Key and Written-At headers. */
export async function sendNote(item, { headers, signal }) {
  const res = await fetch("/api/notes", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers, "x-demo-user": item.owner },
    body: JSON.stringify(item.payload),
    signal,
  });
  const body = await res.json().catch(() => ({}));
  return classifyResponse(res.status, body.code, body.message);
}

/** The emergency queue: its own database, sender lock and background sync tag. */
export const EMERGENCY_NAME = `${OUTBOX_NAME}-emergency`;
export const EMERGENCY_LOCK = `${EMERGENCY_NAME}-sender`;
export const EMERGENCY_TAG = "holdsend-emergency";

/** Posts one emergency message, with the same headers as a note. */
export async function sendEmergency(item, { headers, signal }) {
  const res = await fetch("/api/emergency-messages", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers, "x-demo-user": item.owner },
    body: JSON.stringify(item.payload),
    signal,
  });
  const body = await res.json().catch(() => ({}));
  return classifyResponse(res.status, body.code, body.message);
}

/** The drafts queue: its own database and sender lock. */
export const DRAFTS_NAME = `${OUTBOX_NAME}-drafts`;
export const DRAFTS_LOCK = `${DRAFTS_NAME}-sender`;

/** Sends one draft update. The outbox key is the update's id. */
export async function sendDraftUpdate(item, { headers, signal }) {
  const res = await fetch(`/api/drafts/${encodeURIComponent(item.payload.draftId)}`, {
    method: "PUT",
    headers: { "content-type": "application/json", ...headers, "x-demo-user": item.owner },
    body: JSON.stringify(item.payload),
    signal,
  });
  const body = await res.json().catch(() => ({}));
  return classifyResponse(res.status, body.code ?? body.error, body.message);
}
