import { describe, expect, it } from "vitest";
import { Outbox, type Sender } from "@holdsend/core";
import { KeyValueStore, runBackgroundFlush, type AsyncKeyValue } from "../src/index.js";

type Payload = { text: string };

function memoryStorage(): AsyncKeyValue {
  const data = new Map<string, string>();
  return {
    getItem: async (k) => data.get(k) ?? null,
    setItem: async (k, v) => void data.set(k, v),
    removeItem: async (k) => void data.delete(k),
  };
}

function makeOutbox(send: Sender<Payload>) {
  return new Outbox<Payload>({ store: new KeyValueStore(memoryStorage()), send, policy: { claimRenewMs: 0 } });
}

describe("runBackgroundFlush", () => {
  it("sends what waits and says there is nothing left to retry", async () => {
    const sent: string[] = [];
    const outbox = makeOutbox(async (item) => {
      sent.push(item.key);
      return { type: "sent" };
    });
    await outbox.add("note", { text: "one" });
    await outbox.add("note", { text: "two" });
    const result = await runBackgroundFlush(outbox);
    expect(result).toMatchObject({ outcome: "done", retryLater: false });
    expect(result.report?.sent).toBe(2);
    expect(sent).toHaveLength(2);
  });

  it("says done with an empty outbox", async () => {
    const outbox = makeOutbox(async () => ({ type: "sent" }));
    expect(await runBackgroundFlush(outbox)).toMatchObject({ outcome: "done", retryLater: false });
  });

  it("asks to run again when an item got no answer", async () => {
    const outbox = makeOutbox(async () => ({ type: "retry" }));
    await outbox.add("note", { text: "no signal" });
    const result = await runBackgroundFlush(outbox);
    expect(result).toMatchObject({ outcome: "waiting", retryLater: true });
  });

  it("stops waiting when the budget is spent, and the item is not lost", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let calls = 0;
    const outbox = makeOutbox(async () => {
      calls += 1;
      await gate;
      return { type: "sent" };
    });
    await outbox.add("note", { text: "slow server" });
    const result = await runBackgroundFlush(outbox, { budgetMs: 10 });
    expect(result).toEqual({ outcome: "out-of-time", retryLater: true });
    release();
    await outbox.flush();
    // The attempt in flight finished; nothing was sent twice and nothing is left.
    expect(calls).toBe(1);
    expect(await outbox.list()).toHaveLength(0);
  });

  it("reports a thrown flush as failed instead of throwing", async () => {
    const outbox = makeOutbox(async () => ({ type: "sent" }));
    (outbox as unknown as { flush: () => Promise<never> }).flush = () => Promise.reject(new Error("storage gone"));
    const result = await runBackgroundFlush(outbox);
    expect(result.outcome).toBe("failed");
    expect(result.retryLater).toBe(true);
    expect((result.error as Error).message).toBe("storage gone");
  });

  it("does not leave an unhandled rejection when the flush fails after the budget", async () => {
    const outbox = makeOutbox(async () => ({ type: "sent" }));
    (outbox as unknown as { flush: () => Promise<never> }).flush = () =>
      new Promise((_, reject) => setTimeout(() => reject(new Error("late")), 30));
    const result = await runBackgroundFlush(outbox, { budgetMs: 1 });
    expect(result.outcome).toBe("out-of-time");
    await new Promise((r) => setTimeout(r, 60));
  });
});
