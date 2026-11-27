/**
 * The server `DraftLog` contract from packages/server/src/drafts.ts, as checks
 * any draft log can be run through. Each check throws when the log breaks the
 * contract. `test/draft-log-contract.test.ts` runs them against
 * `MemoryDraftLog` and `PostgresDraftLog`, and against deliberately broken
 * logs to show each check can fail.
 *
 * To test your own log (MySQL, SQLite, DynamoDB...), copy this file and give
 * it a harness: a way to make a new, empty log, and the transaction of the
 * idempotency store it is used with, since `acceptDraftUpdate` appends inside
 * that transaction.
 */
import { isDeepStrictEqual } from "node:util";
import type { DraftLog, NewDraftUpdate } from "@holdsend/server";
import type { DraftUpdate } from "@holdsend/core/drafts";

export interface DraftLogUnderTest<Tx = unknown> {
  log: DraftLog<Tx>;
  /**
   * Runs `fn` in one transaction of the store the log is used with: commits
   * when it resolves, rolls back when it throws, and rethrows that same error
   * (not a wrapped one; the rollback check looks for it).
   */
  transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
}

export interface DraftLogHarness<Tx = unknown> {
  /** A new log with no updates. A check may call this more than once; it is done with the earlier log by then. */
  create(): Promise<DraftLogUnderTest<Tx>>;
  /**
   * True when `list` can run while a transaction is open. The check that an
   * update is not listed before its commit needs it; PGlite has one
   * connection, so it cannot run there. Required, so a copied harness says
   * on purpose that it skips that check.
   */
  concurrentTransactions: boolean;
}

export interface DraftLogContractCheck {
  name: string;
  run(harness: DraftLogHarness): Promise<void>;
}

/** The largest revision a device may send back as `baseRev` (`checkDraftUpdate` refuses more). */
const MAX_REV = 2147483647;

const OWNER = "person-a";
const DRAFT = "draft-1";

function fail(message: string): never {
  throw new Error(`draft log contract: ${message}`);
}

type Update = NewDraftUpdate & { id: string };

/**
 * An update's optional fields that are null or undefined, and `resolves`
 * when empty, mean the same to `readDraft` as absent ones, so they compare
 * equal. Only those top-level fields: the payload is compared exactly.
 */
function normalise(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(normalise);
  if (v === null || typeof v !== "object" || !("draftId" in v)) return v;
  const out: Record<string, unknown> = { ...(v as Record<string, unknown>) };
  for (const k of ["baseRev", "baseId", "writtenAt", "payload", "resolves"]) {
    if (out[k] === null || out[k] === undefined || (k === "resolves" && Array.isArray(out[k]) && (out[k] as unknown[]).length === 0)) delete out[k];
  }
  return out;
}

function plain(v: unknown): unknown {
  const s = JSON.stringify(normalise(v));
  return s === undefined ? s : JSON.parse(s);
}

function same(actual: unknown, expected: unknown, what: string): void {
  // Compared as plain JSON values, so the order of fields in an object does not matter.
  if (!isDeepStrictEqual(plain(actual), plain(expected))) fail(`${what}\n  expected ${JSON.stringify(plain(expected))}\n  got      ${JSON.stringify(plain(actual))}`);
}

function update(id: string, extra: Partial<Update> = {}): Update {
  return { id, draftId: DRAFT, reason: "edit", ...extra };
}

/** The update as a log should store it: the input plus a revision. */
function stored(u: Update, rev: number): DraftUpdate {
  return { ...(JSON.parse(JSON.stringify(u)) as Update), rev };
}

async function setup(harness: DraftLogHarness) {
  const t = await harness.create();
  async function append(u: Update, owner = OWNER): Promise<DraftUpdate> {
    return t.transaction((tx) => t.log.append(tx, owner, u));
  }
  async function list(draftId = DRAFT, owner = OWNER): Promise<DraftUpdate[]> {
    return t.log.list(owner, draftId);
  }
  return { ...t, append, list };
}

function checkRev(rev: unknown, what: string): number {
  if (typeof rev !== "number" || !Number.isSafeInteger(rev) || rev < 1 || rev > MAX_REV) fail(`${what} has revision ${JSON.stringify(rev)}, not a whole number from 1 to ${MAX_REV}`);
  return rev;
}

function revs(list: DraftUpdate[]): number[] {
  return list.map((u) => u.rev);
}

function ids(list: DraftUpdate[]): string[] {
  return list.map((u) => u.id);
}

class Rollback extends Error {}

async function rolledBack(work: Promise<unknown>): Promise<void> {
  try {
    await work;
  } catch (err) {
    if (err instanceof Rollback) return;
    throw err;
  }
  fail("the transaction that should roll back committed");
}

