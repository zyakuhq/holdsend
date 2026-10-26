import { describe, expect, it } from "vitest";
import { DEFAULT_POLICY, needsConfirmation, statusOf, type OutboxItem } from "../src/index.js";
import { approve, cancel, claim, discard, isSendable, retry, settle } from "../src/transitions.js";

const NOW = Date.parse("2026-10-25T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

function item(overrides: Partial<OutboxItem> = {}): OutboxItem {
  return {
    key: "key-000000001",
    kind: "post.create",
    payload: { text: "synthetic note" },
    writtenAt: NOW - 1000,
    state: "waiting",
    attempts: 0,
    touched: false,
    ...overrides,
  };
}

describe("claim", () => {
  it("lets exactly one of two racing senders take an item", () => {
    const items = [item()];
    const first = claim(items, "key-000000001", "sender-a", NOW);
    const second = claim(items, "key-000000001", "sender-b", NOW);
    expect(first?.claimToken).toBe("sender-a");
    expect(second).toBeNull();
    expect(items[0]?.state).toBe("sending");
    expect(items[0]?.attempts).toBe(1);
    expect(items[0]?.touched).toBe(true);
  });

  it("lets another sender take over a claim nobody renewed, with the same key", () => {
    const items = [item()];
    claim(items, "key-000000001", "dead-sender", NOW);
    const later = NOW + DEFAULT_POLICY.staleClaimMs + 1;
    const taken = claim(items, "key-000000001", "new-sender", later);
    expect(taken?.key).toBe("key-000000001");
    expect(taken?.claimToken).toBe("new-sender");
  });

  it("never sends another owner's item", () => {
    const items = [item({ owner: "person-a" })];
    expect(claim(items, "key-000000001", "t", NOW, DEFAULT_POLICY, "person-b")).toBeNull();
    expect(claim(items, "key-000000001", "t", NOW, DEFAULT_POLICY, "person-a")).not.toBeNull();
  });
});

describe("settle", () => {
  it("ignores a stale sender's failure once another sender took over", () => {
    const items = [item()];
    claim(items, "key-000000001", "old", NOW);
    const later = NOW + DEFAULT_POLICY.staleClaimMs + 1;
    claim(items, "key-000000001", "new", later);
    settle(items, "key-000000001", "old", { type: "refused" }, later);
    expect(items[0]?.state).toBe("sending");
    expect(items[0]?.claimToken).toBe("new");
  });

  it("records 'sent' from any sender, because it is a fact about the server", () => {
    const items = [item()];
    claim(items, "key-000000001", "old", NOW);
    claim(items, "key-000000001", "new", NOW + DEFAULT_POLICY.staleClaimMs + 1);
    settle(items, "key-000000001", "old", { type: "sent" }, NOW + DEFAULT_POLICY.staleClaimMs + 2);
    expect(items[0]?.state).toBe("sent");
  });

  it("does not count an attempt the server was still busy with", () => {
    const items = [item()];
    claim(items, "key-000000001", "t", NOW);
    settle(items, "key-000000001", "t", { type: "busy" }, NOW);
    expect(items[0]?.state).toBe("waiting");
    expect(items[0]?.attempts).toBe(0);
  });

  it("becomes stuck after the last automatic attempt", () => {
    const items = [item({ attempts: DEFAULT_POLICY.maxAttempts - 1, touched: true })];
    claim(items, "key-000000001", "t", NOW);
    settle(items, "key-000000001", "t", { type: "retry" }, NOW);
    expect(items[0]?.state).toBe("stuck");
    expect(items[0]?.stuckReason).toBe("attempts_exhausted");
    expect(isSendable(items[0]!, NOW)).toBe(false);
  });
});

describe("cancel", () => {
  it("removes an item no sender has touched", () => {
    const items = [item()];
    expect(cancel(items, "key-000000001")).toBe("cancelled");
    expect(items).toHaveLength(0);
  });

  it("refuses once an attempt started, because it may already be on the server", () => {
    const items = [item()];
    claim(items, "key-000000001", "t", NOW);
    settle(items, "key-000000001", "t", { type: "retry" }, NOW);
    expect(items[0]?.state).toBe("waiting");
    expect(cancel(items, "key-000000001")).toBe("in_flight");
    expect(items).toHaveLength(1);
    expect(statusOf(items[0]!, NOW)).toBe("sending");
  });
});

describe("old items", () => {
  const old = () => item({ writtenAt: NOW - 31 * DAY });

  it("are never sent automatically", () => {
    expect(needsConfirmation(old(), NOW)).toBe(true);
    expect(isSendable(old(), NOW)).toBe(false);
    expect(statusOf(old(), NOW)).toBe("needs_confirmation");
  });

  it("are sent after a person approves, keeping the same key", () => {
    const items = [old()];
    expect(approve(items, "key-000000001", NOW, () => "unused-key-01")).toEqual({ ok: true, key: "key-000000001", newKey: false });
    expect(isSendable(items[0]!, NOW)).toBe(true);
    expect(claim(items, "key-000000001", "t", NOW)?.key).toBe("key-000000001");
  });

  it("can be discarded by a person", () => {
    const items = [old()];
    expect(discard(items, "key-000000001", NOW)).toBe("discarded");
    expect(items).toHaveLength(0);
  });
});

describe("retry by a person", () => {
  it("keeps the key after a refusal or exhausted attempts", () => {
    const items = [item({ state: "stuck", stuckReason: "refused", attempts: 1, touched: true })];
    expect(retry(items, "key-000000001", NOW, () => "fresh-key-0001")).toEqual({ ok: true, key: "key-000000001", newKey: false });
    expect(items[0]?.state).toBe("waiting");
    expect(items[0]?.attempts).toBe(0);
  });

  it("uses a new key only after a key conflict", () => {
    const items = [item({ state: "stuck", stuckReason: "key_conflict", attempts: 1, touched: true })];
    expect(retry(items, "key-000000001", NOW, () => "fresh-key-0001")).toEqual({ ok: true, key: "fresh-key-0001", newKey: true });
  });

  it("does nothing for an item that is not stuck", () => {
    const items = [item()];
    expect(retry(items, "key-000000001", NOW, () => "fresh-key-0001")).toEqual({ ok: false, reason: "not_stuck" });
  });
});

describe("discard", () => {
  it("is refused while a live sender holds the item", () => {
    const items = [item()];
    claim(items, "key-000000001", "t", NOW);
    expect(discard(items, "key-000000001", NOW)).toBe("in_flight");
  });

  it("says honestly when a copy may exist on the server", () => {
    const items = [item({ state: "stuck", stuckReason: "attempts_exhausted", attempts: 5, touched: true })];
    expect(discard(items, "key-000000001", NOW)).toBe("discarded_may_exist");
  });
});
