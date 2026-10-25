// Who is signed in, kept in IndexedDB so the service worker can read it too.
//
// The worker has no session of its own. It must send only the signed-in
// person's notes: on a shared device, another person's queued notes must
// never go out under this person's session.
const DB = "holdsend-notes-session";
const STORE = "session";

function open() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function run(mode, fn) {
  const db = await open();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const request = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(request.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

/** The signed-in owner id, or null. Never throws. */
export async function readSignedInOwner() {
  try {
    return (await run("readonly", (s) => s.get("owner"))) ?? null;
  } catch {
    return null;
  }
}

/** Records who is signed in (call on sign-in; pass null on sign-out). Never throws. */
export async function writeSignedInOwner(owner) {
  try {
    await run("readwrite", (s) => (owner === null ? s.delete("owner") : s.put(owner, "owner")));
  } catch {
    /* the worker then sends nothing, which is the safe side */
  }
}