export const draftLogContractChecks: DraftLogContractCheck[] = [
  {
    name: "an appended update is listed with every field unchanged",
    async run(harness) {
      const s = await setup(harness);
      const first = update("u-1", { writtenAt: Date.parse("2026-11-27T10:00:00.000Z"), payload: { title: "Plain" } });
      const a = await s.append(first);
      const rev1 = checkRev(a.rev, "the first update");
      same(a, stored(first, rev1), "what append returned for the first update");
      const second = update("u-2", {
        baseRev: rev1,
        baseId: "u-1",
        reason: "resolve",
        resolves: ["u-0", "u-x"],
        writtenAt: 8.64e15,
        payload: { text: "Ünïcode, \"quotes\", <b>tags</b>, emoji 🛰️ and a\nnewline", list: [null, true, 0, "", { deep: [0.1, -2, 1e21] }], n: null, e: [], o: {} },
      });
      const b = await s.append(second);
      const rev2 = checkRev(b.rev, "the second update");
      same(b, stored(second, rev2), "what append returned for the second update");
      const bare = update("u-3", { reason: "delete" });
      const c = await s.append(bare);
      same(c, stored(bare, checkRev(c.rev, "the third update")), "what append returned for an update with only the required fields");
      for (const payload of ["just text", "42", "null", '"quoted"', 42, false, ["a", "b"], []]) {
        const u = update(`u-scalar-${JSON.stringify(payload)}`, { payload });
        const got = await s.append(u);
        same(got.payload, payload, `the payload ${JSON.stringify(payload)} as append returned it`);
      }
      const listed = await s.list();
      same(listed.slice(0, 3), [a, b, c], "the listed updates (the same as append returned)");
      same(listed.slice(3).map((u) => u.payload), ["just text", "42", "null", '"quoted"', 42, false, ["a", "b"], []], "payloads that are not objects, as listed");
    },
  },
  {
    name: "a payload of 256 KiB comes back whole",
    async run(harness) {
      const s = await setup(harness);
      // checkDraftUpdate allows up to 256 KiB of JSON; this is just under it, in characters of two and three bytes.
      const text = "é€".repeat(52_000);
      const u = update("u-big", { payload: { text } });
      await s.append(u);
      const [got] = await s.list();
      if ((got?.payload as { text?: string } | undefined)?.text !== text) fail(`a payload of ${JSON.stringify(u.payload).length} characters came back changed or cut`);
    },
  },
  {
    name: "the same id again returns the stored update and adds nothing",
    async run(harness) {
      const s = await setup(harness);
      const first = update("u-1", { payload: { v: 1 } });
      const a = await s.append(first);
      same(await s.append(first), a, "a retry of the same update");
      await s.append(update("u-2", { baseId: "u-1", baseRev: a.rev }));
      same(await s.append(update("u-1", { payload: { v: 2 }, reason: "other" })), a, "the same id with other content, after a later update (the first one stays)");
      same(ids(await s.list()), ["u-1", "u-2"], "the updates listed after two retries");
      same((await s.list())[0], a, "the first update after two retries");
    },
  },
  {
    name: "each new update gets a revision above every one before it",
    async run(harness) {
      const s = await setup(harness);
      const seen: number[] = [];
      for (let i = 1; i <= 12; i++) {
        const got = await s.append(update(`u-${i}`));
        const rev = checkRev(got.rev, `update ${i}`);
        if (seen.length && rev <= Math.max(...seen)) fail(`update ${i} got revision ${rev} after revisions ${seen.join(", ")}`);
        seen.push(rev);
      }
      same(revs(await s.list()), seen, "the listed revisions");
    },
  },
  {
    name: "updates to one draft at the same time all keep, each with its own revision",
    async run(harness) {
      // Every append must succeed. On a database that aborts one of two
      // conflicting transactions (SERIALIZABLE, CockroachDB), the log itself
      // must retry: acceptDraftUpdate does not, and the device would only
      // send again later.
      const s = await setup(harness);
      const n = 25;
      const results = await Promise.allSettled(Array.from({ length: n }, (_, i) => s.append(update(`u-${String(i).padStart(2, "0")}`))));
      const failed = results.filter((r) => r.status === "rejected");
      if (failed.length) fail(`${failed.length} of ${n} appends at once failed, first with ${String((failed[0] as PromiseRejectedResult).reason)}`);
      const listed = await s.list();
      if (listed.length !== n) fail(`${n} appends at once left ${listed.length} updates`);
      const unique = new Set(revs(listed));
      if (unique.size !== n) fail(`${n} appends at once share revisions: ${revs(listed).join(", ")}`);
      for (const r of results) {
        const got = (r as PromiseFulfilledResult<DraftUpdate>).value;
        const mine = listed.find((u) => u.id === got.id);
        if (!mine || mine.rev !== got.rev) fail(`append returned revision ${got.rev} for ${got.id}, but the log lists ${mine ? mine.rev : "nothing"}`);
      }
    },
  },
  {
    name: "an append that rolls back leaves nothing, and its id can be used again",
    async run(harness) {
      const s = await setup(harness);
      const a = await s.append(update("u-1"));
      await rolledBack(
        s.transaction(async (tx) => {
          await s.log.append(tx, OWNER, update("u-2", { payload: { lost: true } }));
          throw new Rollback("roll back");
        }),
      );
      same(ids(await s.list()), ["u-1"], "the updates after an append rolled back");
      const again = await s.append(update("u-2", { payload: { lost: false } }));
      same(again.payload, { lost: false }, "the payload when the rolled-back id is sent again");
      if (checkRev(again.rev, "the update sent again") <= a.rev) fail(`the update sent again got revision ${again.rev}, not above ${a.rev}`);
      same(ids(await s.list()), ["u-1", "u-2"], "the updates after the rolled-back id was sent again");
    },
  },
  {
    name: "list gives one draft of one owner, lowest revision first",
    async run(harness) {
      const s = await setup(harness);
      // Interleaved, and with owner and draft ids that would collide if joined with a separator.
      const plan: [owner: string, draftId: string, id: string][] = [
        [OWNER, DRAFT, "u-1"],
        ["person-b", DRAFT, "b-1"],
        [OWNER, "draft-2", "d2-1"],
        [OWNER, DRAFT, "u-2"],
        ["a:b", "c", "x-1"],
        ["a", "b:c", "y-1"],
        ['a","b', "c", "z-1"],
        ["a", 'b","c', "w-1"],
        [OWNER, DRAFT, "u-3"],
      ];
      for (const [owner, draftId, id] of plan) await s.append({ id, draftId, reason: "edit" }, owner);
      const mine = await s.list();
      same(ids(mine), ["u-1", "u-2", "u-3"], "the updates of one draft of one owner");
      const sorted = [...revs(mine)].sort((x, y) => x - y);
      same(revs(mine), sorted, "the order of the listed revisions");
      same(ids(await s.list(DRAFT, "person-b")), ["b-1"], "another owner's updates to a draft with the same id");
      same(ids(await s.list("draft-2")), ["d2-1"], "the same owner's other draft");
      same(ids(await s.list("c", "a:b")), ["x-1"], "owner a:b, draft c");
      same(ids(await s.list("b:c", "a")), ["y-1"], "owner a, draft b:c");
      same(ids(await s.list("c", 'a","b')), ["z-1"], 'owner a","b, draft c');
      same(ids(await s.list('b","c', "a")), ["w-1"], 'owner a, draft b","c');
      same(await s.list("draft-none"), [], "a draft with no updates");
    },
  },
  {
    name: "the same id under another draft or owner is another update",
    async run(harness) {
      const s = await setup(harness);
      const a = await s.append(update("u-1", { payload: { who: "a" } }));
      const b = await s.append(update("u-1", { payload: { who: "b" } }), "person-b");
      const c = await s.append({ ...update("u-1", { payload: { who: "c" } }), draftId: "draft-2" });
      same(b.payload, { who: "b" }, "the same id for another owner (not a replay of the first)");
      same(c.payload, { who: "c" }, "the same id in another draft (not a replay of the first)");
      same(await s.list(), [a], "the first owner's draft");
      same(await s.list(DRAFT, "person-b"), [b], "the other owner's draft");
      same(await s.list("draft-2"), [c], "the other draft");
    },
  },
  {
    name: "the log keeps its own copies",
    async run(harness) {
      const s = await setup(harness);
      const input = update("u-1", { resolves: ["u-0"], payload: { tags: ["a"] } });
      const expected = JSON.parse(JSON.stringify(input)) as Update;
      const returned = await s.append(input);
      (input.payload as { tags: string[] }).tags.push("changed by the caller");
      (input.resolves as string[]).push("u-changed");
      input.reason = "changed";
      (returned.payload as { tags: string[] }).tags.push("changed in the returned copy");
      (returned as { reason: string }).reason = "changed";
      const listed = await s.list();
      (listed[0]!.payload as { tags: string[] }).tags.push("changed in the listed copy");
      (listed[0]!.resolves as string[]).push("u-changed");
      const [now] = await s.list();
      same({ ...now, rev: 0 }, { ...expected, rev: 0 }, "the update after the caller changed the objects");
      same(await s.append(update("u-1")), { ...expected, rev: now!.rev }, "a retry after the caller changed the objects");
    },
  },
  {
    name: "an update is not listed before its transaction commits",
    async run(harness) {
      if (!harness.concurrentTransactions) return;
      const s = await setup(harness);
      await s.append(update("u-1"));
      await s.transaction(async (tx) => {
        await s.log.append(tx, OWNER, update("u-2"));
        same(ids(await s.list()), ["u-1"], "the updates listed while an append is not yet committed");
      });
      same(ids(await s.list()), ["u-1", "u-2"], "the updates listed after the commit");
    },
  },
];
