import { describe, expect, it } from "vitest";
import { Outbox } from "@holdsend/core";
import { KeyValueStore, type AsyncKeyValue } from "../src/index.js";

describe("a long queue on a slow phone", () => {
  it("does a bounded number of storage writes per item (3 for add plus send)", async () => {
    let writes = 0;
    const data = new Map<string, string>();
    const storage: AsyncKeyValue = {
      getItem: async (k) => data.get(k) ?? null,
      setItem: async (k, v) => void (writes++, data.set(k, v)),
      removeItem: async (k) => void data.delete(k),
    };
    const outbox = new Outbox<{ text: string }>({ store: new KeyValueStore(storage), send: async () => ({ type: "sent" }), policy: { claimRenewMs: 0 } });
    const n = 200;
    for (let i = 0; i < n; i++) await outbox.add("note.create", { text: `note ${i}` });
    await outbox.flush();
    expect((await outbox.list()).length).toBe(0);
    expect(writes).toBeLessThanOrEqual(3 * n + 2);
  });
});
