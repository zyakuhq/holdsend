/* eslint-disable @typescript-eslint/no-explicit-any -- the two stores have different transaction types; the suite runs the same cases on both */
import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import {
  checkDraftUpdate,
  MemoryDraftLog,
  MemoryIdempotencyStore,
  PostgresDraftLog,
  PostgresIdempotencyStore,
  acceptDraftUpdate,
  postgresDraftSchema,
  postgresSchema,
  readDraftState,
  type DraftLog,
  type IdempotencyStore,
  type NewDraftUpdate,
} from "../src/index.js";

async function pgSetup() {
  const db = new PGlite();
  await db.exec(postgresSchema());
  await db.exec(postgresDraftSchema());
  const store = new PostgresIdempotencyStore({ db, transaction: (fn) => db.transaction(fn as never) });
  const log = new PostgresDraftLog({ db });
  return { store, log };
}

const setups: [string, () => Promise<{ store: IdempotencyStore<any>; log: DraftLog<any> }>][] = [
  ["memory", async () => ({ store: new MemoryIdempotencyStore(), log: new MemoryDraftLog() })],
  ["postgres (PGlite)", pgSetup],
];

describe.each(setups)("draft updates, %s", (_name, setup) => {
  const send = (s: Awaited<ReturnType<typeof setup>>, key: string, update: NewDraftUpdate, owner = "person-a") =>
    acceptDraftUpdate({ ...s, owner, headers: { "Idempotency-Key": key }, update, waitMs: 0 });

  it("moves forward on one device, no conflict", async () => {
    const s = await setup();
    const a = await send(s, "u-0000001", { draftId: "d1", reason: "edit", payload: { text: "one" } });
    const b = await send(s, "u-0000002", { draftId: "d1", reason: "edit", baseRev: 1, payload: { text: "two" } });
    expect(a.status).toBe(201);
    expect((b.body as { rev: number }).rev).toBe(2);
    const st = await readDraftState(s.log, "person-a", "d1");
    expect(st.conflicted).toBe(false);
    expect(st.latest?.id).toBe("u-0000002");
  });

  it("keeps both edits from a shared base and lists two heads", async () => {
    const s = await setup();
    await send(s, "u-0000001", { draftId: "d1", reason: "edit", payload: "base" });
    const phone = await send(s, "u-phone-01", { draftId: "d1", reason: "edit", baseRev: 1, payload: "phone" });
    const laptop = await send(s, "u-laptop-1", { draftId: "d1", reason: "edit", baseRev: 1, payload: "laptop" });
    expect(phone.status).toBe(201);
    expect(laptop.status).toBe(201);
    const st = await readDraftState<string>(s.log, "person-a", "d1");
    expect(st.conflicted).toBe(true);
    expect(st.unresolved.map((u) => u.payload).sort()).toEqual(["laptop", "phone"]);
  });

  it("closes a conflict only with an explicit resolve", async () => {
    const s = await setup();
    await send(s, "u-0000001", { draftId: "d1", reason: "edit" });
    await send(s, "u-phone-01", { draftId: "d1", reason: "edit", baseRev: 1 });
    await send(s, "u-laptop-1", { draftId: "d1", reason: "edit", baseRev: 1 });
    await send(s, "u-resolve1", { draftId: "d1", reason: "resolve", baseRev: 3, resolves: ["u-phone-01", "u-laptop-1"], payload: "merged by a person" });
    const st = await readDraftState(s.log, "person-a", "d1");
    expect(st.conflicted).toBe(false);
    expect(st.latest?.id).toBe("u-resolve1");
  });

  it("a retry with the same key adds nothing and returns the same answer", async () => {
    const s = await setup();
    const first = await send(s, "u-0000001", { draftId: "d1", reason: "edit", payload: "x" });
    const again = await send(s, "u-0000001", { draftId: "d1", reason: "edit", payload: "x" });
    expect(again.outcome).toBe("replayed");
    expect(again.body).toEqual(first.body);
    expect((await s.log.list("person-a", "d1")).length).toBe(1);
  });

  it("refuses the same key with different content, and a missing key", async () => {
    const s = await setup();
    await send(s, "u-0000001", { draftId: "d1", reason: "edit", payload: "x" });
    expect((await send(s, "u-0000001", { draftId: "d1", reason: "edit", payload: "y" })).status).toBe(409);
    const none = await acceptDraftUpdate({ ...s, owner: "person-a", headers: {}, update: { draftId: "d1", reason: "edit" } });
    expect(none.status).toBe(400);
    expect((await s.log.list("person-a", "d1")).length).toBe(1);
  });

  it("rejects malformed updates without storing anything", async () => {
    const s = await setup();
    for (const bad of [{ reason: "edit" }, { draftId: "d", reason: "" }, { draftId: "d", reason: "e", baseRev: 0 }, { draftId: "d", reason: "e", resolves: [1] }, { draftId: "d", reason: "e", baseRev: 1.5 }, { draftId: "d", reason: "e", baseRev: 3_000_000_000 }, { draftId: "d", reason: "e", payload: { t: "a\u0000b" } }, { draftId: "d", reason: "e", payload: "\ud800" }, { draftId: "d\ud800", reason: "e" }, { draftId: "d", reason: "e", payload: "x".repeat(300_000) }]) {
      const r = await send(s, "u-bad-0001", bad as unknown as NewDraftUpdate);
      expect(r.status).toBe(400);
    }
    expect((await s.log.list("person-a", "d")).length).toBe(0);
  });

  it("memory and Postgres store the same shape, without unknown fields", async () => {
    const s = await setup();
    await send(s, "u-0000001", { draftId: "d1", reason: "edit", baseRev: null, resolves: [], extra: "x" } as NewDraftUpdate);
    expect((await s.log.list("person-a", "d1"))[0]).toEqual({ id: "u-0000001", draftId: "d1", rev: 1, reason: "edit" });
  });

  it("keeps two people's drafts apart", async () => {
    const s = await setup();
    await send(s, "u-0000001", { draftId: "d1", reason: "edit", payload: "mine" }, "person-a");
    await send(s, "u-0000001", { draftId: "d1", reason: "edit", payload: "theirs" }, "person-b");
    expect((await s.log.list("person-a", "d1"))[0]?.payload).toBe("mine");
    expect((await s.log.list("person-b", "d1"))[0]?.payload).toBe("theirs");
  });

  it("many concurrent edits from one base: all kept, distinct revisions, none twice", async () => {
    const s = await setup();
    await send(s, "u-0000001", { draftId: "d1", reason: "edit" });
    const keys = Array.from({ length: 12 }, (_, i) => `u-conc-${String(i).padStart(3, "0")}`);
    // each key sent twice at once, as a retry racing the first try
    await Promise.all(keys.flatMap((k) => [0, 1].map(() => acceptDraftUpdate({ ...s, owner: "person-a", headers: { "Idempotency-Key": k }, update: { draftId: "d1", reason: "edit", baseRev: 1, payload: k }, waitMs: 5000 }))));
    const log = await s.log.list("person-a", "d1");
    expect(log.length).toBe(13);
    expect(new Set(log.map((u) => u.rev)).size).toBe(13);
    const st = await readDraftState(s.log, "person-a", "d1");
    expect(st.heads.length).toBe(12);
  });

  it("rolls back the update if the claim is lost, so the log never holds an uncompleted write", async () => {
    const s = await setup();
    const failing = { ...s.log, append: async (tx: unknown, o: string, u: never) => { await s.log.append(tx, o, u); throw new Error("boom"); } } as unknown as DraftLog<any>;
    await expect(acceptDraftUpdate({ store: s.store, log: failing, owner: "person-a", headers: { "Idempotency-Key": "u-0000009" }, update: { draftId: "d1", reason: "edit" }, waitMs: 0 })).rejects.toThrow("boom");
    expect((await s.log.list("person-a", "d1")).length).toBe(0);
    // the key is free again, so the retry works
    expect((await send(s, "u-0000009", { draftId: "d1", reason: "edit" })).status).toBe(201);
  });

  it("the log itself ignores a repeated update id", async () => {
    const s = await setup();
    const add = () => s.store.transaction((tx) => s.log.append(tx, "person-a", { id: "u-0000001", draftId: "d1", reason: "edit" }));
    const [a, b] = [await add(), await add()];
    expect(b.rev).toBe(a.rev);
    expect((await s.log.list("person-a", "d1")).length).toBe(1);
  });
});

describe("draft update limits (audit)", () => {
  it("counts the payload in bytes, not characters", () => {
    const base = { draftId: "d", reason: "edit" };
    expect(checkDraftUpdate({ ...base, payload: { t: "€".repeat(100_000) } })).toMatch(/bytes/);
    expect(checkDraftUpdate({ ...base, payload: { t: "a".repeat(100_000) } })).toBeNull();
  });
  it("refuses a writtenAt no date can show", () => {
    expect(checkDraftUpdate({ draftId: "d", reason: "edit", writtenAt: Number.MAX_SAFE_INTEGER })).toMatch(/epoch/);
  });
});
