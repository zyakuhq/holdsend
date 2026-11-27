import { PGlite } from "@electric-sql/pglite";
import { afterAll, describe, expect, it } from "vitest";
import {
  MemoryDraftLog,
  MemoryIdempotencyStore,
  PostgresDraftLog,
  postgresDraftSchema,
  type DraftLog,
  type MemoryTx,
  type NewDraftUpdate,
  type Queryable,
} from "@holdsend/server";
import type { DraftUpdate } from "@holdsend/core/drafts";
import { draftLogContractChecks, type DraftLogHarness, type DraftLogUnderTest } from "./draft-log-contract.js";

const pglite = new PGlite();
await pglite.exec(postgresDraftSchema("contract_drafts"));
afterAll(async () => {
  await pglite.close();
});

function memoryHarness(): DraftLogHarness {
  return {
    async create() {
      const store = new MemoryIdempotencyStore();
      return { log: new MemoryDraftLog(), transaction: (fn) => store.transaction(fn) } as DraftLogUnderTest<MemoryTx> as DraftLogUnderTest;
    },
    concurrentTransactions: true,
  };
}

function postgresHarness(): DraftLogHarness {
  return {
    async create() {
      await pglite.exec("TRUNCATE contract_drafts");
      return {
        log: new PostgresDraftLog({ db: pglite, table: "contract_drafts" }),
        transaction: (fn) => pglite.transaction((tx) => fn(tx as unknown as Queryable)),
      } as DraftLogUnderTest<Queryable> as DraftLogUnderTest;
    },
    concurrentTransactions: false,
  };
}

describe.each([
  ["MemoryDraftLog", memoryHarness],
  ["PostgresDraftLog (PGlite)", postgresHarness],
] as const)("DraftLog contract: %s", (_name, make) => {
  it.each(draftLogContractChecks.map((check) => [check.name, check] as const))("%s", async (_check, check) => {
    await check.run(make());
  });
});

// A small log written for this test, with switches that each break one rule,
// to show the checks catch each way of breaking the contract.

type Flaw =
  | "starts revisions at 0"
  | "drops resolves"
  | "stores writtenAt in seconds"
  | "drops a payload that is not an object"
  | "drops empty values inside the payload"
  | "reads a text payload as JSON"
  | "cuts long payloads"
  | "appends a retry again"
  | "replays with the new content"
  | "restarts revisions in each transaction"
  | "takes the revision from the number of committed updates"
  | "adds outside the transaction"
  | "remembers a rolled-back id"
  | "lists every draft of the owner"
  | "lists newest first"
  | "joins owner and draft with a colon"
  | "finds a retry by id alone"
  | "keeps the caller's object"
  | "returns its own objects"
  | "lists updates still in a transaction";

interface Tx {
  changes: (() => void)[];
  aborts: (() => void)[];
  count: number;
}

const copy = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

class FlawedLog implements DraftLog<Tx> {
  private readonly committed = new Map<string, DraftUpdate[]>();
  private readonly pending = new Map<string, DraftUpdate[]>();
  private readonly counters = new Map<string, number>();
  constructor(private readonly flaw: Flaw | undefined) {}

  private has(f: Flaw) {
    return this.flaw === f;
  }

  private key(owner: string, draftId: string) {
    return this.has("joins owner and draft with a colon") ? `${owner}:${draftId}` : JSON.stringify([owner, draftId]);
  }

  private out(u: DraftUpdate): DraftUpdate {
    return this.has("returns its own objects") ? u : copy(u);
  }

  async append(tx: Tx, owner: string, u: NewDraftUpdate & { id: string }): Promise<DraftUpdate> {
    const k = this.key(owner, u.draftId);
    const list = this.committed.get(k) ?? [];
    if (!this.has("appends a retry again")) {
      const pool = this.has("finds a retry by id alone") ? [...this.committed.values()].flat() : list;
      const existing = pool.find((x) => x.id === u.id) ?? (this.has("remembers a rolled-back id") ? this.pending.get(k)?.find((x) => x.id === u.id) : undefined);
      if (existing) return this.has("replays with the new content") ? { ...copy(u), rev: existing.rev } : this.out(existing);
    }
    let rev: number;
    if (this.has("restarts revisions in each transaction")) rev = ++tx.count;
    else if (this.has("takes the revision from the number of committed updates")) rev = list.length + 1;
    else {
      rev = (this.counters.get(k) ?? (this.has("starts revisions at 0") ? -1 : 0)) + 1;
      this.counters.set(k, rev);
    }
    const stored: DraftUpdate = { id: u.id, draftId: u.draftId, rev, reason: u.reason };
    if (u.baseRev != null) stored.baseRev = u.baseRev;
    if (u.baseId != null) stored.baseId = u.baseId;
    if (u.resolves?.length && !this.has("drops resolves")) stored.resolves = [...u.resolves];
    if (u.writtenAt != null) stored.writtenAt = this.has("stores writtenAt in seconds") ? Math.floor(u.writtenAt / 1000) : u.writtenAt;
    if (u.payload != null && !(this.has("drops a payload that is not an object") && typeof u.payload !== "object")) {
      stored.payload = this.has("keeps the caller's object") ? u.payload : copy(u.payload);
      const text = (stored.payload as { text?: unknown }).text;
      if (this.has("drops empty values inside the payload")) stored.payload = JSON.parse(JSON.stringify(stored.payload, (k, v: unknown) => (k && (v === null || (Array.isArray(v) && !v.length)) ? undefined : v))) as unknown;
      if (this.has("reads a text payload as JSON") && typeof stored.payload === "string") {
        try {
          stored.payload = JSON.parse(stored.payload) as unknown;
        } catch {
          // Not JSON: kept as text, as the old Postgres log did.
        }
      }
      if (this.has("cuts long payloads") && typeof text === "string") stored.payload = { ...(stored.payload as object), text: text.slice(0, 32_768) };
    }
    const add = (to: Map<string, DraftUpdate[]>) => to.set(k, [...(to.get(k) ?? []), stored].sort((a, b) => a.rev - b.rev));
    const drop = () => this.pending.set(k, (this.pending.get(k) ?? []).filter((x) => x !== stored));
    if (this.has("adds outside the transaction")) add(this.committed);
    else {
      add(this.pending);
      tx.changes.push(() => {
        drop();
        add(this.committed);
      });
      if (!this.has("remembers a rolled-back id")) tx.aborts.push(drop);
    }
    return this.out(stored);
  }

