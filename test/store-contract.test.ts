import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it } from "vitest";
import { MemoryStore, type OutboxItem, type Store } from "@holdsend/core";
import { IndexedDbStore } from "@holdsend/web";
import { KeyValueStore, fromMmkv, type AsyncKeyValue } from "@holdsend/react-native";
import { contractChecks, type Payload, type StoreHarness } from "./store-contract.js";

const tick = () => new Promise((resolve) => setTimeout(resolve, Math.floor(Math.random() * 3)));

/** AsyncStorage-like: every call yields to the event loop, like the real bridge. */
function fakeAsyncStorage(): AsyncKeyValue {
  const data = new Map<string, string>();
  return {
    async getItem(k) {
      await tick();
      return data.get(k) ?? null;
    },
    async setItem(k, v) {
      await tick();
      data.set(k, v);
    },
    async removeItem(k) {
      await tick();
      data.delete(k);
    },
  };
}

let databases = 0;

const builtIn: Record<string, () => StoreHarness> = {
  MemoryStore: () => {
    // One store per harness: a MemoryStore's items live in the store itself.
    const store = new MemoryStore<Payload>();
    return { open: () => store, durable: false };
  },
  IndexedDbStore: () => {
    const factory = new IDBFactory();
    const name = `contract-${(databases += 1)}`;
    return { open: () => new IndexedDbStore<Payload>({ name, indexedDB: factory }), durable: true };
  },
  "KeyValueStore over AsyncStorage": () => {
    const storage = fakeAsyncStorage();
    // Stores over one storage share their update chain only within one
    // runtime, which is the case the contract covers for React Native.
    return { open: () => new KeyValueStore<Payload>(storage), durable: true };
  },
  "KeyValueStore over MMKV": () => {
    const data = new Map<string, string>();
    const mmkv = fromMmkv({ getString: (k) => data.get(k), set: (k, v) => void data.set(k, v), delete: (k) => void data.delete(k) });
    return { open: () => new KeyValueStore<Payload>(mmkv), durable: true };
  },
};

describe.each(Object.entries(builtIn))("Store contract: %s", (_name, make) => {
  it.each(contractChecks.map((check) => [check.name, check] as const))("%s", async (_check, check) => {
    await check.run(make);
  });
});

// Deliberately broken stores, each over one shared JSON string, to show that
// the checks catch each way of breaking the contract.

type Box = { json: string };

function correctUpdate<T>(box: Box, fn: (items: OutboxItem<Payload>[]) => T): T {
  const working = JSON.parse(box.json) as OutboxItem<Payload>[];
  const result = fn(working);
  box.json = JSON.stringify(working);
  return result;
}

/** A store that works, apart from what each subclass breaks. */
class BoxStore implements Store<Payload> {
  constructor(protected box: Box) {}
  async read(): Promise<OutboxItem<Payload>[]> {
    return JSON.parse(this.box.json) as OutboxItem<Payload>[];
  }
  async update<T>(fn: (items: OutboxItem<Payload>[]) => T): Promise<T> {
    return correctUpdate(this.box, fn);
  }
  async isDurable(): Promise<boolean> {
    return true;
  }
}

/**
 * `shared`: every open() of a harness gives the same store object over one
 * box. `perOpen`: every open() gives a new store object over the same box.
 * `fresh`: every open() gives a new store over a new, empty box.
 */
type Opens = "shared" | "perOpen" | "fresh";

