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
  /**
   * The id of the update this one was written on top of. Preferred over `baseRev`
   * when set: a device's own second offline edit names its first edit, so the two
   * are one line, not a conflict.
   */
  baseId?: string | null;
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

type Index<T> = { byId: Map<string, DraftUpdate<T>>; byRev: Map<number, DraftUpdate<T>>; repeats: number };

/** Same-draft updates, ordered by revision then id (so input order never matters), repeats of an id dropped. */
function index<T>(log: Iterable<DraftUpdate<T>>, draftId?: string): Index<T> {
  const all = [...log].filter((u) => draftId === undefined || u.draftId === draftId);
  all.sort((a, b) => a.rev - b.rev || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
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
  return { byId, byRev, repeats };
}

/** The parents of an update that exist and arrived earlier, plus the references that do not qualify. */
function parentsOf<T>(u: DraftUpdate<T>, ix: Index<T>): { ok: DraftUpdate<T>[]; bad: string[] } {
  const refs: [string, DraftUpdate<T> | undefined][] = [];
  if (u.baseId != null) refs.push([u.baseId, ix.byId.get(u.baseId)]);
  else if (u.baseRev != null) refs.push([`rev ${u.baseRev}`, ix.byRev.get(u.baseRev)]);
  for (const id of u.resolves ?? []) refs.push([id, ix.byId.get(id)]);
  const ok: DraftUpdate<T>[] = [];
  const bad: string[] = [];
  // A parent must be a different update that arrived earlier, so no cycle can form.
  for (const [ref, p] of refs) {
    if (p && p.rev < u.rev) ok.push(p);
    else bad.push(ref);
  }
  return { ok, bad };
}

/**
 * Reads a draft's log. Updates for other drafts are ignored when `draftId` is
 * given. Order of the input does not matter. A repeated id keeps the one that
 * arrived first. Updates with the same revision are ordered by id.
 */
export function readDraft<T = unknown>(log: Iterable<DraftUpdate<T>>, draftId?: string): DraftState<T> {
  const ix = index(log, draftId);
  const hasChild = new Set<string>();
  const dangling: { id: string; ref: string }[] = [];
  for (const u of ix.byId.values()) {
    const { ok, bad } = parentsOf(u, ix);
    for (const p of ok) hasChild.add(p.id);
    for (const ref of bad) dangling.push({ id: u.id, ref });
  }
  const heads = [...ix.byId.values()].filter((u) => !hasChild.has(u.id));
  const conflicted = heads.length > 1;
  return {
    conflicted,
    heads,
    latest: heads.length ? heads[heads.length - 1]! : null,
    unresolved: conflicted ? heads : [],
    count: ix.byId.size,
    repeats: ix.repeats,
    dangling,
  };
}

/**
 * Every update that leads to `head` through parents, itself included, by the
 * same rules as `readDraft`. Pass `draftId` when the log holds several drafts.
 */
export function ancestorsOf<T = unknown>(log: Iterable<DraftUpdate<T>>, head: string, draftId?: string): DraftUpdate<T>[] {
  const ix = index(log, draftId);
  const seen = new Set<string>();
  const stack = [ix.byId.get(head)];
  while (stack.length) {
    const u = stack.pop();
    if (!u || seen.has(u.id)) continue;
    seen.add(u.id);
    stack.push(...parentsOf(u, ix).ok);
  }
  return [...seen].map((id) => ix.byId.get(id)!).sort((a, b) => a.rev - b.rev || (a.id < b.id ? -1 : 1));
}
