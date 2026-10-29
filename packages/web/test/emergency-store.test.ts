/**
 * Emergency messages in IndexedDB: the held flag and the ask-by time must
 * survive a write and a fresh read, because a service worker reads the queue
 * with its own Outbox.
 */
import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it } from "vitest";
import { Outbox } from "@holdsend/core";
import { EmergencyOutbox, type EmergencyMessage } from "@holdsend/core/emergency";
import { IndexedDbStore } from "../src/index.js";

const T0 = Date.parse("2026-10-29T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;

describe("emergency messages in IndexedDB", () => {
  it("keep held and ask-by for a service worker that reads the store afresh", async () => {
    const factory = new IDBFactory();
    let t = T0;
    const page = new EmergencyOutbox({ store: new IndexedDbStore<EmergencyMessage>({ name: "emergency-test", indexedDB: factory }), now: () => t, send: async () => ({ type: "sent" }) });
    await page.write("First", { owner: "p1" });
    await page.write("Second", { owner: "p1" });
    t += 2 * DAY;
    const sent: string[] = [];
    const worker = new Outbox<EmergencyMessage>({
      store: new IndexedDbStore<EmergencyMessage>({ name: "emergency-test", indexedDB: factory }),
      now: () => t,
      policy: { claimRenewMs: 0 },
      send: async (item) => {
        sent.push(item.payload.text);
        return { type: "sent" };
      },
    });
    expect(await worker.flush("p1")).toMatchObject({ sent: 0 });
    expect(sent).toEqual([]);
    const items = (await worker.list()).map((e) => e.item);
    expect(items.map((i) => [i.held === true, i.askBy])).toEqual([
      [false, T0 + DAY],
      [true, T0 + DAY],
    ]);
  });
});
