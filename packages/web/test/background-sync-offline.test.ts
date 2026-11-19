import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it } from "vitest";
import { Outbox } from "@holdsend/core";
import { IndexedDbStore, onBackgroundSync } from "../src/index.js";

type Payload = { text: string };

function sync(outbox: Outbox<Payload>) {
  let waited!: Promise<unknown>;
  expect(onBackgroundSync({ tag: "holdsend", waitUntil: (promise) => { waited = promise; } }, () => outbox.flush("person"))).toBe(true);
  return waited;
}

describe("Background Sync interrupted by lost connectivity", () => {
  it("rejects after one success when another publication remains in IndexedDB, then recovers it once", async () => {
    const indexedDB = new IDBFactory();
    const name = "offline-between-items";
    const store = new IndexedDbStore<Payload>({ name, indexedDB });
    let online = true;
    const sent: string[] = [];
    const outbox = new Outbox<Payload>({
      store,
      isOnline: () => online,
      policy: { claimRenewMs: 0 },
      send: async (item) => {
        sent.push(item.payload.text);
        if (item.payload.text === "first") online = false;
        return { type: "sent" };
      },
    });
    await outbox.add("post.create", { text: "first" }, { owner: "person" });
    await outbox.add("post.create", { text: "second" }, { owner: "person" });

    await expect(sync(outbox)).rejects.toThrow(/still waiting/);
    expect(sent).toEqual(["first"]);
    store.close();
    const reopened = new IndexedDbStore<Payload>({ name, indexedDB });
    expect((await reopened.read()).map((item) => [item.payload.text, item.state])).toEqual([["second", "waiting"]]);

    online = true;
    const restarted = new Outbox<Payload>({
      store: reopened,
      isOnline: () => online,
      policy: { claimRenewMs: 0 },
      send: async (item) => { sent.push(item.payload.text); return { type: "sent" }; },
    });
    await expect(sync(restarted)).resolves.toMatchObject({ sent: 1 });
    expect(sent).toEqual(["first", "second"]);
    expect(await reopened.read()).toHaveLength(0);
  });

  it("rejects when a ready item is present but the flush starts offline", async () => {
    const store = new IndexedDbStore<Payload>({ name: "offline-at-start", indexedDB: new IDBFactory() });
    const outbox = new Outbox<Payload>({ store, isOnline: () => false, send: async () => { throw new Error("must not send"); } });
    await outbox.add("post.create", { text: "waiting" }, { owner: "person" });
    await expect(sync(outbox)).rejects.toThrow(/still waiting/);
    expect((await store.read()).map((item) => item.state)).toEqual(["waiting"]);
  });

  it("fulfills when both publications finish online", async () => {
    const store = new IndexedDbStore<Payload>({ name: "all-sent", indexedDB: new IDBFactory() });
    const outbox = new Outbox<Payload>({ store, send: async () => ({ type: "sent" }), policy: { claimRenewMs: 0 } });
    await outbox.add("post.create", { text: "first" }, { owner: "person" });
    await outbox.add("post.create", { text: "second" }, { owner: "person" });
    await expect(sync(outbox)).resolves.toEqual({ sent: 2, retry: 0, busy: 0, stuck: 0 });
    expect(await store.read()).toHaveLength(0);
  });

  it("does not retry an item that requires a person's confirmation", async () => {
    const store = new IndexedDbStore<Payload>({ name: "held-item", indexedDB: new IDBFactory() });
    const outbox = new Outbox<Payload>({ store, isOnline: () => false, send: async () => { throw new Error("must not send"); } });
    await outbox.add("post.create", { text: "held" }, { owner: "person", decide: () => "hold" });
    await expect(sync(outbox)).resolves.toEqual({ sent: 0, retry: 0, busy: 0, stuck: 0 });
    expect((await store.read()).map((item) => item.state)).toEqual(["waiting"]);
  });
});
