/**
 * One draft edited on two devices: a pure function from the update log to the
 * draft's heads. It never merges text and never picks a winner. See
 * docs/decisions/0009-two-device-drafts.md.
 *
 *   import { readDraft } from "@holdsend/core/drafts";
 *
 * Every update stays in the log. An update has parents: the revision it was
 * based on (`baseRev`) and any updates it resolves. A head is an update that
 * no other update has as a parent. One head means no conflict. Two or more
 * heads mean two edits share an ancestor and a person has to settle them.
 */

/** One accepted edit, as the server stores it. */
export interface DraftUpdate<T = unknown> {
  /** Unique id of this update. It is also the outbox key, so a retry is the same update. */
  id: string;
  draftId: string;
  /** Revision number the server gave it on arrival (not a device clock). Higher means it arrived later. */
  rev: number;
  /** The revision the device had seen when it wrote this, or null/undefined for a new draft. */
  baseRev?: number | null;
  /** A short label set by the app: "edit", "resolve", "restore", "delete" and so on. */
  reason: string;
  /** For a resolving update: the ids of the updates it settles. */
  resolves?: readonly string[];
  /** When the person wrote it. Shown to help a person choose; never used to order or decide. */
  writtenAt?: number;
  payload?: T;
}

export interface DraftState<T = unknown> {
  /** True when more than one head is open. */
  conflicted: boolean;
  /** The open heads, lowest revision first. One entry when not conflicted, none for an empty log. */
  heads: DraftUpdate<T>[];
  /** The head with the highest revision. Show it by default, but only a person closes a conflict. */
  latest: DraftUpdate<T> | null;
  /** The heads to show side by side: all of them when conflicted, none otherwise. */
  unresolved: DraftUpdate<T>[];
  /** Updates read, after dropping repeats of an id. */
  count: number;
  /** Updates dropped because an earlier one had the same id (a retry). */
  repeats: number;
  /** References that point nowhere usable: an unknown, or not earlier, base or resolved id. Kept out of the graph, never an error. */
  dangling: { id: string; ref: string }[];
}

/**
 * Reads a draft's log. Updates for other drafts are ignored. Order of the
 * input does not matter. A repeated id keeps the one that arrived first.
 */
export function readDraft<T = unknown>(log: Iterable<DraftUpdate<T>>, draftId?: string): DraftState<T> {
  const all = [...log].filter((u) => draftId === undefined || u.draftId === draftId);
  all.sort((a, b) => a.rev - b.rev);
  const byId = new Map<string, DraftUpdate<T>>();
  const byRev = new Map<number, DraftUpdate<T>>();
  let repeats = 0;
  for (const u of all) {
    if (byId.has(u.id)) {
      repeats++;
      continue;
    }
    byId.set(u.id, u);
    if (!byRev.has(u.rev)) byRev.set(u.rev, u);
  }
  const hasChild = new Set<string>();
  const dangling: { id: string; ref: string }[] = [];
  for (const u of byId.values()) {
    // A parent must be a different update that arrived earlier, so no cycle can form.
    const parents: [string, DraftUpdate<T> | undefined][] = [];
    if (u.baseRev !== undefined && u.baseRev !== null) parents.push([`rev ${u.baseRev}`, byRev.get(u.baseRev)]);
    for (const id of u.resolves ?? []) parents.push([id, byId.get(id)]);
    for (const [ref, p] of parents) {
      if (p && p.rev < u.rev) hasChild.add(p.id);
      else dangling.push({ id: u.id, ref });
    }
  }
  const heads = [...byId.values()].filter((u) => !hasChild.has(u.id));
  const conflicted = heads.length > 1;
  return {
    conflicted,
    heads,
    latest: heads.length ? heads[heads.length - 1]! : null,
    unresolved: conflicted ? heads : [],
    count: byId.size,
    repeats,
    dangling,
  };
}

/**
 * Every update that leads to `head` through parents, itself included. A person
 * resolving a conflict can use this to show history. Pure and bounded by the log.
 */
export function ancestorsOf<T = unknown>(log: Iterable<DraftUpdate<T>>, head: string): DraftUpdate<T>[] {
  const all = [...log];
  const byId = new Map<string, DraftUpdate<T>>();
  const byRev = new Map<number, DraftUpdate<T>>();
  for (const u of all.sort((a, b) => a.rev - b.rev)) {
    if (!byId.has(u.id)) byId.set(u.id, u);
    if (!byRev.has(u.rev)) byRev.set(u.rev, byId.get(u.id)!);
  }
  const seen = new Set<string>();
  const out: DraftUpdate<T>[] = [];
  const stack = [byId.get(head)];
  while (stack.length) {
    const u = stack.pop();
    if (!u || seen.has(u.id)) continue;
    seen.add(u.id);
    out.push(u);
    if (u.baseRev !== undefined && u.baseRev !== null) {
      const p = byRev.get(u.baseRev);
      if (p && p.rev < u.rev) stack.push(p);
    }
    for (const id of u.resolves ?? []) {
      const p = byId.get(id);
      if (p && p.rev < u.rev) stack.push(p);
    }
  }
  return out.sort((a, b) => a.rev - b.rev);
}
