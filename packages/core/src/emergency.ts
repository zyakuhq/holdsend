/**
 * Emergency messages: short texts that must get out of a phone with no
 * signal, once, without misleading anyone. A delivery aid, not an emergency
 * service: apps must keep telling people to call their local emergency
 * number first. See docs/decisions/0007-emergency-messages.md.
 *
 *   import { EmergencyOutbox, smsLink } from "@holdsend/core/emergency";
 */
import { Outbox, type OutboxOptions } from "./outbox.js";
import type { OutboxItem, PolicyOptions } from "./types.js";

/** The payload of every emergency message. Text only. */
export interface EmergencyMessage {
  text: string;
}

export const EMERGENCY_KIND = "emergency.message";

const DAY = 24 * 60 * 60 * 1000;

export interface EmergencyOutboxOptions extends OutboxOptions<EmergencyMessage> {
  /**
   * Which messages go automatically when the connection returns:
   * - "first" (default): a message written while no other message from the
   *   same person is waiting; later ones are held until the person sends them.
   * - "all": every message.
   * - "none": none; every message waits for the person.
   */
  autoSend?: "first" | "all" | "none";
  /** The same words, written this close to a waiting message, are that message. Default ten minutes. 0 turns it off. */
  dedupeWithinMs?: number;
  /** Longest text accepted, in characters. Default 1,000. */
  maxLength?: number;
  /** Defaults to the core policy, except confirmAfterMs: one day. */
  policy?: PolicyOptions;
}

export interface WriteOptions {
  /** Who wrote it. Matching and "first" are per person. */
  owner?: string;
  /** When the person wrote it. Defaults to now. */
  writtenAt?: number;
}

export interface WriteResult {
  item: OutboxItem<EmergencyMessage>;
  /** The same words were already waiting: nothing new was queued, and `item` is that message. */
  duplicate: boolean;
  /** Queued, but held: it goes only when the person sends it (`send(key)` or `sendAll()`). */
  held: boolean;
}

/** Lower case, trimmed, runs of spaces as one: what "the same words" means. */
export function sameWords(text: string): string {
  return text.trim().replace(/\s+/g, " ").toLowerCase();
}

export class EmergencyOutbox {
  /** The underlying outbox: flush, list, subscribe, cancel and discard live here. */
  readonly outbox: Outbox<EmergencyMessage>;
  private readonly autoSend: "first" | "all" | "none";
  private readonly dedupeWithinMs: number;
  private readonly maxLength: number;
  private readonly now: () => number;

  constructor(options: EmergencyOutboxOptions) {
    const { autoSend = "first", dedupeWithinMs = 10 * 60 * 1000, maxLength = 1000, policy, ...rest } = options;
    if (autoSend !== "first" && autoSend !== "all" && autoSend !== "none") throw new RangeError('autoSend must be "first", "all" or "none"');
    if (!Number.isFinite(dedupeWithinMs) || dedupeWithinMs < 0) throw new RangeError("dedupeWithinMs must be a finite number, 0 or more");
    if (!Number.isInteger(maxLength) || maxLength < 1) throw new RangeError("maxLength must be a whole number, 1 or more");
    this.autoSend = autoSend;
    this.dedupeWithinMs = dedupeWithinMs;
    this.maxLength = maxLength;
    this.now = rest.now ?? Date.now;
    this.outbox = new Outbox<EmergencyMessage>({ ...rest, policy: { ...policy, confirmAfterMs: policy?.confirmAfterMs ?? DAY } });
  }

  /**
   * Queues a message, or returns the waiting one with the same words. Call
   * `outbox.flush()` (or let auto-flush do it) to send.
   */
  async write(text: string, options: WriteOptions = {}): Promise<WriteResult> {
    if (typeof text !== "string") throw new TypeError("text must be a string");
    const trimmed = text.trim();
    if (trimmed === "") throw new TypeError("text must not be empty");
    if (trimmed.length > this.maxLength) throw new RangeError(`text must be at most ${this.maxLength} characters`);
    const writtenAt = options.writtenAt ?? this.now();
    const words = sameWords(trimmed);
    let duplicate = false;
    let held = false;
    const item = await this.outbox.add(EMERGENCY_KIND, { text: trimmed }, {
      ...(options.owner !== undefined && { owner: options.owner }),
      writtenAt,
      decide: (queued) => {
        const mine = queued.filter((i) => i.kind === EMERGENCY_KIND && i.owner === options.owner);
        const same =
          this.dedupeWithinMs > 0
            ? mine.find((i) => sameWords(i.payload.text) === words && Math.abs(i.writtenAt - writtenAt) <= this.dedupeWithinMs)
            : undefined;
        if (same) {
          duplicate = true;
          held = same.held === true && same.approvedAt === undefined;
          return same;
        }
        if (this.autoSend === "none" || (this.autoSend === "first" && mine.length > 0)) {
          held = true;
          return "hold";
        }
        return undefined;
      },
    });
    return { item, duplicate, held };
  }

  /** The person pressed Send on one waiting message. */
  send(key: string) {
    return this.outbox.approve(key);
  }

  /**
   * The person pressed Send all: approves every message waiting for them,
   * oldest first. Returns the keys approved, in order.
   */
  async sendAll(owner?: string): Promise<string[]> {
    const waiting = (await this.outbox.list()).filter(
      (e) => e.status === "needs_confirmation" && e.item.kind === EMERGENCY_KIND && e.item.owner === owner,
    );
    const approved: string[] = [];
    for (const { item } of waiting) {
      const result = await this.outbox.approve(item.key);
      if (result.ok) approved.push(result.key);
    }
    return approved;
  }
}

export interface SmsLinkOptions {
  /**
   * iOS does not follow the sms: standard for several recipients, so they
   * need a different link there. One recipient works the same everywhere.
   * Default "other".
   */
  platform?: "ios" | "other";
}

/**
 * A link that opens the phone's messaging app with the text filled in. The
 * person still presses send there: no web page or app can send an SMS by
 * itself. Before handing off, cancel the queued message (`outbox.cancel`);
 * if that says "in_flight", tell the person it may arrive twice.
 */
export function smsLink(to: string | readonly string[], body: string, options: SmsLinkOptions = {}): string {
  const numbers = (typeof to === "string" ? [to] : [...to]).map((n) => n.replace(/[\s().-]/g, ""));
  if (numbers.length === 0 || numbers.some((n) => !/^\+?\d{2,15}$/.test(n))) {
    throw new TypeError("each number must be digits, optionally starting with +");
  }
  const text = encodeURIComponent(body);
  if (numbers.length > 1 && options.platform === "ios") return `sms://open?addresses=${numbers.join(",")}&body=${text}`;
  return `sms:${numbers.join(",")}?body=${text}`;
}
