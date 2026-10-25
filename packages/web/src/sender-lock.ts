/**
 * One sender at a time across the tabs of an origin.
 *
 * Correctness does not depend on this lock: every item is claimed inside an
 * atomic store update, and the server's idempotency key makes any duplicate
 * that still gets through a harmless replay. The lock stops two tabs from
 * sending the same queue at the same moment, so the server sees one request
 * where one belongs.
 *
 *   Web Locks   navigator.locks.request(name, { ifAvailable: true }). The
 *               browser releases the lock when the holder finishes or its tab
 *               closes. A tab that does not get it skips this pass.
 *   Lease       where Web Locks is missing (older Safari): a short lease in
 *               localStorage, renewed while held. localStorage has no
 *               compare-and-set, so the writer waits briefly and proceeds
 *               only if its own lease is the one that stuck.
 *   Single      nothing to coordinate with: runs directly.
 */

export interface LockManagerLike {
  request(name: string, options: { ifAvailable?: boolean; mode?: "exclusive" | "shared" }, callback: (lock: unknown) => Promise<unknown>): Promise<unknown>;
}

export interface SyncStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface SenderLockOptions {
  /** Lock name. Use one per outbox. Default "holdsend-sender". */
  name?: string;
  locks?: LockManagerLike | null;
  storage?: SyncStorageLike | null;
  /** Lease length when falling back to localStorage. Default 15 s. */
  leaseMs?: number;
  /** How often a held lease is renewed. Default 5 s. */
  heartbeatMs?: number;
  /** How long to wait before checking that our lease stuck. Default 50 ms. */
  settleMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export type SenderLockResult<T> =
  | { acquired: true; mode: "web-locks" | "lease" | "single"; value: T }
  | { acquired: false };

type Lease = { owner: string; expiresAt: number };

function randomId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  try {
    if (c?.randomUUID) return c.randomUUID();
  } catch {
    /* fall through */
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function detectLocks(): LockManagerLike | null {
  try {
    const nav = (globalThis as { navigator?: { locks?: LockManagerLike } }).navigator;
    return nav?.locks && typeof nav.locks.request === "function" ? nav.locks : null;
  } catch {
    return null;
  }
}

function detectStorage(): SyncStorageLike | null {
  try {
    const s = (globalThis as { localStorage?: SyncStorageLike }).localStorage;
    return s && typeof s.getItem === "function" ? s : null;
  } catch {
    // Accessing localStorage throws when storage is blocked.
    return null;
  }
}

export class SenderLock {
  private readonly name: string;
  private readonly locks: LockManagerLike | null;
  private readonly storage: SyncStorageLike | null;
  private readonly leaseMs: number;
  private readonly heartbeatMs: number;
  private readonly settleMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  /** Identity of this tab for the lease. */
  readonly owner = randomId();
  /** Not re-entrant, like a Web Lock: a second caller in this tab is refused while the first holds it. */
  private held = false;

  constructor(options: SenderLockOptions = {}) {
    this.name = options.name ?? "holdsend-sender";
    this.locks = options.locks === undefined ? detectLocks() : options.locks;
    this.storage = options.storage === undefined ? detectStorage() : options.storage;
    this.leaseMs = options.leaseMs ?? 15_000;
    this.heartbeatMs = options.heartbeatMs ?? 5_000;
    this.settleMs = options.settleMs ?? 50;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    if (this.heartbeatMs >= this.leaseMs) throw new RangeError("heartbeatMs must be smaller than leaseMs");
  }

  /** Runs `fn` only if this tab gets the lock right now. Never waits for another tab. */
  async run<T>(fn: () => Promise<T>): Promise<SenderLockResult<T>> {
    if (this.held) return { acquired: false };
    this.held = true;
    try {
      if (this.locks) return await this.viaWebLocks(fn);
      if (this.storage) return await this.viaLease(fn, this.storage);
      return { acquired: true, mode: "single", value: await fn() };
    } finally {
      this.held = false;
    }
  }

  private async viaWebLocks<T>(fn: () => Promise<T>): Promise<SenderLockResult<T>> {
    let outcome: SenderLockResult<T> = { acquired: false };
    await this.locks!.request(this.name, { ifAvailable: true, mode: "exclusive" }, async (lock) => {
      if (!lock) return;
      outcome = { acquired: true, mode: "web-locks", value: await fn() };
    });
    return outcome;
  }

  private key(): string {
    return `${this.name}:lease`;
  }

  private readLease(storage: SyncStorageLike): Lease | null {
    try {
      const raw = storage.getItem(this.key());
      if (!raw) return null;
      const parsed = JSON.parse(raw) as Partial<Lease>;
      return typeof parsed.owner === "string" && typeof parsed.expiresAt === "number" ? (parsed as Lease) : null;
    } catch {
      return null;
    }
  }

  private writeLease(storage: SyncStorageLike): boolean {
    try {
      storage.setItem(this.key(), JSON.stringify({ owner: this.owner, expiresAt: this.now() + this.leaseMs }));
      return true;
    } catch {
      return false;
    }
  }

  private async viaLease<T>(fn: () => Promise<T>, storage: SyncStorageLike): Promise<SenderLockResult<T>> {
    const current = this.readLease(storage);
    if (current && current.owner !== this.owner && current.expiresAt > this.now()) return { acquired: false };
    if (!this.writeLease(storage)) {
      // Storage refuses writes: no way to coordinate. Behave as a single context.
      return { acquired: true, mode: "single", value: await fn() };
    }
    await this.sleep(this.settleMs);
    if (this.readLease(storage)?.owner !== this.owner) return { acquired: false };

    const timer = setInterval(() => {
      if (this.readLease(storage)?.owner === this.owner) this.writeLease(storage);
    }, this.heartbeatMs);
    try {
      return { acquired: true, mode: "lease", value: await fn() };
    } finally {
      clearInterval(timer);
      if (this.readLease(storage)?.owner === this.owner) {
        try {
          storage.removeItem(this.key());
        } catch {
          /* it expires by itself */
        }
      }
    }
  }
}
