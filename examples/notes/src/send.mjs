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
