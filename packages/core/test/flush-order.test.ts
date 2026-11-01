import { describe, expect, it } from "vitest";
import { MemoryStore, Outbox, type OutboxItem } from "../src/index.js";

type Payload = { text: string };

function build(failFirst: string) {
  let t = Date.parse("2026-11-01T12:00:00.000Z");
  const attempts: string[] = [];
  const delivered: string[] = [];
  const outbox = new Outbox<Payload>({
    store: new MemoryStore<Payload>(),
    now: () => t,
    policy: { claimRenewMs: 0 },
    send: async (item: OutboxItem<Payload>) => {
      attempts.push(item.payload.text);
      if (item.payload.text === failFirst && attempts.filter((a) => a === failFirst).length === 1) {
        return { type: "retry", error: { message: "synthetic failure" } } as never;
      }
      delivered.push(item.payload.text);
      return { type: "sent" } as never;
    },
  });
  return { outbox, attempts, delivered, advance: (ms: number) => (t += ms) };
}

describe("flush order (decision 0008)", () => {
  it("tries items oldest written first", async () => {
    const { outbox, attempts, advance } = build("none");
    await outbox.add("post.create", { text: "first" });
    advance(10);
    await outbox.add("post.create", { text: "second" });
    advance(10);
    await outbox.add("post.create", { text: "third" });
    await outbox.flush();
    expect(attempts).toEqual(["first", "second", "third"]);
  });

  it("does not hold later items back when an earlier one must retry", async () => {
    const { outbox, delivered, advance } = build("first");
    await outbox.add("post.create", { text: "first" });
    advance(10);
    await outbox.add("post.create", { text: "second" });
    const report = await outbox.flush();
    expect(report.retry).toBe(1);
    expect(report.sent).toBe(1);
    // Order is not guaranteed: "second" arrived while "first" waits for a retry.
    expect(delivered).toEqual(["second"]);
  });
});
