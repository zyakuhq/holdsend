// End-to-end: the Expo app's web build in a real browser (Chromium via
// Playwright), served by the notes example's server.
//
//   npm run export:web --workspace holdsend-example-expo
//   npm run e2e --workspace holdsend-example-expo
//
// The web build runs the same React Native code (KeyValueStore over
// AsyncStorage, NetInfo, AppState) through react-native-web. It is a check
// of the app's logic, not of a phone: Android and iOS still need a device or
// emulator (see README). Each test counts the server's notes.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createNotesApp } from "../../notes/src/app.mjs";

const dist = fileURLToPath(new URL("../dist-web", import.meta.url));
let notes;
let server;
let base;
let browser;

before(async () => {
  if (!existsSync(dist)) throw new Error("Run `npm run export:web --workspace holdsend-example-expo` first.");
  notes = await createNotesApp({ staticDir: dist });
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

const READY = "[data-testid='app'][data-ready='true']";

async function openPage(context) {
  const page = await context.newPage();
  await page.goto(base);
  await page.waitForSelector(READY);
  return page;
}

async function userOf(page) {
  // AsyncStorage on the web keeps values in localStorage.
  return page.evaluate(() => localStorage.getItem("holdsend-notes-user"));
}

async function serverNotes(user) {
  const res = await fetch(`${base}/api/notes`, { headers: { "x-demo-user": user } });
  return (await res.json()).notes;
}

async function write(page, text) {
  await page.fill("[data-testid='text']", text);
  await page.click("[data-testid='send']");
  await page.waitForFunction(
    (t) => [...document.querySelectorAll("[data-testid='note-text']")].some((n) => n.textContent === t),
    text,
  );
}

const outboxCount = (page) => page.locator("[data-testid='outbox-item']").count();

async function waitUntil(check, what, timeoutMs = 30_000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

test("offline: notes wait on the device and are published once when the connection returns", async () => {
  const context = await browser.newContext();
  const page = await openPage(context);
  const user = await userOf(page);
  await context.setOffline(true);
  await page.waitForFunction(() => document.querySelector("[data-testid='connection']")?.textContent.startsWith("Offline"));
  await write(page, "written with no signal");
  await write(page, "and a second one");
  assert.equal(await outboxCount(page), 2);
  assert.equal((await serverNotes(user)).length, 0);

  // Stay offline past the scheduler's early backoff steps, so a timely send
  // can only come from the reconnect signal, not from a timer.
  await new Promise((r) => setTimeout(r, 8000));
  await context.setOffline(false);
  await waitUntil(async () => (await serverNotes(user)).length === 2 && (await outboxCount(page)) === 0, "both notes, soon after reconnecting", 4000);
  await new Promise((r) => setTimeout(r, 3000));
  assert.deepEqual((await serverNotes(user)).map((n) => n.text).sort(), ["and a second one", "written with no signal"]);
  await context.close();
});

test("an app restart keeps what is waiting, and it is still published once", async () => {
  const context = await browser.newContext();
  const page = await openPage(context);
  const user = await userOf(page);
  // The server cannot be reached, but the app itself still loads.
  await page.route("**/api/notes", (route) => (route.request().method() === "POST" ? route.abort() : route.continue()));
  await write(page, "kept across a restart");
  await page.waitForTimeout(1500); // at least one failed attempt
  await page.reload();
  await page.waitForSelector(READY);
  assert.equal(await outboxCount(page), 1, "the note is still waiting after the restart");

  await page.unroute("**/api/notes");
  await waitUntil(async () => (await serverNotes(user)).length === 1 && (await outboxCount(page)) === 0, "the note to be published");
  await new Promise((r) => setTimeout(r, 3000));
  assert.equal((await serverNotes(user)).length, 1);
  await context.close();
});

test("a lost answer: the server saved the note, the app never heard back, and it is published once", async () => {
  const context = await browser.newContext();
  const page = await openPage(context);
  const user = await userOf(page);
  const lostBefore = notes.stats.answersLost;
  await page.click("[data-testid='lose-answer']");
  await page.waitForSelector("[data-testid='lose-answer-note']");
  await write(page, "its answer is lost");
  await waitUntil(async () => (await outboxCount(page)) === 0, "the retry to settle the note");
  await new Promise((r) => setTimeout(r, 3000));
  assert.equal(notes.stats.answersLost, lostBefore + 1, "the server really dropped one answer");
  assert.equal((await serverNotes(user)).filter((n) => n.text === "its answer is lost").length, 1);
  await context.close();
});

test("cancel: a note cancelled before it left the device is never published", async () => {
  const context = await browser.newContext();
  const page = await openPage(context);
  const user = await userOf(page);
  await context.setOffline(true);
  await page.waitForFunction(() => document.querySelector("[data-testid='connection']")?.textContent.startsWith("Offline"));
  await write(page, "changed my mind");
  await page.getByRole("button", { name: "Cancel: changed my mind" }).click();
  await waitUntil(async () => (await outboxCount(page)) === 0, "the note to be removed");
  await context.setOffline(false);
  await new Promise((r) => setTimeout(r, 3000));
  assert.equal((await serverNotes(user)).length, 0);
  await context.close();
});

test("a note the server refuses stops for the person, and Discard removes it without publishing", async () => {
  const context = await browser.newContext();
  const page = await openPage(context);
  const user = await userOf(page);
  // Longer than the server accepts; the input's limit only stops typing.
  await page.evaluate(() => document.querySelector("[data-testid='text']").removeAttribute("maxlength"));
  await page.fill("[data-testid='text']", "y".repeat(2100));
  await page.click("[data-testid='send']");
  await page.waitForSelector("[data-testid='outbox-item'][data-status='stuck']", { timeout: 30_000 });
  await page.getByRole("button", { name: /^Discard:/ }).click();
  await waitUntil(async () => (await outboxCount(page)) === 0, "the note to be discarded");
  assert.equal((await serverNotes(user)).length, 0);
  await context.close();
});
