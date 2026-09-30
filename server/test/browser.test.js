/* The reference browser client, driven in real Chromium against the dev stack (local chain + server):
   two browsers sign in with burner wallets, get test ETH sent on-chain to their deposit addresses, play each other
   with the real game pack, and one withdraws the winnings on-chain. Screenshots go to test/shots/. */
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { parseEther } from "ethers";
import { startDevStack } from "../scripts/dev-stack.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const SHOTS = path.join(here, "shots");
const CHROME = ["/opt/pw-browsers/chromium-1194/chrome-linux/chrome", "/opt/pw-browsers/chromium/chrome-linux/chrome", process.env.CHROME_PATH].find((p) => p && fs.existsSync(p));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let stack, browser;
before(async () => {
  if (!CHROME) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  stack = await startDevStack({
    memory: true, quiet: true,
    overrides: { match: { countdownMs: 1200, acceptMs: 20000, queueTimeoutMs: 30000, pairIntervalMs: 100, durationScale: 0.5 }, rate: { authPerMin: 1000, apiPerMin: 100000, wsPerSec: 200 } },
  });
  browser = await chromium.launch({ executablePath: CHROME, args: ["--no-sandbox"] });
});
after(async () => {
  if (browser) await browser.close();
  if (stack) await stack.stop();
});

/* a signed-in player in its own browser context, with error collection */
async function open(t, { width = 1280, height = 900 } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height } });
  const page = await ctx.newPage();
  page.errors = [];
  page.on("pageerror", (e) => page.errors.push("pageerror: " + e.message));
  page.on("console", (m) => { if (m.type() === "error" && !/fonts\.g|ERR_FAILED|favicon/.test(m.text() + (m.location().url || ""))) page.errors.push("console: " + m.text()); });
  await page.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
  await page.goto(`${stack.url}/play/?test=1`);
  return page;
}
const shot = (page, name) => page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true });
const view = (page) => page.evaluate(() => (window.__duel ? window.__duel.S.view : null));
const until = async (fn, label, ms = 15000) => {
  const end = Date.now() + ms;
  for (;;) {
    try { const v = await fn(); if (v) return v; } catch { /* page navigating */ }
    if (Date.now() > end) throw new Error("timed out: " + label);
    await sleep(80);
  }
};
const noOverflow = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
const text = (page, sel) => page.locator(sel).first().innerText();

async function signInAndFund(page, eth = 1) {
  await page.click("#signBurner");
  await page.waitForSelector("#faucetBtn");
  await page.click("#faucetBtn");
  await until(async () => parseFloat(await text(page, "#balAvail")) >= eth, "test ETH credited to the balance");
}

async function joinFor(page, { stakeWei = "1000000000000000", code = "" } = {}) {
  await page.click(`[data-act=stake][data-v="${stakeWei}"]`);
  if (code) await page.fill("#code", code);
  const adult = page.locator("#adult");
  if (await adult.count()) await adult.check();
  await page.click("#findBtn");
}

/* play the current reaction game by firing each round with the given reaction time until the match ends */
async function autoplay(page, ms) {
  await until(() => page.evaluate(() => !!(window.__duel.ctx && window.__duel.ctx.test)), "the game to start", 20000);
  await until(async () => {
    const v = await view(page);
    if (v === "result") return true;
    await page.evaluate((m) => { const c = window.__duel.ctx; return c && c.test && c.test.fire(m); }, ms).catch(() => {});
    return false;
  }, "the match to finish", 40000);
}

