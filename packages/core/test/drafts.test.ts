import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { ancestorsOf, readDraft, type DraftUpdate } from "../src/drafts.js";

const D = "d1";
let n = 0;
const u = (rev: number, baseRev: number | null, extra: Partial<DraftUpdate<string>> = {}): DraftUpdate<string> => ({
  id: `u${rev}-${n++}`,
  draftId: D,
  rev,
  baseRev,
  reason: "edit",
  payload: `text ${rev}`,
  ...extra,
});

describe("readDraft scenarios", () => {
  it("an empty log has no head and no conflict", () => {
    const s = readDraft([], D);
    expect(s.heads).toEqual([]);
    expect(s.latest).toBeNull();
    expect(s.conflicted).toBe(false);
  });

  it("a straight line of edits has one head", () => {
    const a = u(1, null);
    const b = u(2, 1);
    const c = u(3, 2);
    const s = readDraft([c, a, b], D);
    expect(s.heads.map((h) => h.id)).toEqual([c.id]);
    expect(s.conflicted).toBe(false);
    expect(s.unresolved).toEqual([]);
  });

  it("two edits on the same base are two heads, and both are kept", () => {
    const a = u(1, null);
    const phone = u(2, 1);
    const laptop = u(3, 1);
    const s = readDraft([a, phone, laptop], D);
    expect(s.conflicted).toBe(true);
    expect(s.unresolved.map((h) => h.id)).toEqual([phone.id, laptop.id]);
    expect(s.latest?.id).toBe(laptop.id);
  });

  it("a resolving update that names every head closes the conflict", () => {
    const a = u(1, null);
    const phone = u(2, 1);
    const laptop = u(3, 1);
    const fix = u(4, 3, { reason: "resolve", resolves: [phone.id, laptop.id] });
    const s = readDraft([a, phone, laptop, fix], D);
    expect(s.conflicted).toBe(false);
    expect(s.heads.map((h) => h.id)).toEqual([fix.id]);
  });

  it("a resolve that names only some heads leaves the others open", () => {
    const a = u(1, null);
    const x = u(2, 1);
    const y = u(3, 1);
    const z = u(4, 1);
    const fix = u(5, 4, { reason: "resolve", resolves: [x.id] });
    const s = readDraft([a, x, y, z, fix], D);
    expect(s.heads.map((h) => h.id)).toEqual([y.id, fix.id]);
    expect(s.conflicted).toBe(true);
  });

  it("an edit made after seeing the conflict, but not resolving it, does not hide the other head", () => {
    const a = u(1, null);
    const x = u(2, 1);
    const y = u(3, 1);
    const more = u(4, 3);
    const s = readDraft([a, x, y, more], D);
    expect(s.heads.map((h) => h.id)).toEqual([x.id, more.id]);
  });

  it("two devices starting the same draft are a conflict, not a loss", () => {
    const s = readDraft([u(1, null), u(2, null)], D);
    expect(s.conflicted).toBe(true);
  });

  it("a retried update (same id) counts once", () => {
    const a = u(1, null);
    const s = readDraft([a, { ...a, rev: 2 }, a], D);
    expect(s.count).toBe(1);
    expect(s.repeats).toBe(2);
    expect(s.conflicted).toBe(false);
  });

  it("a delete edit next to a normal edit keeps the draft alive as a conflict", () => {
    const a = u(1, null);
    const del = u(2, 1, { reason: "delete" });
    const edit = u(3, 1);
    const s = readDraft([a, del, edit], D);
    expect(s.unresolved.map((h) => h.reason).sort()).toEqual(["delete", "edit"]);
  });

  it("unknown or impossible references are reported and never throw or form a cycle", () => {
    const a = u(1, 99);
    const b = u(2, 5);
    const c = u(3, 3);
    const d = u(4, 1, { resolves: ["nope"] });
    const s = readDraft([a, b, c, d], D);
    expect(s.dangling.length).toBe(4);
    expect(s.heads.length).toBeGreaterThan(0);
  });

  it("ignores other drafts and the order of the input", () => {
    const a = u(1, null);
    const b = u(2, 1);
    const other = { ...u(3, null), draftId: "d2" };
    expect(readDraft([other, b, a], D).heads.map((h) => h.id)).toEqual([b.id]);
    expect(readDraft([b, other, a], D)).toEqual(readDraft([a, b, other], D));
  });

  it("written time never changes the outcome", () => {
    const a = u(1, null);
    const x = u(2, 1, { writtenAt: 9_000 });
    const y = u(3, 1, { writtenAt: 1_000 });
    const s = readDraft([a, x, y], D);
    expect(s.latest?.id).toBe(y.id);
    expect(s.heads.map((h) => h.id)).toEqual([x.id, y.id]);
  });
});

