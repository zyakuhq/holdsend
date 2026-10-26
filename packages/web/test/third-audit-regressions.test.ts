/**
 * Regression tests for the web findings of the third audit (2026-10-26).
 * Each failed on the code before its fix (B3 failed to compile).
 */
import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it } from "vitest";
import { MemoryStore, Outbox } from "@holdsend/core";
import { IndexedDbStore, SenderLock, createWebStore, onBackgroundSync, requestBackgroundSync, type WebLockApi } from "../src/index.js";

describe("B1: Web Locks that refuse (sandboxed iframe, blocked site data)", () => {
  it("fall back so the task still runs", async () => {
    const refusing: WebLockApi = {
      request: () => Promise.reject(Object.assign(new Error("The request is insecure."), { name: "SecurityError" })),
    };
    const lock = new SenderLock({ webLocks: refusing, leaseStorage: null });
    expect(await lock.run(async () => "sent")).toEqual({ ran: true, via: "alone", value: "sent" });
  });

  it("still report the task's own failure", async () => {
    const granting: WebLockApi = { request: (_name, _options, callback) => callback({}) };
    const lock = new SenderLock({ webLocks: granting, leaseStorage: null });
    await expect(
      lock.run(async () => {
        throw new Error("send failed");
      }),
    ).rejects.toThrow("send failed");
  });
});

describe("B2: a background sync whose flush is wrapped in SenderLock.run", () => {
  function syncEvent() {
    const waited: Promise<unknown>[] = [];
    return { event: { tag: "holdsend", waitUntil: (p: Promise<unknown>) => void waited.push(p) }, waited };
  }

  it("asks the browser to try again when work remains or the lock was busy", async () => {
    for (const result of [
      { ran: true, via: "web-lock", value: { sent: 0, retry: 1, busy: 0, stuck: 0 } },
      { ran: false },
    ]) {
      const { event, waited } = syncEvent();
      onBackgroundSync(event, async () => result);
      await expect(waited[0]!, JSON.stringify(result)).rejects.toThrow(/still waiting/);
    }
  });

  it("is done when everything was sent", async () => {
    const { event, waited } = syncEvent();
    onBackgroundSync(event, async () => ({ ran: true, via: "web-lock", value: { sent: 2, retry: 0, busy: 0, stuck: 0 } }));
    await expect(waited[0]!).resolves.toBeDefined();
  });

  it("takes the tag in an options object", () => {
    const { event } = syncEvent();
    expect(onBackgroundSync({ ...event, tag: "mine" }, async () => ({}), { tag: "mine" })).toBe(true);
    expect(onBackgroundSync(event, async () => ({}), { tag: "mine" })).toBe(false);
  });
});

describe("B3: the real browser types are accepted", () => {
  it("compiles with ServiceWorkerContainer and a plain Event", () => {
    // Type-level check: this file must compile under `npm run typecheck`.
    const typed = (container: ServiceWorkerContainer, event: Event) => {
      void requestBackgroundSync({ serviceWorker: container });
      return onBackgroundSync(event, async () => ({}));
    };
    expect(typeof typed).toBe("function");
    // A plain Event without waitUntil is ignored, not a crash.
    expect(onBackgroundSync(new Event("sync"), async () => ({}))).toBe(false);
  });
});

describe("B6: a store that cannot be opened", () => {
  it("is retried once, and the fallback says why", async () => {
    let opens = 0;
    const factory = new IDBFactory();
    const flaky = {
      open: (...args: Parameters<IDBFactory["open"]>) => {
        opens += 1;
        if (opens === 1) throw new Error("Connection to Indexed Database server lost");
        return factory.open(...args);
      },
    } as unknown as IDBFactory;
    const store = await createWebStore({ name: "audit3-flaky", indexedDB: flaky });
    expect(store).toBeInstanceOf(IndexedDbStore);

    const reasons: unknown[] = [];
    const broken = { open: () => { throw new Error("always fails"); } } as unknown as IDBFactory;
    const fallback = await createWebStore({ name: "audit3-broken", indexedDB: broken, onFallback: (r) => reasons.push(r) });
    expect(fallback).toBeInstanceOf(MemoryStore);
    expect(String(reasons[0])).toMatch(/always fails/);
  });
});

describe("B9: auto-flush and visibility", () => {
  it("hears visibilitychange on document", async () => {
    const { startAutoFlush } = await import("../src/index.js");
    let flushes = 0;
    const outbox = new Outbox({ store: new MemoryStore(), send: async () => ({ type: "sent" }) });
    const original = outbox.flush.bind(outbox);
    outbox.flush = (owner?: string) => {
      flushes += 1;
      return original(owner);
    };
    const doc = Object.assign(new EventTarget(), { visibilityState: "visible" });
    const target = Object.assign(new EventTarget(), { document: doc });
    const flusher = startAutoFlush(outbox, { target, lock: new SenderLock({ webLocks: null, leaseStorage: null }) });
    await new Promise((r) => setTimeout(r, 20));
    const before = flushes;
    doc.dispatchEvent(new Event("visibilitychange"));
    await new Promise((r) => setTimeout(r, 20));
    expect(flushes).toBeGreaterThan(before);
    flusher.stop();
  });
});
