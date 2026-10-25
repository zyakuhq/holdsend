import { afterEach, describe, expect, it, vi } from "vitest";
import { Outbox } from "@holdsend/core";
import { CorruptOutboxError, KeyValueStore, fromMmkv, startNativeAutoFlush, type AsyncKeyValue, type MmkvLike } from "../src/index.js";
import { FakeServer } from "../../core/test/fake-server.js";

type Payload = { text: string };

/** AsyncStorage-like: every call yields to the event loop, like the real bridge. */
function fakeAsyncStorage(): AsyncKeyValue & { data: Map<string, string>; failReads: boolean; failWrites: boolean } {
  const data = new Map<string, string>();
  const tick = () => new Promise((r) => setTimeout(r, Math.floor(Math.random() * 3)));
  const s = {
    data,
    failReads: false,
    failWrites: false,
    async getItem(k: string) {
      await tick();
      if (s.failReads) throw new Error("storage read failed");
      return data.get(k) ?? null;
    },
    async setItem(k: string, v: string) {
      await tick();
      if (s.failWrites) throw new Error("disk full");
      data.set(k, v);
    },
    async removeItem(k: string) {
      await tick();
      data.delete(k);
    },
  };
  return s;
}

function fakeMmkv(): MmkvLike & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, getString: (k) => data.get(k), set: (k, v) => void data.set(k, v), delete: (k) => void data.delete(k) };
}

const item = (key: string) => ({ key, kind: "k", payload: { text: key }, writtenAt: 1, state: "waiting" as const, attempts: 0, touched: false });

describe("KeyValueStore", () => {
  it("survives an app restart (a new store over the same storage)", async () => {
    const storage = fakeAsyncStorage();
    const outbox = new Outbox<Payload>({ store: new KeyValueStore(storage), send: async () => ({ type: "sent" }), policy: { claimRenewMs: 0 } });
    await outbox.add("post.create", { text: "written in a dead zone" });
    const restarted = new KeyValueStore<Payload>(storage);
    expect((await restarted.read())[0]?.payload.text).toBe("written in a dead zone");
  });

  it("keeps every concurrent change, even from two store instances on the same key", async () => {
    const storage = fakeAsyncStorage();
    const a = new KeyValueStore<Payload>(storage);
    const b = new KeyValueStore<Payload>(storage);
    await a.update((items) => void items.push(item("item-key-0001")));
    await Promise.all(Array.from({ length: 40 }, (_, n) => (n % 2 ? a : b).update((items) => void (items[0]!.attempts += 1))));
    expect((await a.read())[0]?.attempts).toBe(40);
  });

  it("never overwrites the queue when a read fails", async () => {
    const storage = fakeAsyncStorage();
    const store = new KeyValueStore<Payload>(storage);
    await store.update((items) => void items.push(item("item-key-0001")));
    storage.failReads = true;
    await expect(store.update((items) => void items.push(item("item-key-0002")))).rejects.toThrow("storage read failed");
    storage.failReads = false;
    expect((await store.read()).map((i) => i.key)).toEqual(["item-key-0001"]);
  });

  it("refuses to treat corrupt data as an empty queue, and leaves it untouched", async () => {
    const storage = fakeAsyncStorage();
    storage.data.set("holdsend:outbox", "{not json");
    const store = new KeyValueStore<Payload>(storage);
    await expect(store.update((items) => void items.push(item("item-key-0001")))).rejects.toBeInstanceOf(CorruptOutboxError);
    expect(storage.data.get("holdsend:outbox")).toBe("{not json");
    storage.data.set("holdsend:outbox", '{"an":"object"}');
    await expect(store.read()).rejects.toBeInstanceOf(CorruptOutboxError);
  });

  it("reports a failed write (for example a full disk) and keeps going afterwards", async () => {
    const storage = fakeAsyncStorage();
    const store = new KeyValueStore<Payload>(storage);
    storage.failWrites = true;
    await expect(store.update((items) => void items.push(item("item-key-0001")))).rejects.toThrow("disk full");
    storage.failWrites = false;
    await store.update((items) => void items.push(item("item-key-0002")));
    expect((await store.read()).map((i) => i.key)).toEqual(["item-key-0002"]);
  });

  it("refuses asynchronous changes and duplicate keys", async () => {
    const store = new KeyValueStore<Payload>(fakeAsyncStorage());
    await expect(store.update(async () => undefined)).rejects.toThrow(/synchronous/);
    await expect(store.update((items) => void items.push(item("item-key-0001"), item("item-key-0001")))).rejects.toThrow(/duplicate/);
    expect(await store.read()).toHaveLength(0);
  });

  it("works over MMKV, sharing one adapter per instance", async () => {
    const mmkv = fakeMmkv();
    expect(fromMmkv(mmkv)).toBe(fromMmkv(mmkv));
    const server = new FakeServer();
    let now = Date.parse("2026-10-25T12:00:00Z");
    const outbox = new Outbox<Payload>({ store: new KeyValueStore(fromMmkv(mmkv)), now: () => now, send: server.sender({ loseResponses: 1 }), policy: { claimRenewMs: 0 } });
    await outbox.add("post.create", { text: "mmkv" });
    await outbox.flush();
    now += 1000; // past the first retry delay
    await outbox.flush();
    expect(server.created).toHaveLength(1);
    expect(JSON.parse(mmkv.data.get("holdsend:outbox")!)).toEqual([]);
  });

  it("reports durability honestly", async () => {
    expect(await new KeyValueStore(fakeAsyncStorage()).isDurable()).toBe(true);
    const broken = fakeAsyncStorage();
    broken.failWrites = true;
    expect(await new KeyValueStore(broken).isDurable()).toBe(false);
  });
});

