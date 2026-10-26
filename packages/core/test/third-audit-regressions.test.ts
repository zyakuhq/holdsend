/**
 * Regression tests for the core findings of the third audit (2026-10-26).
 * Each failed on the code before its fix.
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_POLICY, MemoryStore, Outbox, resolvePolicy, type OutboxItem } from "../src/index.js";
import { isClaimLive, isSendable, retry } from "../src/transitions.js";

const NOW = Date.parse("2026-10-26T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;

function item(overrides: Partial<OutboxItem> = {}): OutboxItem {
  return { key: "item-key-0001", kind: "k", payload: {}, writtenAt: NOW - 1000, state: "waiting", attempts: 0, touched: false, ...overrides };
}

describe("A2: policy options", () => {
  it("keep the default when a value is undefined (for example an unset environment variable)", () => {
    const policy = resolvePolicy({ staleClaimMs: undefined, maxAttempts: undefined });
    expect(policy.staleClaimMs).toBe(DEFAULT_POLICY.staleClaimMs);
    expect(policy.maxAttempts).toBe(DEFAULT_POLICY.maxAttempts);
    // A claim made a moment ago is still live, so no second sender takes it.
    expect(isClaimLive(item({ state: "sending", claimedAt: NOW - 1 }), NOW, policy)).toBe(true);
  });

  it("refuse values that would make sending wrong", () => {
    for (const bad of [{ maxAttempts: 0 }, { maxAttempts: 1.5 }, { staleClaimMs: Number.NaN }, { retryDelaysMs: [] }, { attemptTimeoutMs: -1 }, { giveUpAfterMs: Infinity }]) {
      expect(() => new Outbox({ store: new MemoryStore(), send: async () => ({ type: "sent" }), policy: bad }), JSON.stringify(bad)).toThrow(RangeError);
    }
  });

  it("are frozen and never shared between outboxes", () => {
    const a = new Outbox({ store: new MemoryStore(), send: async () => ({ type: "sent" }) });
    expect(Object.isFrozen(a.policy)).toBe(true);
    expect(Object.isFrozen(a.policy.retryDelaysMs)).toBe(true);
    expect(a.policy.retryDelaysMs).not.toBe(DEFAULT_POLICY.retryDelaysMs);
  });
});

describe("A3: retry and approve say why nothing happened", () => {
  it("tells 'no such item' apart from 'not stuck'", () => {
    const items = [item()];
    expect(retry(items, "missing-key-01", NOW, () => "new-key-00001")).toEqual({ ok: false, reason: "not_found" });
    expect(retry(items, "item-key-0001", NOW, () => "new-key-00001")).toEqual({ ok: false, reason: "not_stuck" });
  });
});

describe("A5: a device clock set back after a claim or a backoff", () => {
  it("does not freeze a claim stamped in the future", () => {
    const claimed = item({ state: "sending", claimedAt: NOW + DAY, claimToken: "token-000001", attempts: 1, touched: true });
    expect(isClaimLive(claimed, NOW)).toBe(false);
    expect(isSendable(claimed, NOW)).toBe(true);
  });

  it("does not hold an item longer than the longest retry delay", () => {
    const waiting = item({ retryAt: NOW + DAY, failures: 1, touched: true });
    expect(isSendable(waiting, NOW)).toBe(true);
    const normal = item({ retryAt: NOW + 5_000, failures: 1, touched: true });
    expect(isSendable(normal, NOW)).toBe(false);
  });
});

describe("A6: items without an owner", () => {
  it("are not sent by a flush for one signed-in person", async () => {
    const sent: string[] = [];
    const outbox = new Outbox({
      store: new MemoryStore(),
      send: async (i) => {
        sent.push(String((i.payload as { text: string }).text));
        return { type: "sent" };
      },
    });
    await outbox.add("note.create", { text: "nobody's" });
    await outbox.add("note.create", { text: "alice's" }, { owner: "alice" });
    await outbox.flush("bob");
    expect(sent).toEqual([]);
    await outbox.flush("alice");
    expect(sent).toEqual(["alice's"]);
    await outbox.flush();
    expect(sent).toEqual(["alice's", "nobody's"]);
  });
});
