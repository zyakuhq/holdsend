// The service worker: keeps the page available offline, and sends waiting
// notes in the background on browsers that support Background Sync.
import { Outbox } from "@holdsend/core";
import { IndexedDbStore, SenderLock, onBackgroundSync } from "@holdsend/web";
import { EMERGENCY_LOCK, EMERGENCY_NAME, EMERGENCY_TAG, OUTBOX_NAME, SENDER_LOCK, sendEmergency, sendNote } from "./send.mjs";
import { readSignedInOwner } from "./session.mjs";

const CACHE = "holdsend-notes-v2";
const SHELL = ["/", "/app.js", "/emergency", "/emergency.js"];
const NETWORK_WAIT_MS = 3000;

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) => Promise.all(names.filter((n) => n !== CACHE).map((n) => caches.delete(n))))
      .then(() => self.clients.claim()),
  );
});

/** The network's answer, or the cached copy when the network fails or is too slow. */
async function networkFirst(request) {
  const cache = await caches.open(CACHE);
  const network = fetch(request).then((response) => {
    if (response.ok) void cache.put(request, response.clone());
    return response;
  });
  const slow = new Promise((resolve) => setTimeout(() => resolve(null), NETWORK_WAIT_MS));
  try {
    const first = await Promise.race([network, slow]);
    if (first) return first;
    // Too slow: use the cache if there is a copy, otherwise keep waiting.
    return (await cache.match(request)) ?? (await network);
  } catch {
    return (await cache.match(request)) ?? Response.error();
  }
}

// The page and its script: network first, so a new version shows up at once,
// and the cached copy when there is no network. The API is never cached.
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== self.location.origin || !SHELL.includes(url.pathname)) return;
  event.respondWith(networkFirst(event.request));
});

const isOnline = () => self.navigator.onLine !== false;
const outbox = new Outbox({ store: new IndexedDbStore({ name: OUTBOX_NAME }), send: sendNote, isOnline });
// A plain Outbox is enough for emergency messages: whether a message is
// held, and when it must ask first, are stored with each message.
const emergencyOutbox = new Outbox({ store: new IndexedDbStore({ name: EMERGENCY_NAME }), send: sendEmergency, isOnline });

/** Sends the signed-in person's items from one queue once no tab is sending it. */
async function flushInBackground(queue, lockName) {
  const owner = await readSignedInOwner();
  if (owner === null) return undefined; // nobody signed in: send nothing
  const locks = self.navigator.locks;
  if (locks?.request) {
    // Wait for a tab that is sending right now, then send what is left. A
    // sync must not end early just because a tab was busy: the tab may be
    // closed before its attempt gets an answer.
    return locks.request(lockName, () => queue.flush(owner));
  }
  const run = await new SenderLock({ name: lockName }).run(() => queue.flush(owner));
  // Without Web Locks we cannot wait. Report work left so the browser tries again.
  return run.ran ? run.value : { sent: 0, retry: 1, busy: 0, stuck: 0 };
}

self.addEventListener("sync", (event) => {
  if (onBackgroundSync(event, () => flushInBackground(emergencyOutbox, EMERGENCY_LOCK), { tag: EMERGENCY_TAG })) return;
  onBackgroundSync(event, () => flushInBackground(outbox, SENDER_LOCK));
});
