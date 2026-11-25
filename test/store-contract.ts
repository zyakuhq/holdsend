/**
 * The client `Store` contract from packages/core/src/store.ts, as checks any
 * store can be run through. Each check throws when the store breaks the
 * contract. `test/store-contract.test.ts` runs them against every built-in
 * store, and against deliberately broken stores to show each check can fail.
 *
 * A harness gives a fresh, empty place to keep items (`open()` returns a new
 * store over it, like a new tab or an app restart). Two stores from the same
 * harness share their items.
 */
import type { OutboxItem, Store } from "@holdsend/core";

export type Payload = { text: string; tags?: string[]; nested?: { n: number; list: unknown[] } };

export interface StoreHarness {
  /** A new store over this harness's items. */
  open(): Store<Payload>;
  /** Whether `isDurable()` should say true for a store that works normally. */
  durable: boolean;
}

export interface ContractCheck {
  name: string;
  run(make: () => StoreHarness): Promise<void>;
}

function fail(message: string): never {
  throw new Error(`store contract: ${message}`);
}

/** Items sorted by key: a store may return items in any order (the outbox sorts them itself). */
function byKey(items: OutboxItem<Payload>[]): OutboxItem<Payload>[] {
  return [...items].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

function same(actual: unknown, expected: unknown, what: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) fail(`${what}\n  expected ${e}\n  got      ${a}`);
}

export function plainItem(key: string, text = key): OutboxItem<Payload> {
  return { key, kind: "post.create", payload: { text }, writtenAt: 1_700_000_000_000, state: "waiting", attempts: 0, touched: false };
}

/** An item with every optional field the library keeps, set to a value that must come back unchanged. */
export function fullItem(key: string): OutboxItem<Payload> {
  return {
    key,
    kind: "note.update",
    payload: { text: "Ünïcode, \"quotes\", <b>tags</b>, emoji 🛰️ and a\nnewline", tags: ["a", "b"], nested: { n: 0.1, list: [null, true, 0, "", { deep: [1] }] } },
    owner: "synthetic-owner-1",
    writtenAt: 1_700_000_000_123,
    state: "sending",
    attempts: 3,
    touched: true,
    claimedAt: 1_700_000_100_000,
    claimToken: "claim-token-synthetic",
    approvedAt: 1_700_000_050_000,
    held: true,
    askBy: 1_700_086_400_123,
    stuckReason: "attempts_exhausted",
    lastError: { code: "E_SYNTHETIC", message: "a synthetic error" },
    lastAttempt: "no_answer",
    sentAt: 1_700_000_200_000,
    retryAt: 1_700_000_300_000,
    failures: 2,
    noAnswerSince: 1_700_000_090_000,
    timeouts: 1,
  };
}

