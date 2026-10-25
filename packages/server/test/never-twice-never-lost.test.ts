/**
 * NEVER TWICE, NEVER LOST.
 *
 * End to end: the real client (Outbox from @holdsend/core) talks to the real
 * server flow (handleIdempotent from @holdsend/server) over a simulated
 * network that misbehaves. fast-check generates random histories:
 *
 *   - people writing, cancelling, and several senders flushing, alone or at
 *     the same time (double taps, two tabs);
 *   - requests lost before the server, answers lost after it did the work,
 *     the network delivering a request twice, the server failing with a 500
 *     before or during the write;
 *   - a sender crashing mid-send (its claim is left behind and must go stale);
 *   - device clocks ahead of or behind the server;
 *   - time passing.
 *
 * After every history, the network becomes reliable, enough time passes for
 * dead claims to expire, people press "Try again" on anything stuck, and the
 * outbox is flushed until empty. Then:
 *
 *   1. every item that was not cancelled exists on the server EXACTLY once;
 *   2. every cancelled item exists ZERO times;
 *   3. nothing exists on the server that no one wrote;
 *   4. a stored written time is never after arrival and is the time the
 *      person wrote it, or arrival when the device clock ran ahead.
 *
 * Run it with more cases:  HOLDSEND_RUNS=2000 npx vitest run never-twice
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { MemoryStore, Outbox, classifyResponse, type AttemptOutcome, type OutboxItem, type Store } from "@holdsend/core";
import { MemoryIdempotencyStore, handleIdempotent, type MemoryTx } from "../src/index.js";

type Payload = { text: string };
type Fate = "ok" | "drop_request" | "drop_response" | "duplicate" | "server_error" | "write_fails" | "crash";

const FATES: Fate[] = ["ok", "drop_request", "drop_response", "duplicate", "server_error", "write_fails", "crash"];
const MIN = 60 * 1000;

type Step =
  | { kind: "add"; text: string; clockSkewMs: number }
  /** The app tries a live send first, then queues it under the same key (its answer may have been lost). */
  | { kind: "add_after_live_attempt"; text: string }
  | { kind: "cancel"; index: number }
  | { kind: "flush"; sender: number }
  | { kind: "flush_together"; senders: number }
  | { kind: "advance"; ms: number };

const stepArb: fc.Arbitrary<Step> = fc.oneof(
  { weight: 4, arbitrary: fc.record({ kind: fc.constant("add" as const), text: fc.string({ minLength: 1, maxLength: 12 }), clockSkewMs: fc.integer({ min: -2 * 60 * MIN, max: 90 * 1000 }) }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant("add_after_live_attempt" as const), text: fc.string({ minLength: 1, maxLength: 12 }) }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("cancel" as const), index: fc.nat(30) }) },
  { weight: 3, arbitrary: fc.record({ kind: fc.constant("flush" as const), sender: fc.nat(2) }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant("flush_together" as const), senders: fc.integer({ min: 2, max: 3 }) }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant("advance" as const), ms: fc.integer({ min: 0, max: 4 * MIN }) }) },
);

interface Created {
  key: string;
  text: string;
  writtenAt: number | null;
  arrivedAt: number;
}

