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
const pwChrome = () => { try { return chromium.executablePath(); } catch { return null; } }; // playwright's own download, if installed
const CHROME = [process.env.CHROME_PATH, "/opt/pw-browsers/chromium-1194/chrome-linux/chrome", "/opt/pw-browsers/chromium/chrome-linux/chrome", pwChrome()].find((p) => p && fs.existsSync(p));
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

/* invite-only play: the host creates a lobby and gets a link; the guest opens the link and joins */
async function hostLobby(page, { stakeWei = "1000000000000000" } = {}) {
  await page.click(`[data-act=stake][data-v="${stakeWei}"]`);
  await page.click("#createBtn");
  await page.waitForSelector("#inviteLink", { timeout: 15000 });
  const link = await page.inputValue("#inviteLink");
  assert.match(link, /\/play\/\?join=[A-Z2-9]{8}$/, "invite link has a join code");
  return link;
}
async function openInvite(page, link) {
  await page.goto(link + "&test=1");
}
async function joinInvite(page) {
  await page.waitForSelector("#joinBtn", { timeout: 15000 });
  await page.click("#joinBtn");
}
async function pair(host, guest, opts) {
  const link = await hostLobby(host, opts);
  await openInvite(guest, link);
  await joinInvite(guest);
  return link;
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

  assert.equal(await a.locator("#findBtn").count(), 0, "no public matchmaking button");
  const link = await hostLobby(a);
  assert.equal(await view(a), "waiting");
  assert.match(await text(a, "#hw"), /Waiting for your opponent/);
  assert.match(await text(a, "main [data-until]"), /^\d+(s|:\d\d)$/, "the lobby expiry shows a time");
  await shot(a, "02b-waiting-1280");
  await a.setViewportSize({ width: 360, height: 780 });
  assert.ok(await noOverflow(a), "the waiting room fits 360px");
  await a.setViewportSize({ width: 1280, height: 900 });

  // a signed-out visitor sees who invited them on the sign-in screen
  const v = await open(t);
  await openInvite(v, link);
  await until(async () => /invited/i.test(await text(v, "main")), "invite banner on the sign-in screen");
  assert.ok(await v.locator("#signBurner").isVisible());
  await shot(v, "02c-invite-signedout-1280");
  assert.deepEqual(v.errors, [], "no errors for the signed-out visitor");
  await v.context().close();

  await openInvite(b, link);
  await b.waitForSelector("#joinBtn", { timeout: 15000 });
  assert.match(await text(b, "#hi"), /invited/i);
  await shot(b, "02d-invite-1280");
  await b.setViewportSize({ width: 360, height: 780 });
  assert.ok(await noOverflow(b), "the invite screen fits 360px");
  await b.setViewportSize({ width: 1280, height: 900 });
  await joinInvite(b);
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
  await a.click('[data-go="wallet"]'); // withdrawals live on the wallet page
  await a.waitForSelector("#wdAmt");
  await a.fill("#wdAmt", "0.5");
  await a.click("#wdBtn");
  await until(async () => (await a.locator('[aria-label="Recent withdrawals"]').innerText()).includes("confirmed"), "withdrawal confirmed", 20000);
  assert.equal(await stack.provider.getBalance(addr), parseEther("0.5"), "the winnings arrived on-chain");
  await until(async () => (await text(a, "#balAvail")) === "0.5008", "balance after withdrawal");
  await shot(a, "08-wallet-after-1280");
  await a.setViewportSize({ width: 360, height: 900 });
  assert.ok(await noOverflow(a), "wallet fits 360px");
  await a.click('[data-go="lobby"]');
  await a.waitForSelector("#createBtn");
  assert.ok(await noOverflow(a), "lobby fits 360px");
  await shot(a, "09-lobby-360");

  for (const p of [a, b]) assert.deepEqual(p.errors, [], "no console or page errors");
  const audit = stack.app.ledger.audit();
  assert.deepEqual(audit.problems, []);
});

test("reload restores the waiting room; closed links are refused; a reload mid-match cannot resume it; forfeit pays the opponent", { skip: !CHROME && "no Chromium available" }, async () => {
  const a = await open(), b = await open();
  await Promise.all([signInAndFund(a), signInAndFund(b)]);

  // ---- reload while hosting restores the waiting room; cancelling refunds and kills the link
  const old = await hostLobby(a);
  await a.reload();
  await until(async () => (await view(a)) === "waiting", "waiting room restored after reload");
  assert.equal(await a.inputValue("#inviteLink"), old, "same invite link after reload");
  await a.click("#closeLobby");
  await until(async () => (await view(a)) === "lobby", "back in the lobby");
  await until(async () => (await text(a, "#balAvail")) === "1", "stake returned");
  await openInvite(b, old);
  await b.waitForSelector("#inviteBack", { timeout: 15000 });
  assert.equal(await b.locator("#joinBtn").count(), 0, "a closed lobby cannot be joined");
  await b.click("#inviteBack");
  await until(async () => (await view(b)) === "lobby", "guest back in the lobby");

  // ---- the invite link pairs the two friends; reload mid-match
  await pair(a, b);
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
  await pair(b, a); // roles swapped: b hosts this time
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

test("Back to lobby keeps the lobby open; the red Cancel button only appears for an open lobby, and cancels it with a refund", { skip: !CHROME && "no Chromium available" }, async () => {
  const a = await open();
  await signInAndFund(a);
  const funded = await text(a, "#balAvail");

  // no open lobby yet: there is nothing to cancel, so no Cancel button
  await a.click('[data-act=stake][data-v="1000000000000000"]');
  assert.equal(await a.locator("#cancelBtn").count(), 0, "no Cancel button before a lobby is live");

  // open lobby: "Back to lobby" in the waiting room leaves it open, and the same red button closes it and returns the stake
  await hostLobby(a);
  await a.click("#backToLobby");
  await until(async () => (await view(a)) === "lobby", "back on the lobby page");
  assert.ok(await a.evaluate(() => !!window.__duel.S.host), "the lobby stays open after going back");
  await a.waitForSelector("#cancelBtn");
  assert.match(await text(a, "#cancelBtn"), /Cancel open lobby/);
  await a.click("#cancelBtn");
  await until(() => a.evaluate(() => !window.__duel.S.host), "open lobby closed");
  await until(async () => (await text(a, "#balAvail")) === funded, "stake refunded");
  assert.ok(await a.isEnabled("#createBtn"), "a new lobby can be created");
  await shot(a, "11-cancel-lobby-1280");

  assert.deepEqual(a.errors, []);
  assert.deepEqual(stack.app.ledger.audit().problems, []);
});