const broken: Record<string, { store: (box: Box) => Store<Payload>; breaks: string; opens?: Opens }> = {
  "serialises updates only within one store object": {
    breaks: "concurrent updates from two stores over the same items never lose a write",
    opens: "perOpen",
    store: (box) =>
      new (class extends BoxStore {
        private chain: Promise<unknown> = Promise.resolve();
        override update<T>(fn: (items: OutboxItem<Payload>[]) => T): Promise<T> {
          const run = this.chain.then(async () => {
            const working = JSON.parse(this.box.json) as OutboxItem<Payload>[];
            await tick();
            const result = fn(working);
            this.box.json = JSON.stringify(working);
            return result;
          });
          this.chain = run.catch(() => undefined);
          return run;
        }
      })(box),
  },
  "clears everything, then writes items back one at a time": {
    breaks: "a read during updates sees a whole update or none of it",
    opens: "perOpen",
    store: (box) =>
      new (class extends BoxStore {
        private chain: Promise<unknown> = Promise.resolve();
        override update<T>(fn: (items: OutboxItem<Payload>[]) => T): Promise<T> {
          const run = this.chain.then(async () => {
            const working = JSON.parse(this.box.json) as OutboxItem<Payload>[];
            const result = fn(working);
            this.box.json = "[]";
            await tick();
            this.box.json = JSON.stringify(working);
            return result;
          });
          this.chain = run.catch(() => undefined);
          return run;
        }
      })(box),
  },
  "reads, waits, then writes": {
    breaks: "concurrent updates from two stores over the same items never lose a write",
    store: (box) =>
      new (class extends BoxStore {
        override async update<T>(fn: (items: OutboxItem<Payload>[]) => T): Promise<T> {
          const working = JSON.parse(this.box.json) as OutboxItem<Payload>[];
          await tick();
          const result = fn(working);
          this.box.json = JSON.stringify(working);
          return result;
        }
      })(box),
  },
  "keeps the array fn changed": {
    breaks: "the store keeps its own copies of what it is given",
    store: (box) => {
      let kept: OutboxItem<Payload>[] | undefined;
      return new (class extends BoxStore {
        override async read() {
          return JSON.parse(JSON.stringify(kept ?? [])) as OutboxItem<Payload>[];
        }
        override async update<T>(fn: (items: OutboxItem<Payload>[]) => T): Promise<T> {
          const working = kept ?? [];
          const result = fn(working);
          kept = working;
          return result;
        }
      })(box);
    },
  },
  "hands out the array it keeps": {
    breaks: "the store never hands out objects it keeps",
    store: (box) => {
      let kept: OutboxItem<Payload>[] = [];
      return new (class extends BoxStore {
        override async read() {
          return kept;
        }
        override async update<T>(fn: (items: OutboxItem<Payload>[]) => T): Promise<T> {
          const working = JSON.parse(JSON.stringify(kept)) as OutboxItem<Payload>[];
          const result = fn(working);
          kept = working;
          return result;
        }
      })(box);
    },
  },
  "saves before fn finishes": {
    breaks: "when fn throws, nothing is saved, the error reaches the caller, and the store still works",
    store: (box) =>
      new (class extends BoxStore {
        override async update<T>(fn: (items: OutboxItem<Payload>[]) => T): Promise<T> {
          const working = JSON.parse(this.box.json) as OutboxItem<Payload>[];
          try {
            return fn(working);
          } finally {
            this.box.json = JSON.stringify(working);
          }
        }
      })(box),
  },
  "swallows the error fn threw": {
    breaks: "when fn throws, nothing is saved, the error reaches the caller, and the store still works",
    store: (box) =>
      new (class extends BoxStore {
        override async update<T>(fn: (items: OutboxItem<Payload>[]) => T): Promise<T> {
          try {
            return correctUpdate(this.box, fn);
          } catch {
            return undefined as T;
          }
        }
      })(box),
  },
  "drops a field it does not know": {
    breaks: "items come back unchanged, every field, after a reopen",
    store: (box) =>
      new (class extends BoxStore {
        override async read() {
          return (await super.read()).map((item) => {
            const copy = { ...item };
            delete copy.claimToken;
            return copy;
          });
        }
      })(box),
  },
  "writes items one at a time": {
    breaks: "a read during updates sees a whole update or none of it",
    store: (box) =>
      new (class extends BoxStore {
        private chain: Promise<unknown> = Promise.resolve();
        override update<T>(fn: (items: OutboxItem<Payload>[]) => T): Promise<T> {
          const run = this.chain.then(async () => {
            const working = JSON.parse(this.box.json) as OutboxItem<Payload>[];
            const result = fn(working);
            const saved = JSON.parse(this.box.json) as OutboxItem<Payload>[];
            for (let i = 0; i < working.length; i += 1) {
              saved[i] = working[i]!;
              this.box.json = JSON.stringify(saved);
              await tick();
            }
            this.box.json = JSON.stringify(working);
            return result;
          });
          this.chain = run.catch(() => undefined);
          return run;
        }
      })(box),
  },
  "says durable while it keeps nothing": {
    breaks: "a store that says durable keeps items for a new store",
    opens: "fresh",
    store: (box) => new BoxStore(box),
  },
};

describe("Store contract checks catch broken stores", () => {
  it.each(Object.entries(broken))("%s", async (_name, { store, breaks, opens = "shared" }) => {
    const check = contractChecks.find((c) => c.name === breaks);
    expect(check, breaks).toBeDefined();
    const make = (): StoreHarness => {
      const box: Box = { json: "[]" };
      const shared = store(box);
      const open = { shared: () => shared, perOpen: () => store(box), fresh: () => store({ json: "[]" }) }[opens];
      return { open, durable: true };
    };
    await expect(check!.run(make)).rejects.toThrow(/store contract/);
  });

  it("a store that keeps the contract passes every check, also with fields in another order", async () => {
    for (const check of contractChecks) {
      await check.run(() => {
        const box: Box = { json: "[]" };
        return {
          open: () =>
            new (class extends BoxStore {
              // Rebuilt from "columns": the same fields, in reverse order.
              override async read() {
                return (await super.read()).map((item) => Object.fromEntries(Object.entries(item).reverse()) as unknown as OutboxItem<Payload>);
              }
            })(box),
          durable: true,
        };
      });
    }
  });
});