export const contractChecks: ContractCheck[] = [
  {
    name: "a new store reads as empty",
    async run(make) {
      same(await make().open().read(), [], "read() of a new store");
    },
  },
  {
    name: "update saves what fn leaves and returns what fn returns",
    async run(make) {
      const store = make().open();
      const result = await store.update((items) => {
        items.push(plainItem("k-1"), plainItem("k-2"), plainItem("k-3"));
        return "fn result";
      });
      same(result, "fn result", "update() result");
      await store.update((items) => {
        items.splice(1, 1);
        items.find((i) => i.key === "k-1")!.attempts = 7;
      });
      same(byKey(await store.read()).map((i) => [i.key, i.attempts]), [["k-1", 7], ["k-3", 0]], "items after two updates");
    },
  },
  {
    name: "items come back unchanged, every field, after a reopen",
    async run(make) {
      const harness = make();
      const items = [fullItem("k-full"), plainItem("k-plain")];
      await harness.open().update((stored) => {
        stored.push(...structuredClone(items));
      });
      same(byKey(await harness.open().read()), byKey(items), "items read by a new store");
    },
  },
  {
    name: "when fn throws, nothing is saved, the error reaches the caller, and the store still works",
    async run(make) {
      const store = make().open();
      await store.update((items) => {
        items.push(plainItem("k-kept"));
      });
      const boom = new Error("fn failed");
      let caught: unknown;
      try {
        await store.update((items) => {
          items.push(plainItem("k-lost"));
          items[0]!.attempts = 99;
          throw boom;
        });
      } catch (error) {
        caught = error;
      }
      if (caught !== boom) fail(`update() should reject with the error fn threw, got ${String(caught)}`);
      same(await store.read(), [plainItem("k-kept")], "items after a throwing update");
      await store.update((items) => {
        items.push(plainItem("k-after"));
      });
      same(byKey(await store.read()).map((i) => i.key), ["k-after", "k-kept"], "items after the next update");
    },
  },
  {
    name: "the store keeps its own copies of what it is given",
    async run(make) {
      const store = make().open();
      const given = plainItem("k-given");
      let array: OutboxItem<Payload>[] = [];
      await store.update((items) => {
        items.push(given);
        array = items;
      });
      given.payload.text = "changed by the caller";
      given.attempts = 42;
      array.push(plainItem("k-sneaked-in"));
      same(await store.read(), [plainItem("k-given")], "items after the caller changed what it gave");
    },
  },
  {
    name: "the store never hands out objects it keeps",
    async run(make) {
      const store = make().open();
      await store.update((items) => {
        items.push(plainItem("k-1"));
      });
      const first = await store.read();
      first[0]!.payload.text = "changed by the caller";
      first.push(plainItem("k-sneaked-in"));
      let seen: OutboxItem<Payload>[] = [];
      await store.update((items) => {
        seen = items;
      });
      seen[0]!.state = "sent";
      same(await store.read(), [plainItem("k-1")], "items after the caller changed what it read");
    },
  },
  {
    name: "concurrent updates from two stores over the same items never lose a write",
    async run(make) {
      const harness = make();
      const a = harness.open();
      const b = harness.open();
      await a.update((items) => {
        items.push(plainItem("k-counter"));
      });
      const rounds = 30;
      await Promise.all(
        Array.from({ length: rounds }, (_, n) =>
          (n % 2 === 0 ? a : b).update((items) => {
            items.find((i) => i.key === "k-counter")!.attempts += 1;
            if (n % 3 === 0) items.push(plainItem(`k-extra-${n}`));
          }),
        ),
      );
      const items = await harness.open().read();
      same(items.find((i) => i.key === "k-counter")?.attempts, rounds, "the counter after concurrent increments");
      same(items.length, 1 + Math.ceil(rounds / 3), "items after concurrent adds");
    },
  },
  {
    name: "a read during updates sees a whole update or none of it",
    async run(make) {
      const harness = make();
      const writer = harness.open();
      const reader = harness.open();
      await writer.update((items) => {
        items.push(plainItem("k-a"), plainItem("k-b"));
      });
      // Start every write, then read again and again until they are all done.
      let settled = false;
      const writes = Promise.all(
        Array.from({ length: 15 }, (_, n) =>
          writer.update((items) => {
            for (const item of items) item.attempts = n + 1;
          }),
        ),
      ).finally(() => {
        settled = true;
      });
      const reads: OutboxItem<Payload>[][] = [];
      while (!settled) {
        reads.push(await reader.read());
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      await writes;
      for (const items of reads) {
        const [a, b] = byKey(items);
        if (a?.attempts !== b?.attempts) fail(`a read saw half an update: ${a?.attempts} and ${b?.attempts}`);
      }
    },
  },
  {
    name: "isDurable says whether items survive a restart",
    async run(make) {
      const harness = make();
      const durable = await harness.open().isDurable();
      if (typeof durable !== "boolean") fail(`isDurable() should give a boolean, got ${String(durable)}`);
      same(durable, harness.durable, "isDurable()");
    },
  },
];
