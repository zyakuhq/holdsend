import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it } from "vitest";
import { MemoryStore, Outbox } from "@holdsend/core";
import { IndexedDbStore, createWebStore } from "../src/index.js";
import { FakeServer } from "../../core/test/fake-server.js";

type Payload = { text: string };

function tabs(n: number, name = "outbox-test") {
  const factory = new IDBFactory();
  return Array.from({ length: n }, () => new IndexedDbStore<Payload>({ name, indexedDB: factory }));
}

describe("IndexedDbStore", () => {
  it("keeps items across a reload (a new store on the same database)", async () => {
    const factory = new IDBFactory();
    const before = new IndexedDbStore<Payload>({ name: "reload", indexedDB: factory });
    const outbox = new Outbox<Payload>({ store: before, send: async () => ({ type: "sent" }), policy: { claimRenewMs: 0 } });
    await outbox.add("post.create", { text: "written with no signal" });
    before.close();

    const after = new IndexedDbStore<Payload>({ name: "reload", indexedDB: factory });
    const items = await after.read();
    expect(items).toHaveLength(1);
    expect(items[0]?.payload.text).toBe("written with no signal");
  });

  it("never loses a write when two tabs change the same item at the same time", async () => {
    const [a, b] = tabs(2);
    await a!.update((items) => {
      items.push({ key: "item-key-0001", kind: "k", payload: { text: "shared" }, writtenAt: 1, state: "waiting", attempts: 0, touched: false });
    });
    // Forty read-modify-writes of one field, alternating between tabs. A
    // store that read and wrote in separate steps would lose some of them.
    await Promise.all(
      Array.from({ length: 40 }, (_, n) =>
        (n % 2 === 0 ? a! : b!).update((items) => {
          items[0]!.attempts += 1;
        }),
      ),
    );
    expect((await a!.read())[0]?.attempts).toBe(40);
  });

  it("writes nothing when the change throws", async () => {
    const [store] = tabs(1);
    await store!.update((items) => {
      items.push({ key: "item-key-0001", kind: "k", payload: { text: "kept" }, writtenAt: 1, state: "waiting", attempts: 0, touched: false });
    });
    await expect(
      store!.update((items) => {
        items.length = 0;
        throw new Error("changed my mind");
      }),
    ).rejects.toThrow("changed my mind");
    expect(await store!.read()).toHaveLength(1);
  });

  it("refuses an asynchronous change, which IndexedDB could not keep atomic", async () => {
    const [store] = tabs(1);
    await expect(store!.update(async () => undefined)).rejects.toThrow(/synchronous/);
  });

  it("refuses to store two items under one key", async () => {
    const [store] = tabs(1);
    const item = { key: "item-key-0001", kind: "k", payload: { text: "a" }, writtenAt: 1, state: "waiting" as const, attempts: 0, touched: false };
    await expect(store!.update((items) => items.push(item, { ...item }))).rejects.toThrow(/duplicate/);
    expect(await store!.read()).toHaveLength(0);
  });

  it("handles a key changed in place (a retry after a key conflict)", async () => {
    const [store] = tabs(1);
    await store!.update((items) => {
      items.push({ key: "old-key-0001", kind: "k", payload: { text: "a" }, writtenAt: 1, state: "stuck", stuckReason: "key_conflict", attempts: 1, touched: true });
    });
    await store!.update((items) => {
      items[0]!.key = "new-key-0001";
    });
    expect((await store!.read()).map((i) => i.key)).toEqual(["new-key-0001"]);
  });

  it("sends every item exactly once when two tabs flush the same queue together", async () => {
    const server = new FakeServer();
    const [a, b] = tabs(2, "two-tabs");
    const tabA = new Outbox<Payload>({ store: a!, send: server.sender(), policy: { claimRenewMs: 0 } });
    const tabB = new Outbox<Payload>({ store: b!, send: server.sender(), policy: { claimRenewMs: 0 } });
    for (let n = 0; n < 15; n += 1) await (n % 2 ? tabA : tabB).add("post.create", { text: `note ${n}` });
    const [ra, rb] = await Promise.all([tabA.flush(), tabB.flush()]);
    expect(ra.sent + rb.sent).toBe(15);
    expect(server.requests).toBe(15);
    expect(server.created).toHaveLength(15);
    expect(await a!.read()).toHaveLength(0);
  });

  it("reports itself durable when writes read back", async () => {
    const [store] = tabs(1);
    expect(await store!.isDurable()).toBe(true);
  });
});

describe("createWebStore", () => {
  it("uses IndexedDB when it works", async () => {
    const store = await createWebStore({ name: "factory", indexedDB: new IDBFactory() });
    expect(store).toBeInstanceOf(IndexedDbStore);
  });

  it("falls back to an honest, non-durable memory store without IndexedDB", async () => {
    const broken = { open: () => { throw new Error("blocked"); } } as unknown as IDBFactory;
    const store = await createWebStore({ indexedDB: broken });
    expect(store).toBeInstanceOf(MemoryStore);
    expect(await store.isDurable()).toBe(false);
  });
});
