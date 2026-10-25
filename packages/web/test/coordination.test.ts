import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryStore, Outbox } from "@holdsend/core";
import {
  SenderLock,
  onBackgroundSync,
  requestBackgroundSync,
  startAutoFlush,
  type LockManagerLike,
  type SyncStorageLike,
} from "../src/index.js";

/** A LockManager with the ifAvailable semantics of the Web Locks API. */
function fakeLocks(): LockManagerLike {
  const held = new Set<string>();
  return {
    async request(name, options, callback) {
      if (held.has(name)) {
        if (options.ifAvailable) return callback(null);
        throw new Error("waiting not supported in this fake");
      }
      held.add(name);
      try {
        return await callback({ name });
      } finally {
        held.delete(name);
      }
    },
  };
}

function fakeStorage(): SyncStorageLike & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
}

describe("SenderLock", () => {
  it("lets one tab send while another is refused (Web Locks)", async () => {
    const locks = fakeLocks();
    const a = new SenderLock({ locks });
    const b = new SenderLock({ locks });
    let release!: () => void;
    const holding = a.run(() => new Promise<void>((r) => (release = r)));
    await Promise.resolve();
    expect(await b.run(async () => "b ran")).toEqual({ acquired: false });
    release();
    expect(await holding).toMatchObject({ acquired: true, mode: "web-locks" });
    expect(await b.run(async () => "b ran")).toEqual({ acquired: true, mode: "web-locks", value: "b ran" });
  });

  it("falls back to a lease that only one of two racing tabs wins", async () => {
    const storage = fakeStorage();
    const sleep = () => new Promise<void>((r) => setTimeout(r, 1));
    const a = new SenderLock({ locks: null, storage, sleep, settleMs: 0 });
    const b = new SenderLock({ locks: null, storage, sleep, settleMs: 0 });
    let release!: () => void;
    const first = a.run(() => new Promise<void>((r) => (release = r)));
    await new Promise((r) => setTimeout(r, 5));
    expect(await b.run(async () => "b")).toEqual({ acquired: false });
    release();
    expect((await first).acquired).toBe(true);
    expect(storage.data.size).toBe(0);
  });

  it("takes over a lease whose tab died", async () => {
    const storage = fakeStorage();
    let t = 1_000;
    storage.setItem("holdsend-sender:lease", JSON.stringify({ owner: "dead-tab", expiresAt: t - 1 }));
    const lock = new SenderLock({ locks: null, storage, now: () => t, sleep: async () => undefined });
    expect(await lock.run(async () => "ok")).toEqual({ acquired: true, mode: "lease", value: "ok" });
    t += 1;
  });

  it("runs alone when there is nothing to coordinate with", async () => {
    const lock = new SenderLock({ locks: null, storage: null });
    expect(await lock.run(async () => 1)).toEqual({ acquired: true, mode: "single", value: 1 });
  });

  it("is not re-entrant within a tab", async () => {
    const lock = new SenderLock({ locks: null, storage: null });
    const inner = await lock.run(async () => lock.run(async () => "inner"));
    expect(inner).toEqual({ acquired: true, mode: "single", value: { acquired: false } });
  });
});

describe("startAutoFlush", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("sends when the connection comes back, and backs off while items keep failing", async () => {
    vi.useFakeTimers();
    let online = false;
    let failures = 2;
    const sends: number[] = [];
    const outbox = new Outbox<{ text: string }>({
      store: new MemoryStore(),
      policy: { claimRenewMs: 0 },
      send: async () => {
        sends.push(Date.now());
        if (failures > 0) {
          failures -= 1;
          return { type: "retry" };
        }
        return { type: "sent" };
      },
    });
    await outbox.add("post.create", { text: "x" });
    const target = new EventTarget();
    const flusher = startAutoFlush(outbox, { target, isOnline: () => online, lock: new SenderLock({ locks: null, storage: null }), backoffMs: [1000, 5000] });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sends).toHaveLength(0); // offline: nothing sent

    online = true;
    target.dispatchEvent(new Event("online"));
    await vi.advanceTimersByTimeAsync(0);
    expect(sends).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(sends).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(5000);
    expect(sends).toHaveLength(3);
    expect(await outbox.list()).toHaveLength(0);
    flusher.stop();
  });

  it("stops cleanly", async () => {
    vi.useFakeTimers();
    const send = vi.fn(async () => ({ type: "sent" as const }));
    const outbox = new Outbox({ store: new MemoryStore(), send, policy: { claimRenewMs: 0 } });
    const target = new EventTarget();
    const flusher = startAutoFlush(outbox, { target, isOnline: () => true, lock: new SenderLock({ locks: null, storage: null }) });
    flusher.stop();
    await outbox.add("post.create", { text: "after stop" });
    target.dispatchEvent(new Event("online"));
    await vi.advanceTimersByTimeAsync(120_000);
    expect(send).not.toHaveBeenCalled();
  });
});

describe("background sync", () => {
  it("promises background sending only after a registration succeeded", async () => {
    expect(await requestBackgroundSync({ serviceWorker: null })).toBe("open_app");
    expect(await requestBackgroundSync({ serviceWorker: { ready: Promise.resolve({}) } })).toBe("open_app");
    const register = vi.fn(async () => undefined);
    expect(await requestBackgroundSync({ serviceWorker: { ready: Promise.resolve({ sync: { register } }) } })).toBe("background");
    expect(register).toHaveBeenCalledWith("holdsend");
    const failing = { ready: Promise.resolve({ sync: { register: async () => { throw new Error("denied"); } } }) };
    expect(await requestBackgroundSync({ serviceWorker: failing })).toBe("open_app");
    const never = { ready: new Promise<never>(() => undefined) };
    expect(await requestBackgroundSync({ serviceWorker: never, timeoutMs: 10 })).toBe("open_app");
  });

  it("flushes only for its own tag in the service worker", () => {
    const waitUntil = vi.fn();
    const flush = vi.fn(async () => undefined);
    expect(onBackgroundSync({ tag: "other", waitUntil }, flush)).toBe(false);
    expect(onBackgroundSync({ tag: "holdsend", waitUntil }, flush)).toBe(true);
    expect(flush).toHaveBeenCalledTimes(1);
    expect(waitUntil).toHaveBeenCalledTimes(1);
  });
});
