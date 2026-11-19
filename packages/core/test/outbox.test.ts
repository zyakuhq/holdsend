import { describe, expect, it } from "vitest";
import { MemoryStore, Outbox, classifyResponse, type OutboxItem, type Store } from "../src/index.js";
import { FakeServer } from "./fake-server.js";

type Payload = { text: string };

function clock(start = Date.parse("2026-10-25T12:00:00.000Z")) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

function setup(options: { loseResponses?: number; online?: () => boolean } = {}) {
  const server = new FakeServer();
  const store = new MemoryStore<Payload>();
  const time = clock();
  const outbox = new Outbox<Payload>({
    store,
    send: server.sender(options.loseResponses === undefined ? {} : { loseResponses: options.loseResponses }),
    now: time.now,
    policy: { claimRenewMs: 0 },
    ...(options.online ? { isOnline: options.online } : {}),
  });
  return { server, store, time, outbox };
}

describe("Outbox", () => {
  it("keeps items while offline and sends nothing", async () => {
    const { outbox, server } = setup({ online: () => false });
    await outbox.add("post.create", { text: "written with no signal" });
    const report = await outbox.flush();
    expect(report.sent).toBe(0);
    expect(server.requests).toBe(0);
    expect(await outbox.list()).toHaveLength(1);
  });

  it("publishes once when the connection returns, and removes the item", async () => {
    const { outbox, server } = setup();
    await outbox.add("post.create", { text: "hello" });
    const report = await outbox.flush();
    expect(report.sent).toBe(1);
    expect(server.created).toHaveLength(1);
    expect(await outbox.list()).toHaveLength(0);
  });

  it("creates exactly one copy when the first answer is lost", async () => {
    const { outbox, server, time } = setup({ loseResponses: 1 });
    await outbox.add("post.create", { text: "answer lost" });

    const first = await outbox.flush();
    expect(first.retry).toBe(1);
    expect(server.created).toHaveLength(1);
    expect(await outbox.list()).toHaveLength(1);

    time.advance(1000); // past the first retry delay
    const second = await outbox.flush();
    expect(second.sent).toBe(1);
    expect(server.requests).toBe(2);
    expect(server.created).toHaveLength(1);
  });

  it("sends each item once when two outboxes share a store and flush together", async () => {
    const server = new FakeServer();
    const store = new MemoryStore<Payload>();
    const a = new Outbox<Payload>({ store, send: server.sender(), policy: { claimRenewMs: 0 } });
    const b = new Outbox<Payload>({ store, send: server.sender(), policy: { claimRenewMs: 0 } });
    for (let n = 0; n < 20; n += 1) await a.add("post.create", { text: `note ${n}` });

    const [ra, rb] = await Promise.all([a.flush(), b.flush()]);
    expect(ra.sent + rb.sent).toBe(20);
    expect(server.requests).toBe(20);
    expect(server.created).toHaveLength(20);
  });

  it("folds a flush asked for during a flush into one more pass", async () => {
    const { outbox, server } = setup();
    await outbox.add("post.create", { text: "first" });
    const running = outbox.flush();
    await outbox.add("post.create", { text: "added meanwhile" });
    const again = outbox.flush();
    expect(again).toBe(running);
    await running;
    expect(server.created.map((r) => JSON.parse(r.body).text)).toEqual(["first", "added meanwhile"]);
  });

  it("keeps an offline remainder in the aggregate report when another caller queues a pass", async () => {
    const store = new MemoryStore<Payload>();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const checks = [true, false, true];
    const outbox = new Outbox<Payload>({
      store,
      isOnline: () => checks.shift() ?? true,
      policy: { claimRenewMs: 0 },
      send: async (item) => {
        if (item.payload.text === "first") await gate;
        return { type: "sent" };
      },
    });
    await outbox.add("post.create", { text: "first" }, { owner: "alice" });
    await outbox.add("post.create", { text: "waiting" }, { owner: "alice" });
    await outbox.add("post.create", { text: "other pass" }, { owner: "bob" });
    const running = outbox.flush("alice");
    const queued = outbox.flush("bob");
    expect(queued).toBe(running);
    release();
    expect(await running).toMatchObject({ sent: 2, deferredOffline: true });
    expect((await outbox.list()).map((entry) => entry.item.payload.text)).toEqual(["waiting"]);
  });

  it("clears the offline signal when a later queued pass sends the remainder", async () => {
    const store = new MemoryStore<Payload>();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const checks = [true, false, true];
    const outbox = new Outbox<Payload>({
      store,
      isOnline: () => checks.shift() ?? true,
      policy: { claimRenewMs: 0 },
      send: async (item) => {
        if (item.payload.text === "first") await gate;
        return { type: "sent" };
      },
    });
    await outbox.add("post.create", { text: "first" }, { owner: "alice" });
    await outbox.add("post.create", { text: "second" }, { owner: "alice" });
    const running = outbox.flush("alice");
    expect(outbox.flush("alice")).toBe(running);
    release();
    expect(await running).toEqual({ sent: 2, retry: 0, busy: 0, stuck: 0 });
    expect(await outbox.list()).toHaveLength(0);
  });

  it("does not report an offline remainder when a specific pass finishes an earlier all-owner pass", async () => {
    const store = new MemoryStore<Payload>();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const checks = [true, false, true];
    const outbox = new Outbox<Payload>({
      store,
      isOnline: () => checks.shift() ?? true,
      policy: { claimRenewMs: 0 },
      send: async (item) => {
        if (item.payload.text === "first") await gate;
        return { type: "sent" };
      },
    });
    await outbox.add("post.create", { text: "first" }, { owner: "alice" });
    await outbox.add("post.create", { text: "second" }, { owner: "alice" });
    const running = outbox.flush();
    expect(outbox.flush("alice")).toBe(running);
    release();
    expect(await running).toEqual({ sent: 2, retry: 0, busy: 0, stuck: 0 });
    expect(await outbox.list()).toHaveLength(0);
  });

  it("lets a later all-owner pass clear a specific owner's offline remainder", async () => {
    const store = new MemoryStore<Payload>();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const checks = [true, false, true];
    const outbox = new Outbox<Payload>({
      store,
      isOnline: () => checks.shift() ?? true,
      policy: { claimRenewMs: 0 },
      send: async (item) => {
        if (item.payload.text === "first") await gate;
        return { type: "sent" };
      },
    });
    await outbox.add("post.create", { text: "first" }, { owner: "alice" });
    await outbox.add("post.create", { text: "second" }, { owner: "alice" });
    const running = outbox.flush("alice");
    expect(outbox.flush()).toBe(running);
    release();
    expect(await running).toEqual({ sent: 2, retry: 0, busy: 0, stuck: 0 });
  });

  it("runs a flush for work added during the final offline read", async () => {
    const inner = new MemoryStore<Payload>();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let reached!: () => void;
    const finalRead = new Promise<void>((resolve) => { reached = resolve; });
    let reads = 0;
    const store: Store<Payload> = {
      update: (fn) => inner.update(fn),
      isDurable: () => inner.isDurable(),
      read: async () => {
        reads += 1;
        const snapshot = await inner.read();
        if (reads === 2) {
          reached();
          await gate;
        }
        return snapshot;
      },
    };
    let online = false;
    const sent: string[] = [];
    const outbox = new Outbox<Payload>({
      store,
      isOnline: () => online,
      policy: { claimRenewMs: 0 },
      send: async (item) => { sent.push(item.payload.text); return { type: "sent" }; },
    });
    await outbox.add("post.create", { text: "alice" }, { owner: "alice" });
    const running = outbox.flush("alice");
    await finalRead;
    await outbox.add("post.create", { text: "bob" }, { owner: "bob" });
    const queued = outbox.flush("bob");
    online = true;
    release();
    expect(queued).toBe(running);
    expect(await running).toMatchObject({ sent: 1, deferredOffline: true });
    expect(sent).toEqual(["bob"]);
    expect((await outbox.list()).map((entry) => entry.item.payload.text)).toEqual(["alice"]);
  });

  it("keeps the offline signal when connectivity flaps across queued passes", async () => {
    const checks = [false, true, false];
    const sent: string[] = [];
    const outbox = new Outbox<Payload>({
      store: new MemoryStore(),
      isOnline: () => checks.shift() ?? false,
      policy: { claimRenewMs: 0 },
      send: async (item) => { sent.push(item.payload.text); return { type: "sent" }; },
    });
    for (const text of ["first", "second", "third"]) await outbox.add("post.create", { text }, { owner: "alice" });
    const running = outbox.flush("alice");
    expect(outbox.flush("alice")).toBe(running);
    expect(await running).toMatchObject({ sent: 1, deferredOffline: true });
    expect(sent).toEqual(["first"]);
    expect((await outbox.list()).map((entry) => entry.item.payload.text)).toEqual(["second", "third"]);
  });

  it("propagates a failed final read and permits a later recovery flush", async () => {
    const inner = new MemoryStore<Payload>();
    let reads = 0;
    const store: Store<Payload> = {
      update: (fn) => inner.update(fn),
      isDurable: () => inner.isDurable(),
      read: async () => {
        reads += 1;
        if (reads === 2) throw new Error("read unavailable");
        return inner.read();
      },
    };
    let online = false;
    const outbox = new Outbox<Payload>({ store, isOnline: () => online, send: async () => ({ type: "sent" }), policy: { claimRenewMs: 0 } });
    await outbox.add("post.create", { text: "recover" });
    await expect(outbox.flush()).rejects.toThrow("read unavailable");
    online = true;
    expect(await outbox.flush()).toEqual({ sent: 1, retry: 0, busy: 0, stuck: 0 });
    expect(await outbox.list()).toHaveLength(0);
  });

  it("carries the written time, not the send time", async () => {
    const { outbox, server, time } = setup({ online: () => true });
    const written = time.now();
    await outbox.add("post.create", { text: "written earlier" });
    time.advance(3 * 60 * 60 * 1000);
    await outbox.flush();
    expect(server.created[0]?.writtenAt).toBe(new Date(written).toISOString());
  });

  it("waits for the server to finish an earlier attempt without spending one", async () => {
    const { outbox, server, time } = setup();
    const item = await outbox.add("post.create", { text: "slow server" });
    server.holdInProgress(item.key);
    const report = await outbox.flush();
    expect(report.busy).toBe(1);
    const [entry] = await outbox.list();
    expect(entry?.item.attempts).toBe(0);
    server.release(item.key);
    time.advance(1000);
    expect((await outbox.flush()).sent).toBe(1);
    expect(server.created).toHaveLength(1);
  });

  it("asks before sending an item older than 30 days, then sends it with its key", async () => {
    const { outbox, server, time } = setup();
    const item = await outbox.add("post.create", { text: "old draft" });
    time.advance(31 * 24 * 60 * 60 * 1000);

    expect((await outbox.flush()).sent).toBe(0);
    expect((await outbox.list())[0]?.status).toBe("needs_confirmation");

    expect(await outbox.approve(item.key)).toEqual({ ok: true, key: item.key, newKey: false });
    expect((await outbox.flush()).sent).toBe(1);
    expect(server.created[0]?.key).toBe(item.key);
  });

  it("lets a person cancel a waiting item, which is then never sent", async () => {
    const { outbox, server } = setup();
    const item = await outbox.add("post.create", { text: "changed my mind" });
    expect(await outbox.cancel(item.key)).toBe("cancelled");
    await outbox.flush();
    expect(server.requests).toBe(0);
  });

  it("refuses to cancel an item whose answer was lost", async () => {
    const { outbox } = setup({ loseResponses: 1 });
    const item = await outbox.add("post.create", { text: "maybe posted" });
    await outbox.flush();
    expect(await outbox.cancel(item.key)).toBe("in_flight");
    expect((await outbox.list())[0]?.status).toBe("sending");
  });

  it("stops after the attempt budget and keeps the item for a person", async () => {
    const store = new MemoryStore<Payload>();
    const time = clock();
    const outbox = new Outbox<Payload>({
      store,
      now: time.now,
      send: async () => classifyResponse(503),
      policy: { maxAttempts: 3, claimRenewMs: 0 },
    });
    await outbox.add("post.create", { text: "never lands" });
    for (let n = 0; n < 5; n += 1) {
      await outbox.flush();
      time.advance(10 * 60 * 1000); // past any retry delay
    }
    const [entry] = await outbox.list();
    expect(entry?.status).toBe("stuck");
    expect(entry?.item.attempts).toBe(3);
  });

  it("reuses a key a live attempt already sent", async () => {
    const { outbox, server } = setup();
    server.handle({ "Idempotency-Key": "live-attempt-01" }, { text: "sent live" });
    await outbox.add("post.create", { text: "sent live" }, { key: "live-attempt-01" });
    await outbox.flush();
    expect(server.created).toHaveLength(1);
  });

  it("never stores an item twice under one key", async () => {
    const { outbox } = setup();
    await outbox.add("post.create", { text: "a" }, { key: "dup-key-0001" });
    await expect(outbox.add("post.create", { text: "b" }, { key: "dup-key-0001" })).rejects.toThrow();
    expect(await outbox.list()).toHaveLength(1);
  });

  it("only flushes the given owner's items", async () => {
    const { outbox, server } = setup();
    await outbox.add("post.create", { text: "mine" }, { owner: "person-a" });
    await outbox.add("post.create", { text: "theirs" }, { owner: "person-b" });
    await outbox.flush("person-a");
    expect(server.created.map((r) => JSON.parse(r.body).text)).toEqual(["mine"]);
  });

  it("keeps stored state safe from callers mutating returned objects", async () => {
    const { outbox } = setup();
    const added: OutboxItem<Payload> = await outbox.add("post.create", { text: "safe" });
    added.payload.text = "tampered";
    const [entry] = await outbox.list();
    expect(entry?.item.payload.text).toBe("safe");
  });
});