  async list(owner: string, draftId: string): Promise<DraftUpdate[]> {
    let found: DraftUpdate[];
    if (this.has("lists every draft of the owner")) {
      found = [...this.committed.entries()].filter(([k]) => (JSON.parse(k) as string[])[0] === owner).flatMap(([, v]) => v);
    } else {
      const k = this.key(owner, draftId);
      found = [...(this.committed.get(k) ?? []), ...(this.has("lists updates still in a transaction") ? (this.pending.get(k) ?? []) : [])];
    }
    found = [...found].sort((a, b) => a.rev - b.rev);
    if (this.has("lists newest first")) found.reverse();
    return found.map((u) => this.out(u));
  }
}

function flawedHarness(flaw: Flaw | undefined): DraftLogHarness {
  return {
    async create() {
      const log = new FlawedLog(flaw);
      return {
        log,
        async transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
          const tx: Tx = { changes: [], aborts: [], count: 0 };
          try {
            const value = await fn(tx);
            for (const change of tx.changes) change();
            return value;
          } catch (err) {
            for (const abort of tx.aborts) abort();
            throw err;
          }
        },
      } as DraftLogUnderTest<Tx> as DraftLogUnderTest;
    },
    concurrentTransactions: true,
  };
}

/** Each flaw, the check that must catch it, and a part of the message it must fail with. */
const caughtBy: Record<Flaw, [check: string, failure: string]> = {
  "starts revisions at 0": ["an appended update is listed with every field unchanged", "the first update has revision 0"],
  "drops resolves": ["an appended update is listed with every field unchanged", "what append returned for the second update"],
  "stores writtenAt in seconds": ["an appended update is listed with every field unchanged", "what append returned for the first update"],
  "drops a payload that is not an object": ["an appended update is listed with every field unchanged", 'the payload "just text"'],
  "drops empty values inside the payload": ["an appended update is listed with every field unchanged", "what append returned for the second update"],
  "reads a text payload as JSON": ["an appended update is listed with every field unchanged", 'the payload "42"'],
  "cuts long payloads": ["a payload of 256 KiB comes back whole", "came back changed or cut"],
  "appends a retry again": ["the same id again returns the stored update and adds nothing", "a retry of the same update"],
  "replays with the new content": ["the same id again returns the stored update and adds nothing", "the same id with other content"],
  "restarts revisions in each transaction": ["each new update gets a revision above every one before it", "update 2 got revision 1"],
  "takes the revision from the number of committed updates": ["updates to one draft at the same time all keep, each with its own revision", "share revisions"],
  "adds outside the transaction": ["an append that rolls back leaves nothing, and its id can be used again", "the updates after an append rolled back"],
  "remembers a rolled-back id": ["an append that rolls back leaves nothing, and its id can be used again", "the payload when the rolled-back id is sent again"],
  "lists every draft of the owner": ["list gives one draft of one owner, lowest revision first", "the updates of one draft of one owner"],
  "lists newest first": ["list gives one draft of one owner, lowest revision first", "the updates of one draft of one owner"],
  "joins owner and draft with a colon": ["list gives one draft of one owner, lowest revision first", "owner a:b, draft c"],
  "finds a retry by id alone": ["the same id under another draft or owner is another update", "the same id for another owner"],
  "keeps the caller's object": ["the log keeps its own copies", "the update after the caller changed the objects"],
  "returns its own objects": ["the log keeps its own copies", "the update after the caller changed the objects"],
  "lists updates still in a transaction": ["an update is not listed before its transaction commits", "while an append is not yet committed"],
};

describe("DraftLog contract checks catch broken logs", () => {
  it.each(Object.entries(caughtBy))("%s", async (flaw, [name, failure]) => {
    const check = draftLogContractChecks.find((c) => c.name === name);
    expect(check, name).toBeDefined();
    const error = await check!.run(flawedHarness(flaw as Flaw)).then(
      () => undefined,
      (err: unknown) => err,
    );
    expect(String(error)).toContain("draft log contract");
    expect(String(error)).toContain(failure);
  });

  it("the same log without a flaw passes every check", async () => {
    for (const check of draftLogContractChecks) await check.run(flawedHarness(undefined));
  });

  it("every check catches at least one broken log", () => {
    const shown = new Set(Object.values(caughtBy).map(([check]) => check));
    expect(draftLogContractChecks.map((c) => c.name).filter((n) => !shown.has(n))).toEqual([]);
  });
});
