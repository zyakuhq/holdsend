// Browser scenarios for the emergency page (Chromium via Playwright). Each
// checks the server's own list of messages, not only the screen.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { chromium } from "playwright";
import { createNotesApp } from "../src/app.mjs";

export function runEmergencyScenarios() {
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

  async function openPage(context) {
    const page = await context.newPage();
    await page.goto(`${base}/emergency`);
    await page.waitForSelector("body[data-ready='true']");
    await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));
    return page;
  }

  const userOf = (page) => page.evaluate(() => localStorage.getItem("holdsend-notes-user"));

  async function received(user) {
    const res = await fetch(`${base}/api/emergency-messages`, { headers: { "x-demo-user": user } });
    return (await res.json()).messages.map((m) => m.text);
  }

  async function write(page, text) {
    await page.fill("#text", text);
    await page.click("#send");
    await page.waitForFunction(() => document.querySelector("#text").value === "");
  }

  const waiting = (page) =>
    page.evaluate(() => [...document.querySelectorAll("#outbox li")].map((li) => ({ text: li.querySelector(".note-text").textContent, held: li.dataset.held })));

  async function waitUntil(check, what, timeoutMs = 20_000) {
    const end = Date.now() + timeoutMs;
    for (;;) {
      if (await check()) return;
      if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  async function goOffline(context, page) {
    await context.setOffline(true);
    await page.waitForFunction(() => document.querySelector("#connection").dataset.online === "false");
  }

  test("emergency: says it is not an emergency service", async () => {
    const context = await browser.newContext();
    const page = await openPage(context);
    const text = await page.textContent(".disclaimer");
    assert.match(text, /not an emergency service/);
    assert.match(text, /call your local emergency number first/);
    await context.close();
  });

  test("emergency: the first message goes by itself, later ones wait for Send all", async () => {
    const context = await browser.newContext();
    const page = await openPage(context);
    const user = await userOf(page);

    await goOffline(context, page);
    await write(page, "Trapped on the roof");
    await write(page, "Water is rising");
    assert.deepEqual(await waiting(page), [
      { text: "Trapped on the roof", held: "false" },
      { text: "Water is rising", held: "true" },
    ]);
    assert.equal(await page.isVisible("#send-all"), true);

    await context.setOffline(false);
    await waitUntil(async () => (await received(user)).length === 1, "the first message to arrive");
    await new Promise((r) => setTimeout(r, 2500));
    assert.deepEqual(await received(user), ["Trapped on the roof"], "the held message must not be sent by itself");

    await page.click("#send-all");
    await waitUntil(async () => (await received(user)).length === 2, "the held message after Send all");
    await waitUntil(async () => (await waiting(page)).length === 0, "the queue to empty");
    assert.deepEqual((await received(user)).sort(), ["Trapped on the roof", "Water is rising"]);
    await context.close();
  });

  test("emergency: tapping Send again with the same words queues one message", async () => {
    const context = await browser.newContext();
    const page = await openPage(context);
    const user = await userOf(page);

    await goOffline(context, page);
    await write(page, "Need help at the bridge");
    await write(page, "need help at the bridge");
    await write(page, "  Need help at the bridge ");
    assert.equal((await waiting(page)).length, 1);
    assert.match(await page.textContent("#notice"), /already waiting/);

    await context.setOffline(false);
    await waitUntil(async () => (await received(user)).length === 1, "the message to arrive");
    await new Promise((r) => setTimeout(r, 2500));
    assert.deepEqual(await received(user), ["Need help at the bridge"]);
    await context.close();
  });

  test("emergency: an SMS hand-off takes the message out of the queue and can put it back", async () => {
    const context = await browser.newContext();
    const page = await openPage(context);
    const user = await userOf(page);

    await goOffline(context, page);
    await write(page, "Call me, battery low");
    await page.fill("#sms-number", "+1 (415) 555-0199");
    await page.click("#outbox button[data-action='sms']");
    await page.waitForSelector("#sms-handoff:not([hidden])");
    const href = await page.getAttribute("#sms-list .sms-link", "href");
    assert.match(href, /^sms:\+14155550199\?body=Call%20me%2C%20battery%20low/);
    assert.equal((await waiting(page)).length, 0);

    // Taken out of the queue: nothing goes by data when the connection returns.
    await context.setOffline(false);
    await page.waitForFunction(() => document.querySelector("#connection").dataset.online === "true");
    await new Promise((r) => setTimeout(r, 2500));
    assert.deepEqual(await received(user), []);

    // The person did not send the SMS after all: put it back, and it goes once.
    await page.click("#sms-list button[data-action='sms-undo']");
    await waitUntil(async () => (await received(user)).length === 1, "the message to arrive after being put back");
    assert.deepEqual(await received(user), ["Call me, battery low"]);
    await context.close();
  });

  test("emergency: a hand-off is still there after the page is closed and opened again", async () => {
    const context = await browser.newContext();
    const page = await openPage(context);
    const user = await userOf(page);

    await goOffline(context, page);
    await write(page, "Stuck at the station");
    await page.fill("#sms-number", "+1 415 555 0123");
    await page.click("#outbox button[data-action='sms']");
    await page.waitForSelector("#sms-list li");
    await page.close();

    // A new page (the old one was closed, or the browser killed it): the hand-off is shown again.
    const again = await openPage(context);
    await again.waitForSelector("#sms-list li");
    assert.match(await again.textContent("#sms-list li"), /Stuck at the station/);
    assert.match(await again.getAttribute("#sms-list .sms-link", "href"), /^sms:\+14155550123\?body=Stuck%20at%20the%20station/);
    assert.equal((await waiting(again)).length, 0);
    assert.deepEqual(await received(user), []);

    // Put it back: it goes once, and the hand-off disappears for good.
    await context.setOffline(false);
    await again.click("#sms-list button[data-action='sms-undo']");
    await waitUntil(async () => (await received(user)).length === 1, "the message to arrive after being put back");
    assert.equal(await again.locator("#sms-list li").count(), 0);
    await again.reload();
    await again.waitForSelector("body[data-ready='true']");
    assert.equal(await again.locator("#sms-list li").count(), 0);
    assert.deepEqual(await received(user), ["Stuck at the station"]);
    await context.close();
  });

  test("emergency: the page opens offline after a first visit", async () => {
    const context = await browser.newContext();
    const page = await openPage(context);
    await goOffline(context, page);
    await page.reload();
    await page.waitForSelector("body[data-ready='true']");
    assert.equal(await page.isVisible("#compose"), true);
    await context.close();
  });
}
