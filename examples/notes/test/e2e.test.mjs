// End-to-end: the notes example in a real browser (Chromium via Playwright).
//
//   npm run e2e            (from the repository root, after npm run build)
//
// Each test checks the server's own list of notes, so "exactly once" is
// checked where it matters, not only on screen.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { chromium } from "playwright";
import { createNotesApp } from "../src/app.mjs";

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
  await page.goto(base);
  await page.waitForSelector("body[data-ready='true']");
  // Let the service worker install, so the page also loads offline.
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));
  return page;
}

const userOf = (page) => page.evaluate(() => localStorage.getItem("holdsend-notes-user"));

async function serverNotes(user) {
  const res = await fetch(`${base}/api/notes`, { headers: { "x-demo-user": user } });
  return (await res.json()).notes;
}

async function write(page, text) {
  await page.fill("#text", text);
  await page.click("#send");
  await page.waitForFunction((t) => [...document.querySelectorAll("#outbox .note-text, #feed .note-text")].some((n) => n.textContent === t), text);
}

async function waitUntil(check, what, timeoutMs = 20_000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

const outboxCount = (page) => page.evaluate(() => document.querySelectorAll("#outbox li").length);

test("airplane mode: notes survive an offline reload and are published once when the connection returns", async () => {
  const context = await browser.newContext();
  const page = await openPage(context);
  const user = await userOf(page);

  await context.setOffline(true);
  await page.waitForFunction(() => document.querySelector("#connection").dataset.online === "false");
  await write(page, "written in a tunnel");
  await write(page, "and another one");
  assert.equal(await outboxCount(page), 2);

  // Reload with no network: the service worker serves the page, IndexedDB still has the notes.
  await page.reload();
  await page.waitForSelector("body[data-ready='true']");
  assert.equal(await outboxCount(page), 2);
  assert.equal((await serverNotes(user)).length, 0);

  await context.setOffline(false);
  await waitUntil(async () => (await serverNotes(user)).length === 2 && (await outboxCount(page)) === 0, "both notes to be published");
  // Give any late duplicate (a background sync, a second pass) the chance to show up.
  await new Promise((r) => setTimeout(r, 3000));
  const texts = (await serverNotes(user)).map((n) => n.text).sort();
  assert.deepEqual(texts, ["and another one", "written in a tunnel"]);
  await page.waitForSelector("#feed li");
  await context.close();
});

test("a lost answer: the server saved the note but the browser never heard back, and it is still published once", async () => {
  const context = await browser.newContext();
  const page = await openPage(context);
  const user = await userOf(page);

  await page.click("summary"); // "Try to break it"
  await page.click("#lose-answer");
  await page.waitForFunction(() => document.querySelector("#lose-answer-note").textContent.length > 0);
  await write(page, "the answer to this one is lost");

  await waitUntil(async () => (await outboxCount(page)) === 0, "the retry to settle the note");
  await new Promise((r) => setTimeout(r, 3000));
  assert.equal(notes.stats.answersLost, 1, "the server really dropped one answer");
  const mine = (await serverNotes(user)).filter((n) => n.text === "the answer to this one is lost");
  assert.equal(mine.length, 1);
  await context.close();
});

test("two tabs offline, then back online together: every note is published once", async () => {
  const context = await browser.newContext();
  const a = await openPage(context);
  const b = await openPage(context);
  const user = await userOf(a);
  assert.equal(await userOf(b), user);

  await context.setOffline(true);
  for (let n = 0; n < 3; n += 1) {
    await write(a, `tab A note ${n}`);
    await write(b, `tab B note ${n}`);
  }
  await context.setOffline(false);

  await waitUntil(async () => (await serverNotes(user)).length === 6 && (await outboxCount(a)) === 0, "all six notes");
  await new Promise((r) => setTimeout(r, 3000));
  const texts = (await serverNotes(user)).map((n) => n.text).sort();
  assert.deepEqual(texts, ["tab A note 0", "tab A note 1", "tab A note 2", "tab B note 0", "tab B note 1", "tab B note 2"]);
  await context.close();
});

test("the written time is kept apart from the arrival time, and the feed is ordered by arrival", async () => {
  const context = await browser.newContext();
  const page = await openPage(context);
  const user = await userOf(page);
  await write(page, "sent just now");
  await waitUntil(async () => (await serverNotes(user)).length === 1, "the first note");

  // A note written a day ago (an old draft) arrives after it.
  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const res = await fetch(`${base}/api/notes`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-demo-user": user, "Idempotency-Key": `old-draft-${Date.now()}`, "Written-At": dayAgo },
    body: JSON.stringify({ text: "written yesterday" }),
  });
  assert.equal(res.status, 201);

  const list = await serverNotes(user);
  assert.deepEqual(
    list.map((n) => n.text),
    ["written yesterday", "sent just now"],
    "newest arrival first, whatever the written time",
  );
  assert.equal(list[0].writtenAt, dayAgo, "the written time is kept as sent");
  assert.ok(Date.parse(list[0].arrivedAt) > Date.parse(list[0].writtenAt), "arrival time is the server's own");

  await page.reload();
  await page.waitForSelector("body[data-ready='true']");
  const shown = await page.$$eval("#feed .note-text", (nodes) => nodes.map((n) => n.textContent));
  assert.deepEqual(shown, ["written yesterday", "sent just now"]);
  await context.close();
});

test("a request without a key is refused instead of saved without protection", async () => {
  const res = await fetch(`${base}/api/notes`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-demo-user": "demo-no-key-0001" },
    body: JSON.stringify({ text: "no key" }),
  });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).code, "key_required");
});

test("after an offline reload, the published list is still shown", async () => {
  const context = await browser.newContext();
  const page = await openPage(context);
  await write(page, "published before the tunnel");
  await page.waitForFunction(() => [...document.querySelectorAll("#feed .note-text")].some((n) => n.textContent === "published before the tunnel"));
  await context.setOffline(true);
  await page.reload();
  await page.waitForSelector("body[data-ready='true']");
  const shown = await page.$$eval("#feed .note-text", (nodes) => nodes.map((n) => n.textContent));
  assert.deepEqual(shown, ["published before the tunnel"]);
  await context.close();
});
