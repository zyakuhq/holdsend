// Loads the four built packages and runs one write through each store, on
// whatever Node runs this script. CI runs it on the oldest Node the packages
// support (see "engines"), because the tests themselves need a newer one.
//
//   npm run build && node scripts/smoke-node.mjs
//
// The scenario is the one HoldSend exists for: the server's answer to the
// first attempt is lost, the item is sent again with the same key, and the
// server publishes it exactly once.
import "fake-indexeddb/auto";
import assert from "node:assert/strict";
import { MemoryStore, Outbox } from "@holdsend/core";
import { MemoryIdempotencyStore, handleIdempotent } from "@holdsend/server";
import { createWebStore } from "@holdsend/web";
import { KeyValueStore } from "@holdsend/react-native";

function memoryKeyValue() {
  const map = new Map();
  return {
    getItem: async (key) => map.get(key) ?? null,
    setItem: async (key, value) => {
      map.set(key, value);
    },
    removeItem: async (key) => {
      map.delete(key);
    },
  };
}

const stores = [
  ["MemoryStore", new MemoryStore()],
  ["IndexedDbStore", await createWebStore({ name: "holdsend-smoke", onFallback: (reason) => assert.fail(`fell back to memory: ${reason}`) })],
  ["KeyValueStore", new KeyValueStore(memoryKeyValue())],
];

for (const [name, store] of stores) {
  const server = new MemoryIdempotencyStore();
  let published = 0;
  let loseNextAnswer = true;
  let now = Date.parse("2026-10-27T12:00:00Z");

  const outbox = new Outbox({
    store,
    now: () => now,
    policy: { claimRenewMs: 0 },
    async send(item, { headers }) {
      const answer = await handleIdempotent({
        store: server,
        owner: "smoke-person",
        operation: "post.create",
        headers,
        content: item.payload,
        create: async () => {
          published += 1;
          return { status: 201, body: { id: published } };
        },
      });
      if (loseNextAnswer) {
        loseNextAnswer = false;
        throw new TypeError("the answer was lost on the way back");
      }
      return answer.status === 201 ? { type: "sent" } : { type: "retry" };
    },
  });

  await outbox.add("post.create", { text: "written offline" });
  await outbox.flush();
  now += 60_000;
  await outbox.flush();

  assert.equal(published, 1, `${name}: published exactly once`);
  assert.deepEqual(await outbox.list(), [], `${name}: nothing left waiting`);
  console.log(`smoke: ${name} ok`);
}

console.log(`smoke: all four packages work on Node ${process.version}`);
