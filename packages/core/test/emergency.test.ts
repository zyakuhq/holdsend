/**
 * Emergency messages (decision 0007): the first goes by itself, later ones
 * wait for the person, repeated taps are one message, old messages ask first,
 * and SMS is a hand-off.
 */
import { describe, expect, it } from "vitest";
import { EMERGENCY_KIND, EmergencyOutbox, sameWords, smsLink, type EmergencyMessage } from "../src/emergency.js";
import { MemoryStore, Outbox, type OutboxItem } from "../src/index.js";
import { FakeServer } from "./fake-server.js";

const T0 = Date.parse("2026-10-29T12:00:00Z");
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

function setup(options: Partial<ConstructorParameters<typeof EmergencyOutbox>[0]> = {}) {
  const clock = { t: T0 };
  const server = new FakeServer();
  const store = new MemoryStore<EmergencyMessage>();
  const emergency = new EmergencyOutbox({
    store,
    send: server.sender(),
    now: () => clock.t,
    policy: { claimRenewMs: 0 },
    ...options,
  });
  const sentTexts = () => server.created.map((c) => (JSON.parse(c.body) as EmergencyMessage).text);
  return { clock, server, store, emergency, sentTexts };
}

describe("add() with decide", () => {
  it("holds an item until a person approves it, however recent", async () => {
    const outbox = new Outbox<{ n: number }>({ store: new MemoryStore(), now: () => T0, send: async () => ({ type: "sent" }), policy: { claimRenewMs: 0 } });
    const held = await outbox.add("k", { n: 1 }, { decide: () => "hold" });
    expect(held.held).toBe(true);
    expect((await outbox.list())[0]?.status).toBe("needs_confirmation");
    expect(await outbox.flush()).toMatchObject({ sent: 0 });
    expect(await outbox.approve(held.key)).toMatchObject({ ok: true, newKey: false });
    expect(await outbox.flush()).toMatchObject({ sent: 1 });
  });

  it("adds nothing when decide returns a queued item, and returns a copy of it", async () => {
    const outbox = new Outbox<{ n: number }>({ store: new MemoryStore(), send: async () => ({ type: "sent" }) });
    const first = await outbox.add("k", { n: 1 });
    const again = await outbox.add("k", { n: 2 }, { decide: (queued) => queued[0] });
    expect(again.key).toBe(first.key);
    expect(again.payload).toEqual({ n: 1 });
    expect(await outbox.list()).toHaveLength(1);
  });

  it("refuses an item that is not one of the queued ones", async () => {
    const outbox = new Outbox<{ n: number }>({ store: new MemoryStore(), send: async () => ({ type: "sent" }) });
    const stranger = { key: "not-queued-0001", kind: "k", payload: { n: 0 }, writtenAt: T0, state: "waiting", attempts: 0, touched: false } as OutboxItem<{ n: number }>;
    await expect(outbox.add("k", { n: 1 }, { decide: () => stranger })).rejects.toThrow(/queued items/);
    expect(await outbox.list()).toHaveLength(0);
  });

  it("is not shown delivered items", async () => {
    const outbox = new Outbox<{ n: number }>({ store: new MemoryStore(), send: async () => ({ type: "sent" }), policy: { claimRenewMs: 0 } });
    await outbox.add("k", { n: 1 });
    await outbox.flush();
    let seen = -1;
    await outbox.add("k", { n: 2 }, { decide: (queued) => void (seen = queued.length) });
    expect(seen).toBe(0);
  });
});

