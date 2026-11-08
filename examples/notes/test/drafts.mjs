// Browser scenarios for the drafts page: one draft on two devices. Two browser
// contexts share one demo user, standing in for a phone and a laptop. Each
// check reads the server's own log, not only the screen.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { chromium } from "playwright";
import { createNotesApp } from "../src/app.mjs";

export function runDraftScenarios() {
  let notes;
  let server;
  let base;
  let browser;

  before(async () => {
    notes = await createNotesApp();
    server = await new Promise((resolve) => {
      const s = notes.app.listen(0, "127.0.0.1", () => resolve(s));
    });
    base = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch();
  });

  after(async () => {
    await browser?.close();
    await new Promise((resolve) => server?.close(resolve));
    await notes?.close();
  });

  /** A device signed in as `user` (a made-up id, as the demo does). */
  async function device(user, options = {}) {
    const context = await browser.newContext(options);
    await context.addInitScript((id) => {
      if (!localStorage.getItem("holdsend-notes-user")) localStorage.setItem("holdsend-notes-user", id);
    }, user);
    const page = await context.newPage();
    await page.goto(`${base}/drafts`);
    await page.waitForSelector("body[data-ready='true']");
    return { context, page };
  }

  const newUser = () => `demo-${crypto.randomUUID()}`;

  async function serverLog(user) {
    const res = await fetch(`${base}/api/drafts/shared`, { headers: { "x-demo-user": user } });
    return (await res.json()).updates;
  }

  async function waitUntil(check, what, timeoutMs = 20_000) {
    const end = Date.now() + timeoutMs;
    for (;;) {
      if (await check()) return;
      if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  async function save(page, text) {
    const before = await page.evaluate(() => Number(document.body.dataset.saves ?? 0));
    await page.fill("#text", text);
    await page.click("#save");
    await page.waitForFunction((n) => Number(document.body.dataset.saves ?? 0) > n, before);
  }

  async function goOffline({ context, page }) {
    await context.setOffline(true);
    await page.waitForFunction(() => document.querySelector("#connection").dataset.online === "false");
  }

  async function goOnline({ context }) {
    await context.setOffline(false);
  }

  const conflictVisible = (page) => page.evaluate(() => !document.querySelector("#conflict").hidden);
  const headTexts = (page) => page.evaluate(() => [...document.querySelectorAll("#heads .note-text")].map((n) => n.textContent));

  test("drafts: two offline edits from one device are one line, not a conflict", async () => {
    const user = newUser();
    const a = await device(user);
    await goOffline(a);
    await save(a.page, "first offline edit");
    await save(a.page, "second offline edit");
    await goOnline(a);
    await waitUntil(async () => (await serverLog(user)).length === 2, "both edits on the server");
    const log = await serverLog(user);
    assert.equal(log[1].baseId, log[0].id, "the second edit sits on the first");
    await a.page.waitForFunction(() => document.querySelector("#text").value === "second offline edit");
    assert.equal(await conflictVisible(a.page), false);
    await a.context.close();
  });

  test("drafts: an edit after a reload sits on the unsent edit from before it", async () => {
    const user = newUser();
    const a = await device(user, { serviceWorkers: "block" }); // so the route below sees every send
    // Sends fail (the server is unreachable) but the page can still reload.
    const block = (route) => (route.request().method() !== "GET" ? route.abort() : route.continue());
    await a.context.route("**/api/drafts**", block);
    await save(a.page, "unsent before reload");
    await a.page.reload();
    await a.page.waitForSelector("body[data-ready='true']");
    await save(a.page, "edit after reload");
    await a.context.unroute("**/api/drafts**", block);
    await a.page.evaluate(() => window.dispatchEvent(new Event("online")));
    await waitUntil(async () => (await serverLog(user)).length === 2, "both edits on the server");
    const log = await serverLog(user);
    assert.equal(log[1].baseId, log[0].id, "the edit after the reload sits on the first");
    assert.equal(await conflictVisible(a.page), false);
    await a.context.close();
  });

  test("drafts: two quick online saves are one line, not a conflict with itself", async () => {
    const user = newUser();
    const a = await device(user);
    await save(a.page, "quick one");
    await save(a.page, "quick two");
    await save(a.page, "quick three");
    await waitUntil(async () => (await serverLog(user)).length === 3, "three edits on the server");
    const log = await serverLog(user);
    assert.equal(log[1].baseId, log[0].id);
    assert.equal(log[2].baseId, log[1].id);
    await a.page.waitForFunction(() => document.querySelector("#text").value === "quick three");
    assert.equal(await conflictVisible(a.page), false);
    await a.context.close();
  });

  test("drafts: two devices edit offline, both versions are shown, a person chooses, nothing is lost", async () => {
    const user = newUser();
    const a = await device(user);
    await save(a.page, "shared start");
    await waitUntil(async () => (await serverLog(user)).length === 1, "the first edit on the server");
    const b = await device(user);
    await b.page.waitForFunction(() => document.querySelector("#text").value === "shared start");

    await goOffline(a);
    await goOffline(b);
    await save(a.page, "version from the phone");
    await save(b.page, "version from the laptop");
    await goOnline(a);
    await goOnline(b);

    await waitUntil(async () => (await serverLog(user)).length === 3, "both edits on the server");
    for (const d of [a, b]) {
      await waitUntil(() => conflictVisible(d.page), "the conflict screen");
      assert.deepEqual((await headTexts(d.page)).sort(), ["version from the laptop", "version from the phone"]);
    }

    // A person on the phone keeps the laptop's version.
    await a.page.click("#heads li:has-text('version from the laptop') button[data-action='keep']");
    await waitUntil(async () => (await serverLog(user)).length === 4, "the choice on the server");
    const log = await serverLog(user);
    const resolve = log[3];
    assert.equal(resolve.reason, "resolve");
    assert.equal(resolve.payload.text, "version from the laptop");
    assert.equal(resolve.resolves.length, 1);
    // The version that was not chosen is still in the history.
    assert.ok(log.some((u) => u.payload.text === "version from the phone"));
    assert.equal(resolve.resolves[0], log.find((u) => u.payload.text === "version from the phone").id);

    for (const d of [a, b]) {
      await waitUntil(async () => !(await conflictVisible(d.page)), "the conflict to close");
      await d.page.waitForFunction(() => document.querySelector("#text").value === "version from the laptop");
    }
    await a.context.close();
    await b.context.close();
  });

  test("drafts: a person can write a version that uses both", async () => {
    const user = newUser();
    const a = await device(user);
    await save(a.page, "base");
    await waitUntil(async () => (await serverLog(user)).length === 1, "the first edit on the server");
    const b = await device(user);
    await b.page.waitForFunction(() => document.querySelector("#text").value === "base");
    await goOffline(a);
    await goOffline(b);
    await save(a.page, "base plus apples");
    await save(b.page, "base plus pears");
    await goOnline(a);
    await goOnline(b);
    await waitUntil(() => conflictVisible(a.page), "the conflict screen");

    await a.page.fill("#combined", "base plus apples and pears");
    await a.page.click("#save-combined");
    await waitUntil(async () => (await serverLog(user)).length === 4, "the combined version on the server");
    const log = await serverLog(user);
    assert.equal(log[3].payload.text, "base plus apples and pears");
    assert.equal(log[3].resolves.length, 1);
    await waitUntil(async () => !(await conflictVisible(b.page)), "the conflict to close on the other device");
    await b.page.waitForFunction(() => document.querySelector("#text").value === "base plus apples and pears");
    await a.context.close();
    await b.context.close();
  });
}
