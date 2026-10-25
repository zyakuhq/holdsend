import { PGlite } from "@electric-sql/pglite";
import { afterAll, describe, expect, it } from "vitest";
import {
  MemoryIdempotencyStore,
  PostgresIdempotencyStore,
  canonicalJson,
  handleIdempotent,
  hashRequest,
  postgresSchema,
  parseIdempotencyKey,
  writtenAtFromRequest,
  type MemoryTx,
  type Queryable,
} from "../src/index.js";

const NOW = Date.parse("2026-10-25T12:00:00.000Z");

function memorySetup() {
  const store = new MemoryIdempotencyStore();
  const created: unknown[] = [];
  const handle = (headers: Record<string, string>, content: unknown, extra: Partial<Parameters<typeof handleIdempotent<MemoryTx>>[0]> = {}) =>
    handleIdempotent<MemoryTx>({
      store,
      owner: "person-a",
      operation: "post.create",
      headers,
      content,
      create: async (_tx, ctx) => {
        created.push({ content, writtenAt: ctx.writtenAt });
        return { status: 201, body: { id: `post-${created.length}` }, resourceRef: `post-${created.length}` };
      },
      waitMs: 0,
      ...extra,
    });
  return { store, created, handle };
}

describe("handleIdempotent", () => {
  it("creates once and replays the original answer for a retry", async () => {
    const { handle, created } = memorySetup();
    const headers = { "Idempotency-Key": "item-key-0001" };
    const first = await handle(headers, { text: "hello" });
    const second = await handle(headers, { text: "hello" });
    expect(first).toMatchObject({ status: 201, body: { id: "post-1" }, outcome: "created" });
    expect(second).toMatchObject({ status: 201, body: { id: "post-1" }, outcome: "replayed", headers: { "Idempotent-Replayed": "true" } });
    expect(created).toHaveLength(1);
  });

  it("treats the same content with keys in a different order as the same request", async () => {
    const { handle, created } = memorySetup();
    const headers = { "idempotency-key": "item-key-0001" };
    await handle(headers, { a: 1, b: 2 });
    const second = await handle(headers, { b: 2, a: 1 });
    expect(second.outcome).toBe("replayed");
    expect(created).toHaveLength(1);
  });

  it("answers 409 key_conflict for a different body under the same key", async () => {
    const { handle } = memorySetup();
    await handle({ "Idempotency-Key": "item-key-0001" }, { text: "hello" });
    const other = await handle({ "Idempotency-Key": "item-key-0001" }, { text: "something else" });
    expect(other).toMatchObject({ status: 409, body: { code: "key_conflict" } });
  });

  it("answers 410 gone after the resource was deleted", async () => {
    const { handle, store } = memorySetup();
    await handle({ "Idempotency-Key": "item-key-0001" }, { text: "hello" });
    await store.transaction((tx) => store.tombstoneResource(tx, "person-a", "post.create", "post-1"));
    expect(await handle({ "Idempotency-Key": "item-key-0001" }, { text: "hello" })).toMatchObject({ status: 410, body: { code: "gone" } });
  });

  it("waits for an in-progress duplicate and then replays its answer", async () => {
    const store = new MemoryIdempotencyStore();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let creates = 0;
    const run = (waitMs: number) =>
      handleIdempotent<MemoryTx>({
        store,
        owner: "person-a",
        operation: "post.create",
        headers: { "Idempotency-Key": "item-key-0001" },
        content: { text: "slow" },
        create: async () => {
          creates += 1;
          await gate;
          return { status: 201, body: { id: "post-1" } };
        },
        waitMs,
        pollMs: 10,
      });
    const slow = run(0);
    await new Promise((r) => setTimeout(r, 20));
    const immediate = await run(0);
    expect(immediate).toMatchObject({ status: 409, body: { code: "in_progress" }, headers: { "Retry-After": "1" } });
    const patient = run(2000);
    setTimeout(release, 50);
    expect(await slow).toMatchObject({ outcome: "created" });
    expect(await patient).toMatchObject({ outcome: "replayed", body: { id: "post-1" } });
    expect(creates).toBe(1);
  });

  it("frees the key when create fails, so the retry can succeed once", async () => {
    const store = new MemoryIdempotencyStore();
    let attempts = 0;
    const run = () =>
      handleIdempotent<MemoryTx>({
        store,
        owner: "person-a",
        operation: "post.create",
        headers: { "Idempotency-Key": "item-key-0001" },
        content: { text: "x" },
        create: async () => {
          attempts += 1;
          if (attempts === 1) throw new Error("database briefly unavailable");
          return { status: 201, body: { id: "post-1" } };
        },
      });
    await expect(run()).rejects.toThrow("database briefly unavailable");
    expect(await run()).toMatchObject({ outcome: "created" });
    expect(await run()).toMatchObject({ outcome: "replayed" });
    expect(attempts).toBe(2);
  });

  it("runs unkeyed requests as before, unless a key is required", async () => {
    const { handle, created } = memorySetup();
    expect((await handle({}, { text: "a" })).outcome).toBe("unkeyed");
    expect((await handle({}, { text: "a" })).outcome).toBe("unkeyed");
    expect(created).toHaveLength(2);
    expect(await handle({}, { text: "a" }, { requireKey: true })).toMatchObject({ status: 400, body: { code: "key_required" } });
  });

  it("rejects a malformed key without touching the store", async () => {
    const { handle, created } = memorySetup();
    expect(await handle({ "Idempotency-Key": "bad key!" }, { text: "a" })).toMatchObject({ status: 400, body: { code: "invalid_key" } });
    expect(created).toHaveLength(0);
  });

  it("passes the written time to create only for keyed requests within bounds", async () => {
    const { handle, created } = memorySetup();
    const written = "2026-10-25T08:15:00.000Z";
    await handle({ "Idempotency-Key": "item-key-0001", "Written-At": written }, { text: "a" }, { now: () => NOW });
    await handle({ "Written-At": written }, { text: "b" }, { now: () => NOW });
    await handle({ "Idempotency-Key": "item-key-0002", "Written-At": "2025-01-01T00:00:00Z" }, { text: "c" }, { now: () => NOW });
    expect(created.map((c) => (c as { writtenAt: number | null }).writtenAt)).toEqual([Date.parse(written), null, null]);
  });
});