describe("EmergencyOutbox: which messages go by themselves", () => {
  it("sends the first message automatically and holds later ones until the person sends them", async () => {
    const { emergency, sentTexts } = setup();
    const first = await emergency.write("Trapped on the roof", { owner: "p1" });
    const second = await emergency.write("Water is rising", { owner: "p1" });
    expect(first).toMatchObject({ duplicate: false, held: false });
    expect(second).toMatchObject({ duplicate: false, held: true });

    await emergency.outbox.flush();
    expect(sentTexts()).toEqual(["Trapped on the roof"]);
    const [left] = await emergency.outbox.list();
    expect(left).toMatchObject({ status: "needs_confirmation", item: { key: second.item.key } });

    expect(await emergency.send(second.item.key)).toMatchObject({ ok: true, key: second.item.key, newKey: false });
    await emergency.outbox.flush();
    expect(sentTexts()).toEqual(["Trapped on the roof", "Water is rising"]);
  });

  it("decides per person on a shared device", async () => {
    const { emergency } = setup();
    await emergency.write("Need help", { owner: "p1" });
    const other = await emergency.write("Need help too", { owner: "p2" });
    expect(other.held).toBe(false);
  });

  it("sends a new message by itself once nothing else is waiting", async () => {
    const { emergency, clock, sentTexts } = setup();
    await emergency.write("Need water", { owner: "p1" });
    await emergency.outbox.flush();
    clock.t += HOUR;
    const later = await emergency.write("Need medicine", { owner: "p1" });
    expect(later.held).toBe(false);
    await emergency.outbox.flush();
    expect(sentTexts()).toEqual(["Need water", "Need medicine"]);
  });

  it("Send all approves the held messages oldest first", async () => {
    const { emergency, clock, sentTexts } = setup();
    await emergency.write("One", { owner: "p1" });
    clock.t += MIN;
    const two = await emergency.write("Two", { owner: "p1" });
    clock.t += MIN;
    const three = await emergency.write("Three", { owner: "p1" });
    expect(await emergency.sendAll("p1")).toEqual([two.item.key, three.item.key]);
    await emergency.outbox.flush();
    expect(sentTexts()).toEqual(["One", "Two", "Three"]);
  });

  it('"all" sends every message and "none" holds every message', async () => {
    const all = setup({ autoSend: "all" });
    await all.emergency.write("A", { owner: "p1" });
    await all.emergency.write("B", { owner: "p1" });
    await all.emergency.outbox.flush();
    expect(all.sentTexts()).toEqual(["A", "B"]);

    const none = setup({ autoSend: "none" });
    expect((await none.emergency.write("A", { owner: "p1" })).held).toBe(true);
    await none.emergency.outbox.flush();
    expect(none.sentTexts()).toEqual([]);
  });

  it("asks before sending even the first message once it is a day old", async () => {
    const { emergency, clock, sentTexts } = setup({ isOnline: () => false });
    const first = await emergency.write("Stuck at the station", { owner: "p1" });
    clock.t += DAY + MIN;
    const [entry] = await emergency.outbox.list();
    expect(entry?.status).toBe("needs_confirmation");
    expect(await emergency.send(first.item.key)).toMatchObject({ ok: true });
    expect(sentTexts()).toEqual([]);
  });

  it("keeps the one-day default when the app passes confirmAfterMs: undefined", async () => {
    const { emergency, clock } = setup({ policy: { claimRenewMs: 0, confirmAfterMs: undefined } });
    await emergency.write("Hello", { owner: "p1" });
    clock.t += DAY + MIN;
    expect((await emergency.outbox.list())[0]?.status).toBe("needs_confirmation");
  });
});

describe("EmergencyOutbox: repeated taps", () => {
  it("treats the same words written again soon as the same message", async () => {
    const { emergency, clock, sentTexts } = setup();
    const first = await emergency.write("Need help at the bridge", { owner: "p1" });
    clock.t += 2 * MIN;
    const again = await emergency.write("  need HELP   at the bridge ", { owner: "p1" });
    expect(again).toMatchObject({ duplicate: true, held: false, item: { key: first.item.key } });
    expect(await emergency.outbox.list()).toHaveLength(1);
    await emergency.outbox.flush();
    expect(sentTexts()).toEqual(["Need help at the bridge"]);
  });

  it("queues the same words again after the window, or after the first was delivered", async () => {
    const late = setup();
    await late.emergency.write("Help", { owner: "p1" });
    late.clock.t += 11 * MIN;
    expect((await late.emergency.write("Help", { owner: "p1" })).duplicate).toBe(false);

    const delivered = setup();
    await delivered.emergency.write("Help", { owner: "p1" });
    await delivered.emergency.outbox.flush();
    const again = await delivered.emergency.write("Help", { owner: "p1" });
    expect(again).toMatchObject({ duplicate: false, held: false });
  });

  it("reports a held duplicate as held", async () => {
    const { emergency } = setup();
    await emergency.write("First", { owner: "p1" });
    await emergency.write("Second", { owner: "p1" });
    expect(await emergency.write("second", { owner: "p1" })).toMatchObject({ duplicate: true, held: true });
  });

  it("can be turned off", async () => {
    const { emergency } = setup({ dedupeWithinMs: 0, autoSend: "all" });
    await emergency.write("Help", { owner: "p1" });
    expect((await emergency.write("Help", { owner: "p1" })).duplicate).toBe(false);
  });

  it("holds with two tabs writing at the same moment: one message for the same words, one automatic send", async () => {
    const store = new MemoryStore<EmergencyMessage>();
    const server = new FakeServer();
    const tab = () => new EmergencyOutbox({ store, send: server.sender(), now: () => T0, policy: { claimRenewMs: 0 } });
    const [a, b] = [tab(), tab()];
    const same = await Promise.all([a.write("Help", { owner: "p1" }), b.write("help", { owner: "p1" })]);
    expect(same.filter((r) => r.duplicate)).toHaveLength(1);
    const different = await Promise.all([a.write("Fire", { owner: "p2" }), b.write("Smoke", { owner: "p2" })]);
    expect(different.filter((r) => r.held)).toHaveLength(1);
  });
});

