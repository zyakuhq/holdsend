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

/** ISO 8601 date-time with an explicit zone, e.g. 2026-10-25T08:15:00.000Z. */
const ISO_WITH_ZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * Server side: decides whether a client-claimed written time is kept.
 *
 * Returns epoch ms, or null when the value must be ignored. A bad value never
 * makes the request fail; the item is simply stored without a written time.
 *
 * - Not a zoned ISO 8601 string: ignored.
 * - More than `maxFutureSkewMs` in the future: ignored (a broken clock).
 * - Within the skew: clamped to `now`, so nothing is written after it arrived.
 * - Older than `maxAgeMs`: ignored, so nobody can claim "written last year".
 */
export function acceptWrittenAt(
  raw: unknown,
  now: number,
  bounds: WrittenAtBounds = DEFAULT_WRITTEN_AT_BOUNDS,
): number | null {
  if (typeof raw !== "string" || raw.length > 40 || !ISO_WITH_ZONE.test(raw)) return null;
  const at = Date.parse(raw);
  if (!Number.isFinite(at)) return null;
  if (at > now + bounds.maxFutureSkewMs) return null;
  if (at < now - bounds.maxAgeMs) return null;
  return Math.min(at, now);
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
