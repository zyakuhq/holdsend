/**
 * Regression tests for the second pass of the independent audit
 * (2026-10-25). Each test failed on the code before its fix.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryStore, Outbox, classifyResponse, type AttemptOutcome, type OutboxItem, type Store } from "../src/index.js";
import { FakeServer } from "./fake-server.js";

type Payload = { text: string };
const MIN = 60 * 1000;
const HOUR = 60 * MIN;

afterEach(() => {
  vi.useRealTimers();
});

describe("N1: a server that never answers", () => {
  it("is retried with growing gaps and then shown to the person as unreachable, without using the attempt budget", async () => {
    let t = Date.parse("2026-10-25T12:00:00Z");
    let calls = 0;
    const outbox = new Outbox<Payload>({
      store: new MemoryStore(),
      now: () => t,
      policy: { claimRenewMs: 0, giveUpAfterMs: 24 * HOUR },
      send: async () => {
        calls += 1;
        throw new TypeError("Failed to fetch");
      },
    });
    await outbox.add("post.create", { text: "no route to the server" });

    // Flushing again at once does not send again: the item waits its turn.
    await outbox.flush();
    await outbox.flush();
    expect(calls).toBe(1);

    for (let hour = 0; hour < 30; hour += 1) {
      t += HOUR;
      await outbox.flush();
    }
    const [entry] = await outbox.list();
    expect(entry?.status).toBe("stuck");
    expect(entry?.item.stuckReason).toBe("unreachable");
    expect(entry?.item.attempts).toBe(0);
    expect(calls).toBeLessThan(30);

    // A person's Try again starts over, with the same key.
    const again = await outbox.retry(entry!.item.key);
    expect(again).toEqual({ key: entry!.item.key, newKey: false });
    const [after] = await outbox.list();
    expect(after?.item.state).toBe("waiting");
    expect(after?.item.stuckReason).toBeUndefined();
  });

  it("gives an upload slower than the timeout more time on each try, so it can finish", async () => {
    vi.useFakeTimers();
    const server = new FakeServer();
    const outbox = new Outbox<Payload>({
      store: new MemoryStore(),
      policy: { attemptTimeoutMs: 1000, claimRenewMs: 0 },
      // Every upload takes 1.5 s: longer than the first timeout, shorter than the second.
      send: (item, ctx) =>
        new Promise<AttemptOutcome>((resolve, reject) => {
          const timer = setTimeout(() => resolve(server.sender()(item, ctx)), 1500);
          ctx.signal?.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(new Error("aborted"));
          });
        }),
    });
    await outbox.add("post.create", { text: "a large photo" });

    const first = outbox.flush();
    await vi.advanceTimersByTimeAsync(1000);
    expect(await first).toMatchObject({ sent: 0, retry: 1 });
    expect((await outbox.list())[0]?.item.timeouts).toBe(1);

    await vi.advanceTimersByTimeAsync(1000); // past the retry delay
    const second = outbox.flush();
    await vi.advanceTimersByTimeAsync(1500);
    expect(await second).toMatchObject({ sent: 1 });
    expect(server.created).toHaveLength(1);
  });
});

describe("N3: a flush asked for as the running flush finishes", () => {
  it("is run, not dropped", async () => {
    const server = new FakeServer();
    const inner = new MemoryStore<Payload>();
    const box = {} as { outbox: Outbox<Payload> };
    let late: Promise<unknown> | null = null;
    let arm = false;
    // Asks for a flush for bob from inside the running flush's last store update.
    const store: Store<Payload> = {
      read: () => inner.read(),
      isDurable: () => inner.isDurable(),
      update: async <T>(fn: (items: OutboxItem<Payload>[]) => T) => {
        const value = await inner.update(fn);
        if (arm && typeof value !== "object") {
          arm = false;
          late = box.outbox.flush("bob");
        }
        return value;
      },
    };
    const outbox = (box.outbox = new Outbox<Payload>({ store, policy: { claimRenewMs: 0 }, send: server.sender() }));
    await outbox.add("post.create", { text: "alice" }, { owner: "alice" });
    await outbox.add("post.create", { text: "bob" }, { owner: "bob" });
    arm = true;
    await outbox.flush("alice");
    await late;
    expect(server.created.map((c) => JSON.parse(c.body).text).sort()).toEqual(["alice", "bob"]);
  });

  it("is run when asked for by code waiting on the flush that just finished", async () => {
    const server = new FakeServer();
    const outbox = new Outbox<Payload>({ store: new MemoryStore(), policy: { claimRenewMs: 0 }, send: server.sender() });
    await outbox.add("post.create", { text: "alice" }, { owner: "alice" });
    let late: Promise<unknown> | null = null;
    const first = outbox.flush("alice").then(async () => {
      await outbox.add("post.create", { text: "bob" }, { owner: "bob" });
      late = outbox.flush("bob");
    });
    await first;
    await late;
    expect(server.created.map((c) => JSON.parse(c.body).text).sort()).toEqual(["alice", "bob"]);
  });

  it("is run when asked for in the same tick the flush resolves", async () => {
    const server = new FakeServer();
    const outbox = new Outbox<Payload>({ store: new MemoryStore(), policy: { claimRenewMs: 0 }, send: server.sender() });
    await outbox.add("post.create", { text: "alice" }, { owner: "alice" });
    await outbox.add("post.create", { text: "bob" }, { owner: "bob" });
    let late: Promise<unknown> | null = null;
    await outbox.flush("alice").then(() => {
      late = outbox.flush("bob");
    });
    await late;
    expect(server.created.map((c) => JSON.parse(c.body).text).sort()).toEqual(["alice", "bob"]);
  });

  it("is run when asked for at any point while the flush is winding down", async () => {
    // Asks for bob's flush a varying number of microtask hops after the
    // running flush's last store update, to land in every gap in turn.
    for (let hops = 0; hops < 12; hops += 1) {
      const server = new FakeServer();
      const inner = new MemoryStore<Payload>();
      const box = {} as { outbox: Outbox<Payload> };
      let late: Promise<unknown> | null = null;
      let arm = false;
      const store: Store<Payload> = {
        read: () => inner.read(),
        isDurable: () => inner.isDurable(),
        update: async <T>(fn: (items: OutboxItem<Payload>[]) => T) => {
          const value = await inner.update(fn);
          if (arm && typeof value !== "object") {
            arm = false;
            void (async () => {
              for (let n = 0; n < hops; n += 1) await Promise.resolve();
              late = box.outbox.flush("bob");
            })();
          }
          return value;
        },
      };
      const outbox = (box.outbox = new Outbox<Payload>({ store, policy: { claimRenewMs: 0 }, send: server.sender() }));
      await outbox.add("post.create", { text: "alice" }, { owner: "alice" });
      await outbox.add("post.create", { text: "bob" }, { owner: "bob" });
      arm = true;
      await outbox.flush("alice");
      for (let n = 0; n < 20 && late === null; n += 1) await Promise.resolve();
      await late;
      expect(server.created.map((c) => JSON.parse(c.body).text).sort(), `after ${hops} hops`).toEqual(["alice", "bob"]);
    }
  });

  it("a flush that fails leaves nothing queued to ride along on a later one", async () => {
    const inner = new MemoryStore<Payload>();
    let fail = true;
    const store: Store<Payload> = {
      read: async () => {
        if (fail) throw new Error("storage unavailable");
        return inner.read();
      },
      isDurable: () => inner.isDurable(),
      update: (fn) => inner.update(fn),
    };
    const outbox = new Outbox<Payload>({ store, send: async () => ({ type: "sent" }) });
    const first = outbox.flush("alice");
    const queued = outbox.flush("bob");
    await expect(first).rejects.toThrow(/storage unavailable/);
    await expect(queued).rejects.toThrow(/storage unavailable/);
    fail = false;
    expect(await outbox.flush("carol")).toMatchObject({ sent: 0 });
  });
});

describe("N4: a send function that throws before returning a promise", () => {
  it("counts as no answer, and the flush finishes", async () => {
    const outbox = new Outbox<Payload>({
      store: new MemoryStore(),
      policy: { claimRenewMs: 0 },
      send: () => {
        throw new TypeError("fetch is not a function");
      },
    });
    await outbox.add("post.create", { text: "bad wiring" });
    expect(await outbox.flush()).toMatchObject({ sent: 0, retry: 1 });
    const [entry] = await outbox.list();
    expect(entry?.item.state).toBe("waiting");
    expect(entry?.item.attempts).toBe(0);
  });
});

describe("N5: flushing from a change listener", () => {
  it("does not spin while the server keeps failing", async () => {
    let calls = 0;
    const outbox = new Outbox<Payload>({
      store: new MemoryStore(),
      policy: { claimRenewMs: 0 },
      send: async () => {
        calls += 1;
        return classifyResponse(503);
      },
    });
    let flushes = 0;
    outbox.subscribe(() => {
      if (flushes < 1000) {
        flushes += 1;
        void outbox.flush();
      }
    });
    await outbox.add("post.create", { text: "server down" });
    await outbox.flush();
    await new Promise((r) => setTimeout(r, 50));
    expect(calls).toBe(1);
  });
});

describe("N9: a person's Try again after a key conflict", () => {
  it("says the key changed, so the app can ask first", async () => {
    const t = Date.parse("2026-10-25T12:00:00Z");
    const outbox = new Outbox<Payload>({
      store: new MemoryStore(),
      now: () => t,
      policy: { claimRenewMs: 0 },
      send: async () => classifyResponse(409, "key_conflict"),
    });
    const item = await outbox.add("post.create", { text: "edited draft" });
    await outbox.flush();
    expect((await outbox.list())[0]?.item.stuckReason).toBe("key_conflict");
    const result = await outbox.retry(item.key);
    expect(result?.newKey).toBe(true);
    expect(result?.key).not.toBe(item.key);
  });
});

describe("claim renewal during a long attempt", () => {
  it("keeps a second sender from taking over a slow but live attempt", async () => {
    vi.useFakeTimers();
    const store = new MemoryStore<Payload>();
    const server = new FakeServer();
    let calls = 0;
    const slow = new Outbox<Payload>({
      store,
      policy: { attemptTimeoutMs: 10 * MIN, staleClaimMs: 2 * MIN, claimRenewMs: 30_000 },
      send: (item, ctx) => {
        calls += 1;
        return new Promise<AttemptOutcome>((resolve) => setTimeout(() => resolve(server.sender()(item, ctx)), 5 * MIN));
      },
    });
    const other = new Outbox<Payload>({
      store,
      policy: { claimRenewMs: 0 },
      send: async (item, ctx) => {
        calls += 1;
        return server.sender()(item, ctx);
      },
    });
    await slow.add("post.create", { text: "slow upload" });
    const running = slow.flush();
    await vi.advanceTimersByTimeAsync(3 * MIN); // past staleClaimMs, but renewed
    expect(await other.flush()).toMatchObject({ sent: 0 });
    await vi.advanceTimersByTimeAsync(2 * MIN);
    expect(await running).toMatchObject({ sent: 1 });
    expect(calls).toBe(1);
    expect(server.created).toHaveLength(1);
  });
});
