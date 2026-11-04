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
    // a (rev 1, bad base), b (rev 2, base rev 5 is later) and c (rev 3, base is itself) are loose;
    // d (rev 4) rests on a.
    expect(s.heads.map((h) => h.id).sort()).toEqual([b.id, c.id, d.id].sort());
  });

  it("a device's own second offline edit, naming the first by id, is one line not a conflict", () => {
    const a = u(1, null);
    const e1 = u(2, 1);
    const e2 = u(3, 1, { baseId: e1.id });
    expect(readDraft([a, e1, e2], D).heads.map((h) => h.id)).toEqual([e2.id]);
  });

  it("equal revisions are ordered by id, whatever the input order", () => {
    const a = u(1, null, { id: "a" });
    const x = u(2, 1, { id: "x" });
    const y = u(2, 1, { id: "y" });
    const c = u(3, 2, { id: "c" });
    const one = readDraft([a, x, y, c], D);
    const two = readDraft([a, y, x, c], D);
    expect(two).toEqual(one);
    expect(ancestorsOf([a, y, x, c], "c")).toEqual(ancestorsOf([a, x, y, c], "c"));
  });

  it("ancestorsOf follows readDraft when an id repeats at another revision", () => {
    const a = u(1, null);
    const again = { ...a, rev: 2 };
    const b = u(3, 2);
    const log = [a, again, b];
    const s = readDraft(log, D);
    expect(s.dangling.length).toBe(1);
    expect(s.heads.map((h) => h.id)).toEqual([a.id, b.id]);
    expect(ancestorsOf(log, b.id).map((x) => x.id)).toEqual([b.id]);
  });

  it("ancestorsOf can be limited to one draft", () => {
    const a = u(1, null);
    const other = { ...u(2, 1), draftId: "d2" };
    expect(ancestorsOf([a, other], other.id, D)).toEqual([]);
  });

  it("mutual resolves cannot make a cycle", () => {
    const a = u(1, null);
    const x = u(2, 1, { id: "x", resolves: ["y"] });
    const y = u(3, 1, { id: "y", resolves: ["x"] });
    const s = readDraft([a, x, y], D);
    expect(s.heads.map((h) => h.id)).toEqual(["y"]);
    expect(s.dangling).toEqual([{ id: "x", ref: "y" }]);
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

type Act = { t: string; dev: number; lose?: boolean };
type Sim = { log: DraftUpdate<string>[]; ids: string[]; parents: Map<string, string[]>; resolves: number; conflicts: number };

const action = fc.oneof(
  fc.record({ t: fc.constant("edit"), dev: fc.nat(2) }),
  fc.record({ t: fc.constant("sync"), dev: fc.nat(2), lose: fc.boolean() }),
  fc.record({ t: fc.constant("retry"), dev: fc.nat(2) }),
  fc.record({ t: fc.constant("resolve"), dev: fc.nat(2) }),
);

/**
 * Three devices and a server. The server appends every arrival, retries too
 * (it does not de-duplicate; the reader must). The simulation records each
 * update's true parents itself, so the check does not depend on the code under test.
 */
function simulate(acts: Act[]): Sim {
  const log: DraftUpdate<string>[] = [];
  const first = new Map<string, DraftUpdate<string>>();
  const parents = new Map<string, string[]>();
  const devs = [0, 1, 2].map(() => ({ seenRev: null as number | null, seenIds: [] as string[], queue: [] as DraftUpdate<string>[], sent: [] as DraftUpdate<string>[] }));
  let id = 0;
  let resolves = 0;
  let conflicts = 0;
  const receive = (up: DraftUpdate<string>) => {
    const copy = { ...up, rev: log.length + 1 };
    log.push(copy);
    if (!first.has(up.id)) first.set(up.id, copy);
  };
  const headsNow = () => readDraft(log, D);
  for (const a of acts) {
    const d = devs[a.dev]!;
    if (a.t === "edit") {
      const prev = d.queue[d.queue.length - 1];
      const up: DraftUpdate<string> = { id: `w${id++}`, draftId: D, rev: 0, baseRev: d.seenRev, ...(prev ? { baseId: prev.id } : {}), reason: "edit", payload: "x" };
      parents.set(up.id, prev ? [prev.id] : d.seenRev === null ? [] : [[...first.values()].find((f) => f.rev === d.seenRev)!.id]);
      d.queue.push(up);
    } else if (a.t === "retry") {
      for (const q of d.sent) receive(q);
    } else if (a.t === "sync") {
      for (const q of d.queue.splice(0)) {
        d.sent.push(q);
        receive(q);
      }
      if (!a.lose) {
        const last = [...first.values()].pop();
        d.seenRev = last ? last.rev : null;
        d.seenIds = [...first.keys()];
      }
    } else if (a.t === "resolve") {
      // A person on this device settles the heads this device can see.
      const seen = readDraft(log.filter((x) => d.seenIds.includes(x.id)), D);
      if (seen.conflicted) {
        resolves++;
        const up: DraftUpdate<string> = { id: `w${id++}`, draftId: D, rev: 0, baseRev: seen.latest!.rev, reason: "resolve", resolves: seen.heads.map((h) => h.id), payload: "chosen by a person" };
        parents.set(up.id, [...seen.heads.map((h) => h.id), [...first.values()].find((f) => f.rev === seen.latest!.rev)!.id]);
        d.sent.push(up);
        receive(up);
      }
    }
    if (headsNow().conflicted) conflicts++;
  }
  return { log, ids: [...first.keys()], parents, resolves, conflicts };
}

/** The true heads by the simulation's own record. */
function trueHeads(sim: Sim): string[] {
  const hasChild = new Set(sim.ids.flatMap((x) => sim.parents.get(x) ?? []));
  return sim.ids.filter((x) => !hasChild.has(x)).sort();
}

describe("no edit is silently lost (fault injection)", () => {
  const runs = Number(process.env.HOLDSEND_RUNS ?? 300);
  const run = (read: typeof readDraft<string>) =>
    fc.assert(
      fc.property(fc.array(action, { minLength: 12, maxLength: 40 }), (acts) => {
        const sim = simulate(acts);
        const s = read(sim.log, D);
        // Every accepted edit is counted once, retries do not add copies.
        expect(s.count).toBe(sim.ids.length);
        expect(s.repeats).toBe(sim.log.length - sim.ids.length);
        // The open heads are exactly the true heads: no edit hidden, none invented.
        expect(s.heads.map((h) => h.id).sort()).toEqual(trueHeads(sim));
        expect(s.conflicted).toBe(trueHeads(sim).length > 1);
        // Every edit is reachable from a head.
        for (const id of sim.ids) expect(s.heads.some((h) => ancestorsOf(sim.log, h.id, D).some((x) => x.id === id))).toBe(true);
      }),
      { numRuns: runs },
    );

  it("the generator really reaches conflicts, resolves and retries", () => {
    const sims = fc.sample(fc.array(action, { minLength: 12, maxLength: 40 }), 300).map(simulate);
    expect(sims.filter((x) => x.conflicts > 0).length).toBeGreaterThan(30);
    expect(sims.filter((x) => x.resolves > 0).length).toBeGreaterThan(10);
    expect(sims.filter((x) => x.log.length > x.ids.length).length).toBeGreaterThan(30);
  });

  it("holds for the real readDraft", () => run(readDraft));

  it("fails for last-writer-wins", () => {
    const lww: typeof readDraft<string> = (log, draftId) => {
      const s = readDraft(log, draftId);
      return { ...s, heads: s.latest ? [s.latest] : [], conflicted: false, unresolved: [] };
    };
    expect(() => run(lww)).toThrow();
  });

  it("fails for a reader that counts a retry as a second edit", () => {
    const dup: typeof readDraft<string> = (log, draftId) => {
      const s = readDraft(log, draftId);
      return { ...s, count: s.count + s.repeats, repeats: 0 };
    };
    expect(() => run(dup)).toThrow();
  });

  it("fails for a reader that drops edits written on an older base", () => {
    const refuse: typeof readDraft<string> = (log, draftId) => {
      const all = [...log];
      // Keeps only an update whose base was the newest revision when it arrived.
      return readDraft(all.filter((x) => x.baseRev == null || x.baseRev === x.rev - 1), draftId);
    };
    expect(() => run(refuse)).toThrow();
  });

  it("fails for a reader that lets any update with 'resolves' close heads it did not name", () => {
    const sloppy: typeof readDraft<string> = (log, draftId) => {
      const s = readDraft(log, draftId);
      const resolver = s.heads.find((h) => h.resolves?.length);
      return resolver ? { ...s, heads: [resolver], conflicted: false, unresolved: [] } : s;
    };
    expect(() => run(sloppy)).toThrow();
  });
});