describe("startNativeAutoFlush", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("sends when connectivity returns and when the app comes to the foreground", async () => {
    vi.useFakeTimers();
    const sends: string[] = [];
    const outbox = new Outbox<Payload>({
      store: new KeyValueStore(fromMmkv(fakeMmkv())),
      policy: { claimRenewMs: 0 },
      send: async (i) => {
        sends.push(i.payload.text);
        return { type: "sent" };
      },
    });
    let connectivity!: (connected: boolean) => void;
    let foreground!: () => void;
    const unsubscribed: string[] = [];
    const flusher = startNativeAutoFlush(outbox, {
      onConnectivityChange: (cb) => {
        connectivity = cb;
        return () => unsubscribed.push("net");
      },
      onForeground: (cb) => {
        foreground = cb;
        return () => unsubscribed.push("app");
      },
    });
    connectivity(false);
    await outbox.add("post.create", { text: "offline note" });
    flusher.kick();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sends).toEqual([]);

    connectivity(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(sends).toEqual(["offline note"]);

    await outbox.add("post.create", { text: "second" });
    foreground();
    await vi.advanceTimersByTimeAsync(0);
    expect(sends).toEqual(["offline note", "second"]);

    flusher.stop();
    expect(unsubscribed.sort()).toEqual(["app", "net"]);
  });
});

describe("audit 11: a queue too large for Android's AsyncStorage", () => {
  it("is refused before writing, and everything already queued stays usable", async () => {
    const { OutboxTooLargeError } = await import("../src/index.js");
    const storage = fakeAsyncStorage();
    const store = new KeyValueStore<Payload>(storage, { maxBytes: 2_000 });
    await store.update((items) => void items.push(item("item-key-0001")));
    await expect(store.update((items) => void items.push({ ...item("item-key-0002"), payload: { text: "é".repeat(1_500) } }))).rejects.toBeInstanceOf(OutboxTooLargeError);
    expect((await store.read()).map((i) => i.key)).toEqual(["item-key-0001"]);
    const unlimited = new KeyValueStore<Payload>(fakeAsyncStorage(), { maxBytes: Infinity });
    await unlimited.update((items) => void items.push({ ...item("item-key-0003"), payload: { text: "x".repeat(10_000) } }));
  });
});

describe("second audit N2: an outbox at the size limit", () => {
  it("still lets items be sent, settled and removed, and only refuses new ones", async () => {
    const { OutboxTooLargeError } = await import("../src/index.js");
    const storage = fakeAsyncStorage();
    const big = { ...item("item-key-0001"), payload: { text: "x".repeat(1_900) } };
    await new KeyValueStore<Payload>(storage, { maxBytes: Infinity }).update((items) => void items.push(big));
    // The limit is now below what is stored (for example after an app update lowered it).
    const store = new KeyValueStore<Payload>(storage, { maxBytes: 1_000 });
    await store.update((items) => {
      items[0]!.attempts += 1; // a claim or settle grows nothing
    });
    expect((await store.read())[0]?.attempts).toBe(1);
    await expect(store.update((items) => void items.push(item("item-key-0002")))).rejects.toBeInstanceOf(OutboxTooLargeError);
    await store.update((items) => void items.splice(0, 1));
    expect(await store.read()).toEqual([]);
  });
});