describe("EmergencyOutbox: exactly once", () => {
  it("publishes once when the server's answer is lost", async () => {
    const clock = { t: T0 };
    const server = new FakeServer();
    const emergency = new EmergencyOutbox({ store: new MemoryStore(), send: server.sender({ loseResponses: 1 }), now: () => clock.t, policy: { claimRenewMs: 0 } });
    await emergency.write("Safe now", { owner: "p1" });
    await emergency.outbox.flush();
    clock.t += MIN;
    await emergency.outbox.flush();
    expect(server.created).toHaveLength(1);
    expect(await emergency.outbox.list()).toEqual([]);
  });

  it("can be cancelled for an SMS hand-off only while it never left the device", async () => {
    const { emergency, clock } = setup({ send: async () => { throw new TypeError("offline"); } });
    const queued = await emergency.write("Call me", { owner: "p1" });
    const other = await emergency.write("Second", { owner: "p1", writtenAt: T0 });
    expect(await emergency.outbox.cancel(other.item.key)).toBe("cancelled");
    await emergency.outbox.flush();
    clock.t += MIN;
    expect(await emergency.outbox.cancel(queued.item.key)).toBe("in_flight");
  });
});

describe("EmergencyOutbox: input", () => {
  it("accepts trimmed text up to maxLength and refuses anything else", async () => {
    const { emergency } = setup({ maxLength: 10 });
    await expect(emergency.write("   ")).rejects.toThrow(/empty/);
    await expect(emergency.write("x".repeat(11))).rejects.toThrow(/at most 10/);
    await expect(emergency.write(42 as unknown as string)).rejects.toThrow(/string/);
    expect((await emergency.write("  ok  ")).item.payload).toEqual({ text: "ok" });
    expect((await emergency.write("ok")).item.kind).toBe(EMERGENCY_KIND);
  });

  it("refuses bad options", () => {
    const base = { store: new MemoryStore<EmergencyMessage>(), send: async () => ({ type: "sent" as const }) };
    expect(() => new EmergencyOutbox({ ...base, autoSend: "some" as "all" })).toThrow(RangeError);
    expect(() => new EmergencyOutbox({ ...base, dedupeWithinMs: -1 })).toThrow(RangeError);
    expect(() => new EmergencyOutbox({ ...base, maxLength: 0 })).toThrow(RangeError);
  });

  it("compares words without case, edge spaces or repeated spaces", () => {
    expect(sameWords("  Need   HELP\n now ")).toBe("need help now");
  });
});

describe("smsLink", () => {
  it("uses the standard form for one recipient", () => {
    expect(smsLink("+1 (415) 555-0199", "Need help & water")).toBe("sms:+14155550199?body=Need%20help%20%26%20water");
  });

  it("uses each platform's form for several recipients", () => {
    expect(smsLink(["+14155550199", "+14155550198"], "Hi")).toBe("sms:+14155550199,+14155550198?body=Hi");
    expect(smsLink(["+14155550199", "+14155550198"], "Hi", { platform: "ios" })).toBe("sms://open?addresses=+14155550199,+14155550198&body=Hi");
  });

  it("refuses anything that is not a phone number", () => {
    expect(() => smsLink("call me", "x")).toThrow(TypeError);
    expect(() => smsLink([], "x")).toThrow(TypeError);
    expect(() => smsLink("+1555?body=evil", "x")).toThrow(TypeError);
  });
});