async function runHistory(steps: Step[], fates: Fate[], makeStore: () => Store<Payload>): Promise<void> {
  let clock = Date.parse("2026-10-25T12:00:00.000Z");
  const now = () => clock;

  // ---- server -------------------------------------------------------------
  const idem = new MemoryIdempotencyStore({ now });
  const created: Created[] = [];
  let failNextWrite = false;
  const serve = async (headers: Record<string, string>, body: Payload) => {
    const arrivedAt = clock;
    // This request's write, kept only if its transaction commits ("created").
    let mine: Created | null = null;
    const answer = await handleIdempotent<MemoryTx>({
      store: idem,
      owner: "person-a",
      operation: "post.create",
      headers,
      content: body,
      now,
      waitMs: 0,
      create: async (_tx, ctx) => {
        if (failNextWrite) {
          failNextWrite = false;
          throw new Error("database write failed");
        }
        mine = { key: ctx.key ?? "", text: body.text, writtenAt: ctx.writtenAt, arrivedAt };
        return { status: 201, body: { id: `post-${created.length + 1}` } };
      },
    }).catch(() => ({ status: 500, body: { code: "internal" }, headers: {}, outcome: "error" as const }));
    if (answer.outcome === "created" && mine) created.push(mine);
    return answer;
  };

  // ---- network --------------------------------------------------------------
  let fateIndex = 0;
  const nextFate = (): Fate => fates[fateIndex++ % fates.length] ?? "ok";
  let reliable = false;
  /** Per sender: called when that sender's app is killed mid-send. */
  const onCrash = new Map<number, () => void>();

  const send = async (sender: number, item: OutboxItem<Payload>, ctx: { headers: Record<string, string> }): Promise<AttemptOutcome> => {
    const fate: Fate = reliable ? "ok" : nextFate();
    switch (fate) {
      case "drop_request":
        throw new Error("Network request failed");
      case "server_error":
        return classifyResponse(500);
      case "crash":
        // The app is killed mid-send: this promise never settles.
        onCrash.get(sender)?.();
        return new Promise<AttemptOutcome>(() => undefined);
      case "write_fails": {
        failNextWrite = true;
        const a = await serve(ctx.headers, item.payload);
        return classifyResponse(a.status, (a.body as { code?: string }).code);
      }
      case "drop_response":
        await serve(ctx.headers, item.payload);
        throw new Error("Network request failed");
      case "duplicate": {
        const [a] = await Promise.all([serve(ctx.headers, item.payload), serve(ctx.headers, item.payload)]);
        return classifyResponse(a.status, (a.body as { code?: string }).code);
      }
      default: {
        const a = await serve(ctx.headers, item.payload);
        return classifyResponse(a.status, (a.body as { code?: string }).code);
      }
    }
  };

  // ---- client ----------------------------------------------------------------
  const store = makeStore();
  const newSender = (index: number) =>
    new Outbox<Payload>({ store, send: (item, ctx) => send(index, item, ctx), now, policy: { claimRenewMs: 0, maxAttempts: 4 } });
  const senders = [newSender(0), newSender(1), newSender(2)];
  const written: { key: string; text: string; writtenAt: number }[] = [];
  const cancelled = new Set<string>();

  /** Runs one sender's flush; if its app is killed mid-send, it is replaced (an app restart). */
  const flushOn = async (index: number) => {
    let killed = false;
    const crash = new Promise<void>((resolve) => {
      onCrash.set(index, () => {
        killed = true;
        resolve();
      });
    });
    await Promise.race([senders[index]!.flush("person-a").catch(() => undefined), crash]);
    onCrash.delete(index);
    if (killed) senders[index] = newSender(index);
  };

  for (const step of steps) {
    switch (step.kind) {
      case "add": {
        const writtenAt = clock - step.clockSkewMs;
        const item = await senders[0]!.add("post.create", { text: step.text }, { owner: "person-a", writtenAt: Math.max(1, writtenAt) });
        written.push({ key: item.key, text: step.text, writtenAt: item.writtenAt });
        break;
      }
      case "add_after_live_attempt": {
        const key = `live-${written.length}-${Math.random().toString(36).slice(2, 10)}`;
        const fakeItem = { key, kind: "post.create", payload: { text: step.text }, writtenAt: clock, state: "waiting" as const, attempts: 0, touched: false };
        // The live attempt meets the network like any other request (it may be created, lost, or both).
        await Promise.race([send(99, fakeItem, { headers: { "Idempotency-Key": key, "Written-At": new Date(clock).toISOString() } }).catch(() => undefined), new Promise((r) => setTimeout(r, 5))]);
        const item = await senders[0]!.add("post.create", { text: step.text }, { owner: "person-a", key, writtenAt: clock });
        written.push({ key: item.key, text: step.text, writtenAt: item.writtenAt });
        break;
      }
      case "cancel": {
        const target = written[step.index % Math.max(1, written.length)];
        if (target && (await senders[0]!.cancel(target.key)) === "cancelled") cancelled.add(target.key);
        break;
      }
      case "flush":
        await flushOn(step.sender % senders.length);
        break;
      case "flush_together":
        await Promise.all(Array.from({ length: step.senders }, (_, i) => flushOn(i)));
        break;
      case "advance":
        clock += step.ms;
        break;
    }
  }

  // ---- recovery: reliable network, dead claims expire, people press Try again ----
  reliable = true;
  clock += 10 * MIN;
  const final = newSender(9);
  for (let round = 0; round < 10; round += 1) {
    for (const entry of await final.list()) if (entry.status === "stuck") await final.retry(entry.item.key);
    await final.flush("person-a");
    if ((await final.list()).length === 0) break;
  }

  // ---- invariants -------------------------------------------------------------
  expect(await final.list()).toEqual([]);
  // A key may change only after a key conflict, which this honest client never causes.
  const byKey = new Map<string, Created[]>();
  for (const c of created) byKey.set(c.key, [...(byKey.get(c.key) ?? []), c]);
  for (const w of written) {
    const copies = byKey.get(w.key) ?? [];
    if (cancelled.has(w.key)) {
      expect(copies, `cancelled item ${w.key} must never be created`).toHaveLength(0);
      continue;
    }
    expect(copies, `item ${w.key} must exist exactly once`).toHaveLength(1);
    const copy = copies[0]!;
    expect(copy.text).toBe(w.text);
    if (copy.writtenAt !== null) {
      expect(copy.writtenAt).toBeLessThanOrEqual(copy.arrivedAt);
      expect(copy.writtenAt).toBe(Math.min(w.writtenAt, copy.arrivedAt));
    }
  }
  expect(created.length, "nothing may exist that no one wrote").toBe(written.length - cancelled.size);
}

