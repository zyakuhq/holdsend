// Loads the four built packages and runs one write through each store, on
// whatever Node runs this script. CI runs it on the oldest Node the packages
// support (see "engines"), because the tests themselves need a newer one.
//
//   npm run build && node scripts/smoke-node.mjs
//
// The scenario is the one HoldSend exists for: the server's answer to the
// first attempt is lost, the item is sent again with the same key, and the
// server publishes it exactly once.
//
// It also loads the subpaths and helpers added after 0.1 (emergency
// messages, drafts, the background flush), because a release is the first
// time `@holdsend/server` loads `@holdsend/core/drafts` from npm instead of
// from this repository.
import "fake-indexeddb/auto";
import assert from "node:assert/strict";
import { MemoryStore, Outbox } from "@holdsend/core";
import { EmergencyOutbox, smsLink } from "@holdsend/core/emergency";
import { editLinks, readDraft } from "@holdsend/core/drafts";
import { MemoryDraftLog, MemoryIdempotencyStore, acceptDraftUpdate, handleIdempotent, readDraftState } from "@holdsend/server";
import { createWebStore } from "@holdsend/web";
import { KeyValueStore, runBackgroundFlush } from "@holdsend/react-native";

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

// Emergency messages: the same words tapped twice are one message, and it is sent once.
{
  const sent = [];
  const emergency = new EmergencyOutbox({
    store: new MemoryStore(),
    policy: { claimRenewMs: 0 },
    send: async (item) => {
      sent.push(item.payload.text);
      return { type: "sent" };
    },
  });
  const first = await emergency.write("Smoke test, not real", { owner: "smoke-person" });
  const again = await emergency.write("smoke test,  NOT real", { owner: "smoke-person" });
  assert.equal(again.duplicate, true, "emergency: same words are one message");
  assert.equal(again.item.key, first.item.key, "emergency: same key");
  await emergency.outbox.flush();
  assert.deepEqual(sent, ["Smoke test, not real"], "emergency: sent once");
  assert.equal(smsLink("+15550100", "a+b"), "sms:+15550100?body=a%2Bb", "emergency: smsLink");
  console.log("smoke: @holdsend/core/emergency ok");
}

// Drafts: two devices edit from the same base; both edits are kept, a retry adds nothing.
{
  const store = new MemoryIdempotencyStore();
  const log = new MemoryDraftLog();
  const put = (key, update) =>
    acceptDraftUpdate({ store, log, owner: "smoke-person", headers: { "Idempotency-Key": key }, update, waitMs: 0 });
  assert.equal((await put("smoke-base-01", { draftId: "d1", reason: "edit", payload: "base" })).status, 201);
  await put("smoke-phone-1", { draftId: "d1", reason: "edit", baseRev: 1, payload: "phone" });
  await put("smoke-laptop1", { draftId: "d1", reason: "edit", baseRev: 1, payload: "laptop" });
  await put("smoke-laptop1", { draftId: "d1", reason: "edit", baseRev: 1, payload: "laptop" });
  const state = await readDraftState(log, "smoke-person", "d1");
  assert.equal(state.conflicted, true, "drafts: two heads are a conflict");
  assert.deepEqual(state.unresolved.map((u) => u.payload).sort(), ["laptop", "phone"], "drafts: both edits kept, once each");
  const again = readDraft(await log.list("smoke-person", "d1"), "d1");
  assert.equal(again.heads.length, 2, "drafts: readDraft on the device agrees");
  assert.equal(editLinks(again).resolves, undefined, "drafts: editLinks never closes a head");
  console.log("smoke: drafts (core and server) ok");
}

// Background flush: one time-limited flush sends what waits.
{
  let sent = 0;
  const outbox = new Outbox({
    store: new KeyValueStore(memoryKeyValue()),
    policy: { claimRenewMs: 0 },
    send: async () => {
      sent += 1;
      return { type: "sent" };
    },
  });
  await outbox.add("note", { text: "waiting" });
  const result = await runBackgroundFlush(outbox);
  assert.equal(result.outcome, "done", "background: done");
  assert.equal(sent, 1, "background: sent once");
  console.log("smoke: runBackgroundFlush ok");
}

console.log(`smoke: all four packages work on Node ${process.version}`);
