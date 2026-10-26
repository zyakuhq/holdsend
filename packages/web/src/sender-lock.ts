/**
 * Keeps one tab of an origin sending at a time.
 *
 * This is about politeness, not correctness: every item is claimed inside an
 * atomic store update, and the server key turns any duplicate that still
 * gets through into a replay. Without it, two tabs coming back online
 * together would both send the queue and the server would see each request
 * twice.
 *
 * Three ways to coordinate, tried in order:
 *
 *   web-lock  The Web Locks API, asked for without waiting. The browser
 *             frees the lock when the callback ends or the tab goes away.
 *   lease     For browsers without Web Locks: a "holder until" record in
 *             localStorage, refreshed while held. localStorage cannot
 *             compare-and-set, so after writing the record we pause briefly
 *             and only go ahead if our record is still the one there. Two
 *             tabs can still both win in a rare race; claims make that safe.
 *   alone     Nothing to coordinate with (no Web Locks, storage blocked):
 *             just run.
 */

/** The part of navigator.locks this uses. */
export interface WebLockApi {
  request<R>(name: string, options: { ifAvailable: boolean }, callback: (lock: unknown) => Promise<R>): Promise<R>;
}

/** The part of localStorage this uses. */
export interface LeaseStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface SenderLockOptions {
  /** Lock name; use one per outbox. Default "holdsend-sender". */
  name?: string;
  /** Default navigator.locks when present. Pass null to skip Web Locks. */
  webLocks?: WebLockApi | null;
  /** Default localStorage when usable. Pass null to skip the lease. */
  leaseStorage?: LeaseStorage | null;
  /** How long a lease lasts without being refreshed. Default 15 s. */
  leaseMs?: number;
  /** How often a held lease is refreshed. Default 5 s. */
  refreshMs?: number;
  /** Pause before checking that our lease record stuck. Default 50 ms. */
  confirmDelayMs?: number;
  now?: () => number;
  wait?: (ms: number) => Promise<void>;
}

export type LockedRun<T> = { ran: true; via: "web-lock" | "lease" | "alone"; value: T } | { ran: false };

interface HolderRecord {
  holder: string;
  until: number;
}

function makeHolderId(): string {
  const source = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (typeof source?.randomUUID === "function") {
    try {
      return source.randomUUID();
    } catch {
      /* use the fallback */
    }
  }
  return `tab:${Math.random().toString(36).slice(2)}:${Date.now().toString(36)}`;
}

function browserWebLocks(): WebLockApi | null {
  try {
    const candidate = (globalThis as { navigator?: { locks?: WebLockApi } }).navigator?.locks;
    return candidate && typeof candidate.request === "function" ? candidate : null;
  } catch {
    return null;
  }
}

function browserLeaseStorage(): LeaseStorage | null {
  try {
    // Reading localStorage throws when the browser blocks storage.
    const candidate = (globalThis as { localStorage?: LeaseStorage }).localStorage;
    return candidate && typeof candidate.setItem === "function" ? candidate : null;
  } catch {
    return null;
  }
}

export class SenderLock {
  /** This tab's identity in lease records. */
  readonly holderId = makeHolderId();
  private readonly name: string;
  private readonly webLocks: WebLockApi | null;
  private readonly leaseStorage: LeaseStorage | null;
  private readonly leaseMs: number;
  private readonly refreshMs: number;
  private readonly confirmDelayMs: number;
  private readonly now: () => number;
  private readonly wait: (ms: number) => Promise<void>;
  /** A second run in the same tab while one is active is refused, as with Web Locks. */
  private busy = false;

  constructor(options: SenderLockOptions = {}) {
    this.name = options.name ?? "holdsend-sender";
    this.webLocks = options.webLocks === undefined ? browserWebLocks() : options.webLocks;
    this.leaseStorage = options.leaseStorage === undefined ? browserLeaseStorage() : options.leaseStorage;
    this.leaseMs = options.leaseMs ?? 15_000;
    this.refreshMs = options.refreshMs ?? 5_000;
    this.confirmDelayMs = options.confirmDelayMs ?? 50;
    this.now = options.now ?? Date.now;
    this.wait = options.wait ?? ((ms) => new Promise((done) => setTimeout(done, ms)));
    if (!(this.refreshMs < this.leaseMs)) throw new RangeError("refreshMs must be shorter than leaseMs");
  }

  /** Runs `task` if this tab can take the lock right now; never waits for another tab. */
  async run<T>(task: () => Promise<T>): Promise<LockedRun<T>> {
    if (this.busy) return { ran: false };
    this.busy = true;
    try {
      if (this.webLocks) {
        let started = false;
        try {
          return await this.webLocks.request(this.name, { ifAvailable: true }, async (granted): Promise<LockedRun<T>> => {
            if (!granted) return { ran: false };
            started = true;
            return { ran: true, via: "web-lock", value: await task() };
          });
        } catch (err) {
          // The task's own failure is the caller's to see. But a refusal
          // before the task ran (Web Locks exist yet throw SecurityError in a
          // sandboxed iframe or with site data blocked) must not stop
          // sending for good: fall back to the next way below.
          if (started) throw err;
        }
      }
      // The lease itself falls back to running alone when storage refuses writes.
      if (this.leaseStorage) return await this.underLease(this.leaseStorage, task);
      return { ran: true, via: "alone", value: await task() };
    } finally {
      this.busy = false;
    }
  }

  private get recordKey(): string {
    return `${this.name}.holder`;
  }

  private currentHolder(storage: LeaseStorage): HolderRecord | null {
    let text: string | null;
    try {
      text = storage.getItem(this.recordKey);
    } catch {
      return null;
    }
    if (!text) return null;
    try {
      const parsed: unknown = JSON.parse(text);
      const r = parsed as Partial<HolderRecord>;
      return typeof r.holder === "string" && typeof r.until === "number" ? { holder: r.holder, until: r.until } : null;
    } catch {
      return null;
    }
  }

  /** Writes our record. False when storage refuses writes. */
  private stamp(storage: LeaseStorage): boolean {
    const record: HolderRecord = { holder: this.holderId, until: this.now() + this.leaseMs };
    try {
      storage.setItem(this.recordKey, JSON.stringify(record));
      return true;
    } catch {
      return false;
    }
  }

  private async underLease<T>(storage: LeaseStorage, task: () => Promise<T>): Promise<LockedRun<T>> {
    const before = this.currentHolder(storage);
    const someoneElse = before !== null && before.holder !== this.holderId && before.until > this.now();
    if (someoneElse) return { ran: false };
    if (!this.stamp(storage)) return { ran: true, via: "alone", value: await task() };

    await this.wait(this.confirmDelayMs);
    if (this.currentHolder(storage)?.holder !== this.holderId) return { ran: false };

    const refresher = setInterval(() => {
      if (this.currentHolder(storage)?.holder === this.holderId) this.stamp(storage);
    }, this.refreshMs);
    try {
      return { ran: true, via: "lease", value: await task() };
    } finally {
      clearInterval(refresher);
      if (this.currentHolder(storage)?.holder === this.holderId) {
        try {
          storage.removeItem(this.recordKey);
        } catch {
          /* the record expires on its own */
        }
      }
    }
  }
}