// ---- fault-injection suite: devices, offline periods, lost answers, retries ----

type Sim = { log: DraftUpdate<string>[]; accepted: string[] };

/** A tiny server and a few devices. Every step is an action; the check is at the end. */
const action = fc.oneof(
  fc.record({ t: fc.constant("edit" as const), dev: fc.nat(2) }),
  fc.record({ t: fc.constant("sync" as const), dev: fc.nat(2), lose: fc.boolean() }),
  fc.record({ t: fc.constant("retry" as const), dev: fc.nat(2) }),
  fc.record({ t: fc.constant("resolve" as const), dev: fc.nat(2) }),
);

function simulate(acts: { t: string; dev: number; lose?: boolean }[]): Sim {
  const server: DraftUpdate<string>[] = [];
  const devs = [0, 1, 2].map(() => ({ seen: null as number | null, queue: [] as DraftUpdate<string>[], sent: [] as DraftUpdate<string>[], seenLog: [] as DraftUpdate<string>[] }));
  let id = 0;
  const accepted: string[] = [];
  const receive = (up: DraftUpdate<string>) => {
    // The server accepts every update once per id and gives the arrival revision.
    if (server.some((s) => s.id === up.id)) return;
    server.push({ ...up, rev: server.length + 1 });
    accepted.push(up.id);
  };
  for (const a of acts) {
    const d = devs[a.dev]!;
    if (a.t === "edit") {
      d.queue.push({ id: `w${id++}`, draftId: D, rev: 0, baseRev: d.seen, reason: "edit", payload: "x" });
    } else if (a.t === "retry") {
      for (const q of d.sent) receive(q);
    } else if (a.t === "sync") {
      for (const q of d.queue.splice(0)) {
        d.sent.push(q);
        receive(q);
        if (!a.lose) d.seen = server.length;
      }
      if (!a.lose) {
        d.seen = server.length || null;
        d.seenLog = [...server];
      }
    } else if (a.t === "resolve") {
      const s = readDraft(d.seenLog, D);
      if (s.conflicted) {
        const q: DraftUpdate<string> = { id: `w${id++}`, draftId: D, rev: 0, baseRev: s.latest!.rev, reason: "resolve", resolves: s.heads.map((h) => h.id), payload: "merged by a person" };
        d.sent.push(q);
        receive(q);
      }
    }
  }
  return { log: server, accepted };
}

/** Is `id` an ancestor of (or equal to) one of the heads? */
const reachable = (log: DraftUpdate<string>[], heads: DraftUpdate<string>[], id: string) =>
  heads.some((h) => ancestorsOf(log, h.id).some((x) => x.id === id));

describe("no edit is silently lost (fault injection)", () => {
  const run = (read: typeof readDraft<string>) =>
    fc.assert(
      fc.property(fc.array(action, { maxLength: 40 }), (acts) => {
        const { log, accepted } = simulate(acts);
        const s = read(log, D);
        // Every accepted edit appears once, and is reachable from a head.
        expect(s.count).toBe(accepted.length);
        for (const id of accepted) expect(reachable(log, s.heads, id)).toBe(true);
        // Two heads never hide each other.
        for (const h of s.heads) for (const g of s.heads) if (h !== g) expect(ancestorsOf(log, g.id).some((x) => x.id === h.id)).toBe(false);
        // A retry never adds a second copy.
        expect(new Set(log.map((x) => x.id)).size).toBe(log.length);
      }),
      { numRuns: Number(process.env.HOLDSEND_RUNS ?? 300) },
    );

  it("holds for the real readDraft", () => run(readDraft));

  it("fails for last-writer-wins", () => {
    const lww: typeof readDraft<string> = (log, draftId) => {
      const s = readDraft(log, draftId);
      return { ...s, heads: s.latest ? [s.latest] : [], conflicted: false, unresolved: [] };
    };
    expect(() => run(lww)).toThrow();
  });

  it("fails for a reader that counts a retry twice", () => {
    const dup: typeof readDraft<string> = (log, draftId) => {
      const s = readDraft(log, draftId);
      return { ...s, count: s.count + 1 };
    };
    expect(() => run(dup)).toThrow();
  });

  it("fails for a reader that treats a stale base as nothing (drops the edit)", () => {
    const refuse: typeof readDraft<string> = (log, draftId) => {
      const all = [...log];
      const s = readDraft(all.filter((x) => x.baseRev == null || all.some((y) => y.rev === x.baseRev && y.rev === all.length)), draftId);
      return s;
    };
    expect(() => run(refuse)).toThrow();
  });
});