describe("header helpers", () => {
  it("read Fetch Headers and Node header objects alike", () => {
    expect(parseIdempotencyKey(new Headers({ "Idempotency-Key": "abc-12345" }))).toEqual({ ok: true, key: "abc-12345" });
    expect(parseIdempotencyKey({ "idempotency-key": ["abc-12345"] })).toEqual({ ok: true, key: "abc-12345" });
    expect(parseIdempotencyKey({})).toEqual({ ok: true, key: null });
    expect(parseIdempotencyKey({ "Idempotency-Key": "short" })).toEqual({ ok: false });
    expect(writtenAtFromRequest({ "Written-At": "2026-10-25T08:15:00Z" }, NOW)).toBeNull();
  });
});

describe("hashing", () => {
  it("is stable across key order and ignores undefined", async () => {
    expect(canonicalJson({ b: 1, a: [1, { d: undefined, c: 2 }] })).toBe('{"a":[1,{"c":2}],"b":1}');
    expect(canonicalJson(JSON.parse('{"__proto__":{"x":1},"a":2}'))).toBe('{"__proto__":{"x":1},"a":2}');
    expect(() => canonicalJson({ m: new Map([["a", 1]]) })).toThrow(/content\.m is a Map/);
    expect(() => canonicalJson({ s: new Set([1]) })).toThrow();
    expect(await hashRequest("op", { m: {} })).not.toBe(await hashRequest("op", { m: { a: 1 } }));
    expect(await hashRequest("op", { a: 1, b: 2 })).toBe(await hashRequest("op", { b: 2, a: 1 }));
    expect(await hashRequest("op", { a: 1 })).not.toBe(await hashRequest("other", { a: 1 }));
  });
});

describe("handleIdempotent on Postgres", () => {
  const db = new PGlite();
  afterAll(async () => {
    await db.close();
  });

  it("creates exactly one row when the same request arrives many times at once", async () => {
    await db.exec(postgresSchema());
    await db.exec("CREATE TABLE posts (id SERIAL PRIMARY KEY, body TEXT NOT NULL, written_at TIMESTAMPTZ)");
    const store = new PostgresIdempotencyStore({ db, transaction: (fn) => db.transaction((tx) => fn(tx as unknown as Queryable)) });
    const run = () =>
      handleIdempotent<Queryable>({
        store,
        owner: "person-a",
        operation: "post.create",
        headers: { "Idempotency-Key": "item-key-0001", "Written-At": new Date(Date.now() - 60_000).toISOString() },
        content: { text: "flood update" },
        create: async (tx, ctx) => {
          const r = await tx.query("INSERT INTO posts (body, written_at) VALUES ($1, $2) RETURNING id", [
            "flood update",
            ctx.writtenAt === null ? null : new Date(ctx.writtenAt),
          ]);
          const id = String((r.rows[0] as { id: number }).id);
          return { status: 201, body: { id }, resourceRef: id };
        },
        waitMs: 5000,
        pollMs: 10,
      });
    const answers = await Promise.all(Array.from({ length: 30 }, run));
    const rows = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM posts");
    expect(rows.rows[0]?.n).toBe(1);
    expect(answers.filter((a) => a.outcome === "created")).toHaveLength(1);
    expect(answers.every((a) => a.status === 201 && (a.body as { id: string }).id === "1")).toBe(true);
    const written = await db.query<{ written_at: Date | null }>("SELECT written_at FROM posts");
    expect(written.rows[0]?.written_at).not.toBeNull();
  });
});
