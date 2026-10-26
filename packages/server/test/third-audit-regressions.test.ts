/**
 * Regression tests for the server findings of the third audit (2026-10-26).
 * Each failed on the code before its fix.
 */
import { PGlite } from "@electric-sql/pglite";
import { afterAll, describe, expect, it } from "vitest";
import {
  MemoryIdempotencyStore,
  PostgresIdempotencyStore,
  handleIdempotent,
  postgresSchema,
  type IdempotencyStore,
  type Queryable,
} from "../src/index.js";

const lite = new PGlite();
afterAll(async () => {
  await lite.close();
});

async function stores(): Promise<[string, IdempotencyStore<unknown>][]> {
  await lite.exec(postgresSchema("audit3_records"));
  await lite.exec("DELETE FROM audit3_records");
  const pg = new PostgresIdempotencyStore({
    db: lite,
    table: "audit3_records",
    transaction: (fn) => lite.transaction((tx) => fn(tx as unknown as Queryable)),
  });
  return [
    ["memory", new MemoryIdempotencyStore() as IdempotencyStore<unknown>],
    ["postgres", pg as IdempotencyStore<unknown>],
  ];
}

const headers = { "Idempotency-Key": "audit3-key-0001" };

describe("A1: a failed create is not replayed", () => {
  it("answers a 503 without storing it, so the retry runs create again and can succeed", async () => {
    for (const [name, store] of await stores()) {
      let calls = 0;
      const run = () =>
        handleIdempotent({
          store,
          owner: "person-a",
          operation: "post.create",
          headers,
          content: { text: "a" },
          waitMs: 0,
          create: async () => {
            calls += 1;
            return calls === 1 ? { status: 503, body: { code: "busy" } } : { status: 201, body: { id: "1" } };
          },
        });
      const first = await run();
      expect(first, name).toMatchObject({ status: 503, outcome: "not_stored" });
      const second = await run();
      expect(second, name).toMatchObject({ status: 201, outcome: "created" });
      expect(calls, name).toBe(2);
      expect(await run(), name).toMatchObject({ status: 201, outcome: "replayed" });
    }
  });

  it("rolls back what a failed create wrote", async () => {
    await lite.exec("CREATE TABLE IF NOT EXISTS audit3_posts (id SERIAL PRIMARY KEY, body TEXT)");
    const store = (await stores())[1]![1];
    const answer = await handleIdempotent<Queryable>({
      store: store as IdempotencyStore<Queryable>,
      owner: "person-a",
      operation: "post.create",
      headers: { "Idempotency-Key": "audit3-key-0002" },
      content: { text: "b" },
      waitMs: 0,
      create: async (tx) => {
        await tx.query("INSERT INTO audit3_posts (body) VALUES ('should not stay')");
        return { status: 422, body: { code: "invalid" } };
      },
    });
    expect(answer.outcome).toBe("not_stored");
    const { rows } = await lite.query("SELECT count(*)::int AS n FROM audit3_posts WHERE body = 'should not stay'");
    expect((rows[0] as { n: number }).n).toBe(0);
  });
});

describe("A4: replays carry the original response headers", () => {
  it("stores headers such as Location and sends them again", async () => {
    for (const [name, store] of await stores()) {
      const run = () =>
        handleIdempotent({
          store,
          owner: "person-a",
          operation: "post.create",
          headers,
          content: { text: "c" },
          waitMs: 0,
          create: async () => ({ status: 201, body: { id: "7" }, headers: { Location: "/posts/7" } }),
        });
      expect((await run()).headers, name).toEqual({ Location: "/posts/7" });
      expect((await run()).headers, name).toEqual({ Location: "/posts/7", "Idempotent-Replayed": "true" });
    }
  });
});

describe("A7: content the server cannot fingerprint", () => {
  it("is a 400, not a crash, even when nested very deeply", async () => {
    const deep = JSON.parse(`${"[".repeat(20_000)}${"]".repeat(20_000)}`) as unknown;
    const answer = await handleIdempotent({
      store: new MemoryIdempotencyStore(),
      owner: "person-a",
      operation: "post.create",
      headers,
      content: deep,
      create: async () => ({ status: 201, body: null }),
    });
    expect(answer).toMatchObject({ status: 400, outcome: "invalid_content" });
  });

  it("treats a missing body like null instead of failing", async () => {
    const answer = await handleIdempotent({
      store: new MemoryIdempotencyStore(),
      owner: "person-a",
      operation: "post.create",
      headers,
      content: undefined,
      create: async () => ({ status: 201, body: null }),
    });
    expect(answer.status).toBe(201);
  });
});

describe("A9: wait options are checked", () => {
  it("refuses a pollMs that is not a number instead of busy-looping", async () => {
    await expect(
      handleIdempotent({
        store: new MemoryIdempotencyStore(),
        owner: "person-a",
        operation: "post.create",
        headers,
        content: {},
        pollMs: Number.NaN,
        create: async () => ({ status: 201, body: null }),
      }),
    ).rejects.toBeInstanceOf(RangeError);
  });
});