test("two browsers: sign in, fund on-chain, play each other, win, withdraw on-chain", { skip: !CHROME && "no Chromium available" }, async (t) => {
  const a = await open(t), b = await open(t);
  await shot(a, "01-signin-1280");
  assert.equal(await view(a), null, "not signed in yet");
  await Promise.all([signInAndFund(a), signInAndFund(b)]);
  assert.equal(await text(a, "#balAvail"), "1");
  await shot(a, "02-lobby-1280");
  assert.ok(await noOverflow(a));

  await Promise.all([joinFor(a), joinFor(b)]);
  await until(async () => (await view(a)) === "queue" || (await view(a)) === "found", "queue");
  await Promise.all([a, b].map((p) => p.waitForSelector("#readyBtn", { timeout: 15000 })));
  await shot(a, "03-found-1280");
  assert.match(await text(a, "#hf"), /Opponent found/);
  assert.match(await text(a, "main [data-until]"), /^\d+(s|:\d\d)$/, "the accept countdown shows a time straight away");
  await a.setViewportSize({ width: 360, height: 780 });
  assert.ok(await noOverflow(a), "the found screen fits 360px");
  await shot(a, "03b-found-360");
  await a.setViewportSize({ width: 1280, height: 900 });
  await Promise.all([a.click("#readyBtn"), b.click("#readyBtn")]);

  await until(() => a.evaluate(() => window.__duel.S.view === "play"), "play view");
  await until(() => a.locator("#countdown .big").count().then((n) => n > 0), "countdown", 5000).catch(() => {}); // may already be over
  await Promise.all([until(() => a.evaluate(() => !!window.__duel.ctx), "game a"), until(() => b.evaluate(() => !!window.__duel.ctx), "game b")]);
  await a.setViewportSize({ width: 360, height: 780 });
  assert.ok(await noOverflow(a), "no horizontal scroll while playing at 360px");
  await shot(a, "04-playing-360");
  await a.setViewportSize({ width: 1280, height: 900 });

  await Promise.all([autoplay(a, 200), autoplay(b, 500)]); // A reacts faster → higher score
  await Promise.all([a, b].map((p) => p.waitForSelector("[data-test=result]", { timeout: 15000 })));
  assert.equal((await text(a, "[data-test=result]")).trim(), "Victory");
  assert.equal((await text(b, "[data-test=result]")).trim(), "Defeat");
  await shot(a, "05-result-win-1280");
  await shot(b, "06-result-loss-1280");
  await a.setViewportSize({ width: 360, height: 780 });
  assert.ok(await noOverflow(a), "result screen fits 360px");
  await shot(a, "07-result-360");
  await a.setViewportSize({ width: 1280, height: 900 });

  // money: pot 0.002, winner gets 0.0018 (10% fee)
  await Promise.all([a.click("#backBtn"), b.click("#backBtn")]);
  await until(async () => (await text(a, "#balAvail")) === "1.0008", "winner balance 1.0008");
  await until(async () => (await text(b, "#balAvail")) === "0.999", "loser balance 0.999");

  // withdraw 0.5 to the winner's own burner address, on-chain
  const addr = await a.evaluate(() => window.__duel.client.address);
  assert.equal(await stack.provider.getBalance(addr), 0n);
  await a.fill("#wdAmt", "0.5");
  await a.click("#wdBtn");
  await until(async () => (await a.locator('[aria-label="Recent withdrawals"]').innerText()).includes("confirmed"), "withdrawal confirmed", 20000);
  assert.equal(await stack.provider.getBalance(addr), parseEther("0.5"), "the winnings arrived on-chain");
  await until(async () => (await text(a, "#balAvail")) === "0.5008", "balance after withdrawal");
  await shot(a, "08-lobby-after-1280");
  await a.setViewportSize({ width: 360, height: 900 });
  assert.ok(await noOverflow(a), "lobby fits 360px");
  await shot(a, "09-lobby-360");

  for (const p of [a, b]) assert.deepEqual(p.errors, [], "no console or page errors");
  const audit = stack.app.ledger.audit();
  assert.deepEqual(audit.problems, []);
});

test("reload restores the queue; a reload mid-match cannot resume it and offers forfeit; forfeit pays the opponent", { skip: !CHROME && "no Chromium available" }, async () => {
  const a = await open(), b = await open();
  await Promise.all([signInAndFund(a), signInAndFund(b)]);

  // ---- reload while queued
  await joinFor(a, { code: "RELOAD1" });
  await until(async () => (await view(a)) === "queue", "queued");
  await a.reload();
  await until(async () => (await view(a)) === "queue", "queue restored after reload");
  assert.match(await text(a, "#hq"), /Finding an opponent/);
  await a.click("#cancelQueue");
  await until(async () => (await view(a)) === "lobby", "back in the lobby");
  await until(async () => (await text(a, "#balAvail")) === "1", "stake returned");

  // ---- private code pairs the two friends; reload mid-match
  await Promise.all([joinFor(a, { code: "FRIENDS" }), joinFor(b, { code: "FRIENDS" })]);
  await Promise.all([a, b].map((p) => p.waitForSelector("#readyBtn", { timeout: 15000 })));
  await Promise.all([a.click("#readyBtn"), b.click("#readyBtn")]);
  await until(() => a.evaluate(() => !!window.__duel.ctx), "game a");
  await until(() => b.evaluate(() => !!window.__duel.ctx), "game b");
  await a.reload();
  await until(async () => (await view(a)) === "orphan", "orphan view after reload");
  assert.match(await text(a, "main"), /cannot be resumed/);
  await shot(a, "10-orphan-1280");
  await a.click("#forfeitNow");
  await Promise.all([a, b].map((p) => p.waitForSelector("[data-test=result]", { timeout: 15000 })));
  assert.equal((await text(a, "[data-test=result]")).trim(), "Defeat");
  assert.equal((await text(b, "[data-test=result]")).trim(), "Victory");
  assert.match(await text(b, "main"), /opponent forfeited/i);

  // ---- in-page forfeit confirmation (no browser dialogs)
  await Promise.all([a.click("#backBtn"), b.click("#backBtn")]);
  await Promise.all([joinFor(a, { code: "AGAIN22" }), joinFor(b, { code: "AGAIN22" })]);
  await Promise.all([a, b].map((p) => p.waitForSelector("#readyBtn", { timeout: 15000 })));
  await Promise.all([a.click("#readyBtn"), b.click("#readyBtn")]);
  await until(() => b.evaluate(() => !!window.__duel.ctx), "game b");
  await b.click("#forfeitBtn");
  assert.ok(await b.locator("#forfeitYes").isVisible(), "a confirmation appears in the page");
  await b.click("[data-act=forfeit-no]");
  assert.ok(await b.locator("#forfeitBtn").isVisible());
  await b.click("#forfeitBtn");
  await b.click("#forfeitYes");
  await Promise.all([a, b].map((p) => p.waitForSelector("[data-test=result]", { timeout: 15000 })));
  assert.equal((await text(b, "[data-test=result]")).trim(), "Defeat");

  for (const p of [a, b]) assert.deepEqual(p.errors, []);
  assert.deepEqual(stack.app.ledger.audit().problems, []);
});