const RUNS = Number(process.env.HOLDSEND_RUNS ?? 300);

/** A memory store that yields to the event loop before and after every operation, like real async storage. */
class SlowStore<P> implements Store<P> {
  private readonly inner = new MemoryStore<P>();
  private async pause(): Promise<void> {
    await new Promise((r) => setTimeout(r, Math.random() < 0.5 ? 0 : 1));
  }
  async read() {
    await this.pause();
    const items = await this.inner.read();
    await this.pause();
    return items;
  }
  async update<T>(fn: (items: OutboxItem<P>[]) => T) {
    await this.pause();
    const value = await this.inner.update(fn);
    await this.pause();
    return value;
  }
  isDurable() {
    return this.inner.isDurable();
  }
}

describe("never twice, never lost", () => {
  it("holds for random histories over a memory store", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(stepArb, { minLength: 1, maxLength: 40 }), fc.array(fc.constantFrom(...FATES), { minLength: 1, maxLength: 30 }), async (steps, fates) => {
        await runHistory(steps, fates, () => new MemoryStore<Payload>());
      }),
      { numRuns: RUNS },
    );
  });

  it("holds when storage is slow and senders interleave at every await", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(stepArb, { minLength: 1, maxLength: 30 }), fc.array(fc.constantFrom(...FATES), { minLength: 1, maxLength: 30 }), async (steps, fates) => {
        await runHistory(steps, fates, () => new SlowStore<Payload>());
      }),
      { numRuns: Math.max(50, Math.floor(RUNS / 3)) },
    );
  });

  it("holds when every request is lost or answered twice", async () => {
    const steps: Step[] = [
      { kind: "add", text: "a", clockSkewMs: 0 },
      { kind: "add", text: "b", clockSkewMs: 30 * MIN },
      { kind: "flush_together", senders: 3 },
      { kind: "flush", sender: 1 },
      { kind: "advance", ms: 3 * MIN },
      { kind: "flush", sender: 2 },
    ];
    await runHistory(steps, ["drop_response", "duplicate", "drop_request", "write_fails", "crash", "server_error"], () => new MemoryStore<Payload>());
  });
});
