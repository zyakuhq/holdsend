/**
 * Regression tests for the findings of the first independent audit
 * (2026-10-25). Each test failed on the code before its fix.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MemoryStore,
  NotJsonError,
  Outbox,
  approve,
  classifyResponse,
  createFlushScheduler,
  type AttemptOutcome,
  type OutboxItem,
} from "../src/index.js";
import { FakeServer } from "./fake-server.js";

type Payload = { text: string };
const MIN = 60 * 1000;

afterEach(() => {
  vi.useRealTimers();
});

describe("audit 1: a send that never settles", () => {
  it("is abandoned after the attempt timeout, aborts the request, and the item and outbox carry on", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    let calls = 0;
    const server = new FakeServer();
    const outbox = new Outbox<Payload>({
      store: new MemoryStore(),
      policy: { attemptTimeoutMs: 60_000 },
      send: async (item, ctx) => {
        calls += 1;
        if (calls === 1) {
          signal = ctx.signal;
          return new Promise<AttemptOutcome>(() => undefined); // hangs forever
        }
        return server.sender()(item, ctx);
      },
    });
    await outbox.add("post.create", { text: "hangs once" });
    const first = outbox.flush();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await first).toMatchObject({ sent: 0, retry: 1 });
    expect(signal?.aborted).toBe(true);
    const [entry] = await outbox.list();
    expect(entry?.item.state).toBe("waiting");
    expect(entry?.item.attempts).toBe(0); // no answer: not counted

    await vi.advanceTimersByTimeAsync(1000); // past the first retry delay
    const second = outbox.flush();
    await vi.advanceTimersByTimeAsync(0);
    expect(await second).toMatchObject({ sent: 1 });
    expect(server.created).toHaveLength(1);
  });
});

describe("audit 2: an item queued with a key a live attempt already sent", () => {
  it("cannot be cancelled, because it may already exist on the server", async () => {
    const outbox = new Outbox<Payload>({ store: new MemoryStore(), send: async () => ({ type: "sent" }) });
    const item = await outbox.add("post.create", { text: "answer lost" }, { key: "live-attempt-0001" });
    expect(await outbox.cancel(item.key)).toBe("in_flight");
    expect((await outbox.list())[0]?.status).toBe("sending");
    expect(await outbox.discard(item.key)).toBe("discarded_may_exist");
  });
});

describe("audit 3: a network that says it is connected but is not", () => {
  it("does not use up the attempt budget, so the item is sent when the connection really returns", async () => {
    let connected = false;
    let t = Date.parse("2026-10-25T12:00:00Z");
    const server = new FakeServer();
    const outbox = new Outbox<Payload>({
      store: new MemoryStore(),
      now: () => t,
      policy: { maxAttempts: 3, claimRenewMs: 0 },
      send: async (item, ctx) => {
        if (!connected) throw new TypeError("Failed to fetch");
        return server.sender()(item, ctx);
      },
    });
    await outbox.add("post.create", { text: "written on dead Wi-Fi" });
    for (let n = 0; n < 20; n += 1) {
      await outbox.flush();
      t += 10 * MIN;
    }
    expect((await outbox.list())[0]?.status).not.toBe("stuck");
    connected = true;
    expect((await outbox.flush()).sent).toBe(1);
    expect(server.created).toHaveLength(1);
  });

  it("still stops after the budget when the server keeps answering with errors", async () => {
    let t = Date.parse("2026-10-25T12:00:00Z");
    const outbox = new Outbox<Payload>({ store: new MemoryStore(), now: () => t, policy: { maxAttempts: 3, claimRenewMs: 0 }, send: async () => classifyResponse(503) });
    await outbox.add("post.create", { text: "server down" });
    const reports = [];
    for (let n = 0; n < 5; n += 1) {
      reports.push(await outbox.flush());
      t += 10 * MIN;
    }
    expect((await outbox.list())[0]?.status).toBe("stuck");
    expect(reports.reduce((s, r) => s + r.stuck, 0)).toBe(1);
  });
});

describe("audit 4: an item held by a sender that died", () => {
  it("is reported with a time to look again, and the scheduler takes it over then", async () => {
    vi.useFakeTimers();
    const store = new MemoryStore<Payload>();
    const dead = new Outbox<Payload>({ store, policy: { claimRenewMs: 0 }, send: () => new Promise<AttemptOutcome>(() => undefined) });
    await dead.add("post.create", { text: "tab killed mid-send" });
    void dead.flush(); // claims, then hangs: the tab is killed
    await vi.advanceTimersByTimeAsync(0);

    const server = new FakeServer();
    const alive = new Outbox<Payload>({ store, policy: { claimRenewMs: 0 }, send: server.sender() });
    const report = await alive.flush();
    expect(report.sent).toBe(0);
    expect(report.nextCheckInMs).toBeGreaterThan(0);
    expect(report.nextCheckInMs).toBeLessThanOrEqual(2 * MIN + 1);

    const scheduler = createFlushScheduler({ flush: () => alive.flush() });
    scheduler.kick();
    await vi.advanceTimersByTimeAsync(2 * MIN + 1000);
    expect(server.created).toHaveLength(1);
    scheduler.stop();
  });
});

describe("audit 7: flushes requested for different owners during a flush", () => {
  it("are all run before the flush resolves", async () => {
    const server = new FakeServer();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let first = true;
    const outbox = new Outbox<Payload>({
      store: new MemoryStore(),
      policy: { claimRenewMs: 0 },
      send: async (item, ctx) => {
        if (first) {
          first = false;
          await gate;
        }
        return server.sender()(item, ctx);
      },
    });
    for (const owner of ["alice", "bob", "carol"]) await outbox.add("post.create", { text: owner }, { owner });
    const running = outbox.flush("alice");
    const bob = outbox.flush("bob");
    const carol = outbox.flush("carol");
    release();
    await Promise.all([running, bob, carol]);
    expect(server.created.map((c) => JSON.parse(c.body).text).sort()).toEqual(["alice", "bob", "carol"]);
  });
});

describe("audit 15: approving an old item whose key the server refused", () => {
  it("gives it a new key instead of sending into the same conflict", () => {
    const now = Date.parse("2026-10-25T12:00:00Z");
    const items: OutboxItem[] = [
      { key: "old-key-0001", kind: "k", payload: {}, writtenAt: now - 40 * 24 * 60 * MIN, state: "stuck", stuckReason: "key_conflict", attempts: 1, touched: true },
    ];
    expect(approve(items, "old-key-0001", now, undefined, () => "new-key-0001")).toEqual({ key: "new-key-0001", newKey: true });
    expect(items[0]).toMatchObject({ key: "new-key-0001", state: "waiting" });
  });
});

describe("audit 16: payloads that are not plain JSON", () => {
  it("are refused when added, instead of being saved as {}", async () => {
    const outbox = new Outbox<unknown>({ store: new MemoryStore(), send: async () => ({ type: "sent" }) });
    await expect(outbox.add("post.create", { photo: new Map([["a", 1]]) })).rejects.toBeInstanceOf(NotJsonError);
    await expect(outbox.add("post.create", { at: new Date() })).rejects.toThrow(/payload\.at is a Date/);
    await expect(outbox.add("post.create", { n: Number.NaN })).rejects.toBeInstanceOf(NotJsonError);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    await expect(outbox.add("post.create", cyclic)).rejects.toBeInstanceOf(NotJsonError);
    await expect(outbox.add("post.create", { ok: [1, "two", null, { three: true }], skipped: undefined })).resolves.toBeDefined();
    expect(await outbox.list()).toHaveLength(1);
  });
});
