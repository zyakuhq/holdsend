// Starts the React notes page: opens the outbox, then renders.
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Outbox } from "@holdsend/core";
import { createWebStore, requestPersistentStorage } from "@holdsend/web";
import { OUTBOX_NAME, sendNote } from "../../notes/src/send.mjs";
import { demoUser, writeSignedInOwner } from "../../notes/src/session.mjs";
import { App } from "./App.jsx";

const owner = demoUser();
await writeSignedInOwner(owner); // so the service worker sends only this person's notes

// One store and one outbox for the page's whole life, created before React
// renders, so re-renders and StrictMode's double effects never make a second one.
const store = await createWebStore({ name: OUTBOX_NAME });
const durable = await store.isDurable();
if (durable) void requestPersistentStorage();
const outbox = new Outbox({ store, send: sendNote, isOnline: () => navigator.onLine !== false });

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <App outbox={outbox} owner={owner} durable={durable} />
  </StrictMode>,
);

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(() => undefined);
}
