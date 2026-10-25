/**
 * The truth about time.
 *
 * Every item records when it was WRITTEN (device clock, set once). The server
 * records when it ARRIVED. These are two different facts and both are worth
 * showing: "written offline at 08:15, posted at 11:40".
 *
 * The rule that keeps a feed honest: the written time is DISPLAY ONLY. Feeds
 * order by arrival time. The written time comes from a device clock nobody can
 * check, so letting it reorder a feed would let anyone backdate a post.
 *
 * These helpers are shared by clients and servers so both sides apply the
 * same bounds.
 */

export interface WrittenAtBounds {
  /** How far ahead of the server clock a device clock may be. Default 2 minutes. */
  maxFutureSkewMs: number;
  /** The oldest written time that is kept. Default 30 days. */
  maxAgeMs: number;
}

export const DEFAULT_WRITTEN_AT_BOUNDS: Readonly<WrittenAtBounds> = Object.freeze({
  maxFutureSkewMs: 2 * 60 * 1000,
  maxAgeMs: 30 * 24 * 60 * 60 * 1000,
});

const DATE_PART = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;
const CLOCK_PART = /^[0-9]{2}:[0-9]{2}(:[0-9]{2}(\.[0-9]{1,9})?)?$/;
const OFFSET_PART = /^[+-][0-9]{2}:[0-9]{2}$/;

/**
 * Parses "YYYY-MM-DDTHH:MM[:SS[.fraction]]" followed by "Z" or "+HH:MM" /
 * "-HH:MM". A time without a zone is refused: it would mean a different
 * moment on every server.
 */
function parseZonedTimestamp(text: string): number | null {
  if (text.length > 40 || text.charAt(10) !== "T") return null;
  if (!DATE_PART.test(text.slice(0, 10))) return null;
  const afterT = text.slice(11);
  const zoneLength = afterT.endsWith("Z") ? 1 : 6;
  const zone = afterT.slice(afterT.length - zoneLength);
  if (zone !== "Z" && !OFFSET_PART.test(zone)) return null;
  if (!CLOCK_PART.test(afterT.slice(0, afterT.length - zoneLength))) return null;
  const ms = Date.parse(text);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Server side: decides whether a written time a client claims is kept.
 *
 * Returns epoch ms, or null when the value must be ignored. A bad value never
 * makes the request fail; the item is simply stored without a written time.
 *
 * - Not a zoned ISO 8601 timestamp: ignored.
 * - Later than now plus `maxFutureSkewMs`: ignored (a broken device clock).
 * - Earlier than now minus `maxAgeMs`: ignored, so nobody can claim
 *   "written last year".
 * - Inside the window but after now: treated as now, so nothing is ever
 *   written after it arrived.
 *
 * Any client can send this header, so treat the result as the author's own
 * claim, show it as such, and never order anything by it.
 */
export function acceptWrittenAt(
  raw: unknown,
  now: number,
  bounds: WrittenAtBounds = DEFAULT_WRITTEN_AT_BOUNDS,
): number | null {
  if (typeof raw !== "string") return null;
  const claimed = parseZonedTimestamp(raw);
  if (claimed === null) return null;
  const earliest = now - bounds.maxAgeMs;
  const latest = now + bounds.maxFutureSkewMs;
  if (claimed < earliest || claimed > latest) return null;
  return claimed > now ? now : claimed;
}

/** Client side: the written time as the string the server expects. */
export function formatWrittenAt(writtenAt: number): string {
  return new Date(writtenAt).toISOString();
}

/**
 * Whether a "written offline" line is worth showing. A post that waited a few
 * seconds for a signal is not news, so the default gap is one minute.
 * Returns false when either time is missing or invalid.
 */
export function wasWrittenOffline(
  writtenAt: number | null | undefined,
  publishedAt: number | null | undefined,
  minGapMs = 60 * 1000,
): boolean {
  if (writtenAt == null || publishedAt == null) return false;
  if (!Number.isFinite(writtenAt) || !Number.isFinite(publishedAt)) return false;
  return publishedAt - writtenAt > minGapMs;
}
