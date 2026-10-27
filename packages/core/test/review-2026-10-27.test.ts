/**
 * Regression tests for the independent source review of 0.1.0 (2026-10-27).
 * HS-006 failed on the code before its fix. HS-001 is in
 * packages/server/test/real-postgres.test.ts, since it needs real connections.
 */
import { describe, expect, it } from "vitest";
import { Outbox, type OutboxItem, type Store } from "../src/index.js";

/** A custom store that keeps the objects it is given, as a careless adapter might. */
class ReferenceStore<P> implements Store<P> {
  items: OutboxItem<P>[] = [];
  async read(): Promise<OutboxItem<P>[]> {
    return this.items;
  }
  async update<T>(fn: (items: OutboxItem<P>[]) => T): Promise<T> {
    return fn(this.items);
  }
  async isDurable(): Promise<boolean> {
    return false;
  }
}

describe("HS-006: a payload changed after add()", () => {
  it("does not change what is queued or sent, even with a store that keeps references", async () => {
    type Draft = { text: string; tags: string[] };
    const store = new ReferenceStore<Draft>();
    const sent: string[] = [];
    const outbox = new Outbox<Draft>({
      store,
      policy: { claimRenewMs: 0 },
      send: async (item) => {
        sent.push(JSON.stringify(item.payload));
        return { type: "sent" };
      },
    });

    const draft: Draft = { text: "as written", tags: ["a"] };
    const added = await outbox.add("post.create", draft);
    draft.text = "edited after add";
    draft.tags.push("b");
    added.payload.text = "edited through the returned item";
    added.payload.tags.push("c");

    expect(store.items[0]?.payload).toEqual({ text: "as written", tags: ["a"] });
    await outbox.flush();
    expect(sent).toEqual([JSON.stringify({ text: "as written", tags: ["a"] })]);
  });
});
