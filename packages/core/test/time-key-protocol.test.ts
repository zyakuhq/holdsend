import { describe, expect, it } from "vitest";
import {
  acceptWrittenAt,
  classifyResponse,
  isValidKey,
  newKey,
  requestHeaders,
  wasWrittenOffline,
} from "../src/index.js";

const NOW = Date.parse("2026-10-25T12:00:00.000Z");
const MIN = 60 * 1000;
const DAY = 24 * 60 * MIN;

describe("keys", () => {
  it("makes valid, distinct keys", () => {
    const keys = new Set(Array.from({ length: 500 }, () => newKey()));
    expect(keys.size).toBe(500);
    for (const k of keys) expect(isValidKey(k)).toBe(true);
  });

  it("rejects keys outside the allowed shape", () => {
    expect(isValidKey("short")).toBe(false);
    expect(isValidKey("has space in it")).toBe(false);
    expect(isValidKey("x".repeat(129))).toBe(false);
    expect(isValidKey(42)).toBe(false);
    expect(isValidKey("abc_DEF-123:4.5")).toBe(true);
  });
});

describe("acceptWrittenAt", () => {
  it("keeps a sane past time", () => {
    expect(acceptWrittenAt("2026-10-25T08:15:00.000Z", NOW)).toBe(Date.parse("2026-10-25T08:15:00.000Z"));
  });

  it("accepts an offset zone", () => {
    expect(acceptWrittenAt("2026-10-25T13:45:00+05:30", NOW)).toBe(Date.parse("2026-10-25T08:15:00Z"));
  });

  it("clamps a small future skew to now, so nothing is written after it arrived", () => {
    expect(acceptWrittenAt(new Date(NOW + MIN).toISOString(), NOW)).toBe(NOW);
  });

  it("ignores a clock far in the future", () => {
    expect(acceptWrittenAt(new Date(NOW + 3 * MIN).toISOString(), NOW)).toBeNull();
  });

  it("ignores a claim older than the maximum age", () => {
    expect(acceptWrittenAt(new Date(NOW - 31 * DAY).toISOString(), NOW)).toBeNull();
    expect(acceptWrittenAt(new Date(NOW - 29 * DAY).toISOString(), NOW)).not.toBeNull();
  });

  it("ignores anything that is not a zoned ISO time", () => {
    for (const bad of ["2026-10-25 08:15", "2026-10-25T08:15:00", "yesterday", 1729843200000, null, undefined, {}, "2026-13-45T99:99:00Z"]) {
      expect(acceptWrittenAt(bad, NOW)).toBeNull();
    }
  });
});

describe("wasWrittenOffline", () => {
  it("needs more than a minute between writing and publishing", () => {
    expect(wasWrittenOffline(NOW - 30 * 1000, NOW)).toBe(false);
    expect(wasWrittenOffline(NOW - 5 * MIN, NOW)).toBe(true);
    expect(wasWrittenOffline(undefined, NOW)).toBe(false);
    expect(wasWrittenOffline(Number.NaN, NOW)).toBe(false);
  });
});

describe("protocol", () => {
  it("sends the key and the written time", () => {
    const headers = requestHeaders({ key: "item-key-0001", writtenAt: Date.parse("2026-10-25T08:15:00Z") });
    expect(headers).toEqual({ "Idempotency-Key": "item-key-0001", "Written-At": "2026-10-25T08:15:00.000Z" });
  });

  it("can leave the written time out", () => {
    const headers = requestHeaders({ key: "item-key-0001", writtenAt: NOW }, { omitWrittenAt: true });
    expect(headers).toEqual({ "Idempotency-Key": "item-key-0001" });
  });

  it.each([
    [201, undefined, "sent"],
    [200, undefined, "sent"],
    [410, "gone", "sent"],
    [409, "key_conflict", "conflict"],
    [409, "in_progress", "busy"],
    [409, "something_else", "refused"],
    [400, undefined, "refused"],
    [413, undefined, "refused"],
    [401, undefined, "retry"],
    [408, undefined, "retry"],
    [429, undefined, "retry"],
    [500, undefined, "retry"],
    [503, undefined, "retry"],
    [0, undefined, "retry"],
  ] as const)("HTTP %i %s means %s", (status, code, expected) => {
    expect(classifyResponse(status, code).type).toBe(expected);
  });
});
