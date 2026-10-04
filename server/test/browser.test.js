/* The reference browser client, driven in real Chromium against the dev stack (local chain + server):
   two browsers sign in with burner wallets, get test ETH sent on-chain to their deposit addresses, play each other
   with the real game pack, and one withdraws the winnings on-chain. Invite lobbies hold 2 to 10 players: guests join
   through the link (joining puts them in the lobby), the host presses Start match, and everyone plays the same challenge.
   Further tests cover three browsers (a tied top score = "Shared win"), leaving / cancelling, and a full ten-player lobby
   (two browsers plus eight API players). Screenshots go to test/shots/. */
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { parseEther, Wallet } from "ethers";
import { startDevStack } from "../scripts/dev-stack.js";
import { DuelClient } from "../client/duel-client.js";
import { ACCT } from "../src/ledger.js";

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
/* a page that fades in on arrival (#main.pg-enter) is photographed once it has settled, so shots never catch it half-drawn */
const shot = async (page, name) => {
  await page.waitForFunction(() => !document.getElementById("main")?.classList.contains("pg-enter"), null, { timeout: 3000 }).catch(() => {});
  return page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true });
};
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
/* joining puts the guest in the lobby (the guest room); it does not start a match */
async function joinInvite(page) {
  await page.waitForSelector("#joinBtn", { timeout: 15000 });
  await page.click("#joinBtn");
  await page.waitForSelector("#leaveLobby", { timeout: 15000 });
}
/* the host presses Start match once the roster has at least two players */
async function startMatch(host) {
  await until(() => host.locator("#startLobby").isEnabled(), "Start match enabled once a second player is in");
  await host.click("#startLobby");
}
async function pair(host, guest, opts) {
  const link = await hostLobby(host, opts);
  await openInvite(guest, link);
  await joinInvite(guest);
  await startMatch(host);
  return link;
}
/* the lobby roster as the page shows it: [{ name, tags: ["HOST", "YOU"], you }] */
const roster = (page) => page.$$eval("#plList li", (lis) => lis.map((li) => ({
  name: li.querySelector(".mx-pname").innerText.trim(),
  tags: [...li.querySelectorAll(".lb-chip-s")].map((c) => c.innerText.trim().toUpperCase()),
  you: li.classList.contains("you"),
})));
const rosterSize = (page, n) => until(async () => (await roster(page)).length === n, `${n} players in the list`);
/* the result screen's placement list (3+ players): [{ place: "1st", name, score: "4000", note, you }] in the order shown */
const standings = (page) => page.$$eval("[data-test=placements] li", (lis) => lis.map((li) => ({
  place: li.querySelector(".mx-place").innerText.trim(),
  name: li.querySelector(".mx-pname").innerText.replace(/\s*YOU\s*$/i, "").trim(),
  score: li.querySelector(".mx-pn").innerText.trim(),
  note: li.querySelector(".mx-pscore small").innerText.trim(),
  you: li.classList.contains("you"),
})));
const placeNo = (r) => parseInt(r.place, 10);
/* a funded player that talks to the server directly (no browser): joins lobbies, readies up, submits scores */
let creditSeq = 0;
async function apiPlayer(name, eth = 1) {
  const wallet = Wallet.createRandom();
  const client = new DuelClient({ baseUrl: stack.url, address: wallet.address, sign: (m) => wallet.signMessage(m) });
  await client.login();
  await client.connect();
  const wei = parseEther(String(eth)), n = ++creditSeq;
  stack.app.ledger.post({ kind: "deposit", ref: `ui-${n}`, uniq: `ui-deposit:${n}`, entries: [[ACCT.chain, -wei], [ACCT.user(client.me.id), wei]] });
  await client.api("PATCH", "/v1/me", { displayName: name });
  return { client, name, id: client.me.id };
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
  assert.match(await text(a, "#hw"), /Waiting for players/i);
  assert.match(await text(a, "main [data-until]"), /^\d+(s|:\d\d)$/, "the lobby expiry shows a time");
  assert.match(await text(a, "#lobbyPlayers h2"), /^PLAYERS\s+1 \/ 10$/, "the Players label counts the seats");
  assert.deepEqual(await roster(a), [{ name: await a.evaluate(() => window.__duel.S.me.displayName), tags: ["HOST", "YOU"], you: true }], "the host is listed, tagged HOST and YOU");
  assert.ok(await a.locator("#startLobby").isDisabled(), "Start match is disabled with one player");
  assert.match(await text(a, "#startHint"), /Waiting for at least one more player/);
  assert.ok(await a.locator("#closeLobby").isVisible() && await a.locator("#backToLobby").isVisible() && await a.locator("#copyInvite").isVisible(), "link, copy, cancel and back are still there");
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
  assert.match(await text(b, "#lobbyPlayers h2"), /^PLAYERS\s+1 \/ 10$/, "the invite page shows how many are in");
  assert.deepEqual((await roster(b)).map((r) => r.tags), [["HOST"]], "a guest sees the host, tagged HOST");
  await shot(b, "02d-invite-1280");
  await b.setViewportSize({ width: 360, height: 780 });
  assert.ok(await noOverflow(b), "the invite screen fits 360px");
  await b.setViewportSize({ width: 1280, height: 900 });
  await joinInvite(b);

  // joining puts the guest in the lobby: nobody is in a match yet, and both rosters show two players
  assert.equal(await view(b), "waiting", "the guest waits in the lobby");
  assert.equal(await view(a), "waiting", "the host's room stays open");
  assert.match(await text(b, "#hw"), /You.re in/i);
  assert.match(await text(b, "main .mx-lede"), /Waiting for .+ to start/i);
  await Promise.all([a, b].map((p) => rosterSize(p, 2)));
  assert.deepEqual((await roster(b)).map((r) => r.tags), [["HOST"], ["YOU"]], "the guest sees HOST and their own YOU row");
  assert.deepEqual((await roster(a)).map((r) => r.tags), [["HOST", "YOU"], []], "the host sees the guest appear without a reload");
  assert.match(await text(a, "#startLobby"), /Start match · 2 players/i);
  assert.ok(await a.locator("#startLobby").isEnabled(), "Start match turns on with two players");
  assert.equal(await b.locator("#startLobby").count(), 0, "only the host can start");
  assert.match(await text(b, "#leaveLobby"), /Leave lobby and refund my stake/i);
  await shot(a, "02e-waiting-2players-1280");
  await shot(b, "02f-guest-room-1280");
  await b.setViewportSize({ width: 360, height: 780 });
  assert.ok(await noOverflow(b), "the guest room fits 360px");
  await shot(b, "02g-guest-room-360");
  await b.setViewportSize({ width: 1280, height: 900 });
  await a.click("#startLobby");
  await Promise.all([a, b].map((p) => p.waitForSelector("#readyBtn", { timeout: 15000 })));
  await shot(a, "03-found-1280");
  assert.match(await text(a, "#hf"), /Opponent found/i);
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
  assert.equal((await text(a, "[data-test=result]")).trim().toLowerCase(), "victory");
  assert.equal((await text(b, "[data-test=result]")).trim().toLowerCase(), "defeat");
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
  await until(async () => (await a.locator('[aria-label="Recent withdrawals"]').innerText()).toLowerCase().includes("confirmed"), "withdrawal confirmed", 20000);
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
  assert.match(await text(a, "main"), /cannot be resumed/i);
  await shot(a, "10-orphan-1280");
  await a.click("#forfeitNow");
  await Promise.all([a, b].map((p) => p.waitForSelector("[data-test=result]", { timeout: 15000 })));
  assert.equal((await text(a, "[data-test=result]")).trim().toLowerCase(), "defeat");
  assert.equal((await text(b, "[data-test=result]")).trim().toLowerCase(), "victory");
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
  assert.equal((await text(b, "[data-test=result]")).trim().toLowerCase(), "defeat");

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
  assert.match(await text(a, "#cancelBtn"), /Cancel open lobby/i);
  await a.click("#cancelBtn");
  await until(() => a.evaluate(() => !window.__duel.S.host), "open lobby closed");
  await until(async () => (await text(a, "#balAvail")) === funded, "stake refunded");
  assert.ok(await a.isEnabled("#createBtn"), "a new lobby can be created");
  await shot(a, "11-cancel-lobby-1280");

  assert.deepEqual(a.errors, []);
  assert.deepEqual(stack.app.ledger.audit().problems, []);
});

test("three browsers in one lobby: everyone sees the live player list, the host starts, a tied top score is a shared win", { skip: !CHROME && "no Chromium available" }, async () => {
  const a = await open(), b = await open(), c = await open();
  await Promise.all([a, b, c].map((p) => signInAndFund(p)));
  const link = await hostLobby(a); // 0.001 each
  const names = await Promise.all([a, b, c].map((p) => p.evaluate(() => window.__duel.S.me.displayName)));

  // two guests join through the link; the roster follows live on every page
  await openInvite(b, link);
  await joinInvite(b);
  await rosterSize(a, 2);
  await openInvite(c, link);
  await c.waitForSelector("#joinBtn", { timeout: 15000 });
  assert.match(await text(c, "#lobbyPlayers h2"), /^PLAYERS\s+2 \/ 10$/, "the invite page counts the two who are already in");
  assert.deepEqual((await roster(c)).map((r) => r.tags), [["HOST"], []]);
  assert.match(await text(c, "#lobbyTerms"), /pot · 2 players/i, "the terms show the pot for the players in so far");
  await joinInvite(c);
  await Promise.all([a, b, c].map((p) => rosterSize(p, 3)));
  for (const p of [a, b, c]) {
    assert.match(await text(p, "#lobbyPlayers h2"), /^PLAYERS\s+3 \/ 10$/);
    const rows = await roster(p);
    assert.equal(rows.filter((r) => r.you).length, 1, "exactly one row is marked YOU");
    assert.deepEqual(rows.map((r) => r.name).sort(), [...names].sort(), "every page lists the same three players");
    assert.deepEqual(rows.filter((r) => r.tags.includes("HOST")).map((r) => r.name), [names[0]], "the host is tagged HOST");
    assert.equal(await view(p), "waiting", "nobody is in a match until the host starts");
  }
  assert.match(await text(a, "#startLobby"), /Start match · 3 players/i);
  assert.match(await text(a, "#plPot"), /0\.003\sETH.*0\.0027\sETH/, "pot and winner payout follow the player count");
  assert.match(await text(a, "#lobbyTerms"), /pot · 3 players/i);
  await shot(a, "12-waiting-3players-1280");
  await shot(c, "12b-guest-3players-1280");
  for (const p of [a, c]) {
    await p.setViewportSize({ width: 360, height: 780 });
    assert.ok(await noOverflow(p), "the lobby with three players fits 360px");
    await p.setViewportSize({ width: 1280, height: 900 });
  }

  // the host starts: all three get the found screen with the ready list
  await a.click("#startLobby");
  await Promise.all([a, b, c].map((p) => p.waitForSelector("#readyBtn", { timeout: 15000 })));
  for (const p of [a, b, c]) {
    assert.match(await text(p, "#hf"), /Match found/i);
    assert.equal(await p.locator("#fdList li").count(), 3, "the found screen lists all three players");
  }
  assert.match(await text(a, "#fdCount"), /0 \/ 3 ready/i);
  await shot(a, "13-found-3players-1280");
  await a.setViewportSize({ width: 360, height: 780 });
  assert.ok(await noOverflow(a), "the found screen with three players fits 360px");
  await a.setViewportSize({ width: 1280, height: 900 });
  await a.click("#readyBtn");
  await until(async () => /1 \/ 3 ready/i.test(await text(b, "#fdCount")), "the others see a get ready");
  assert.ok(await b.locator("#readyBtn").isEnabled(), "the list updates in place: b can still press Ready");
  await Promise.all([b.click("#readyBtn"), c.click("#readyBtn")]);

  // play: a and b react equally fast (a tie for the top), c is slower
  await Promise.all([a, b, c].map((p) => until(() => p.evaluate(() => !!window.__duel.ctx), "game", 30000)));
  assert.equal(await a.locator("#race .mx-lane").count(), 3, "the race has a lane for you and one for each other player");
  await a.setViewportSize({ width: 360, height: 780 });
  assert.ok(await noOverflow(a), "playing with three players fits 360px");
  await shot(a, "14-playing-3players-360");
  await a.setViewportSize({ width: 1280, height: 900 });
  await Promise.all([autoplay(a, 200), autoplay(b, 200), autoplay(c, 500)]);
  await Promise.all([a, b, c].map((p) => p.waitForSelector("[data-test=result]", { timeout: 15000 })));
  assert.equal((await text(a, "[data-test=result]")).trim().toLowerCase(), "shared win");
  assert.equal((await text(b, "[data-test=result]")).trim().toLowerCase(), "shared win");
  assert.equal((await text(c, "[data-test=result]")).trim().toLowerCase(), "defeat");
  for (const p of [a, b, c]) {
    const rows = await standings(p);
    assert.equal(rows.length, 3, "the result lists every player");
    assert.deepEqual(rows.map((r) => r.score), ["4000", "4000", "2500"], "scores, best first");
    assert.deepEqual([rows[0].place, rows[1].place], ["1st", "1st"], "tied top scores share first place");
    assert.notEqual(rows[2].place, "1st");
    assert.equal(rows.filter((r) => r.you).length, 1, "You is highlighted once");
    assert.deepEqual(rows.map((r) => r.name).sort(), [...names].sort());
  }
  assert.equal((await standings(c))[2].you, true, "the slower player is the last row");
  assert.match(await text(a, "main"), /shared/i);
  await shot(a, "15-result-shared-1280");
  await shot(c, "16-result-3players-loss-1280");
  await a.setViewportSize({ width: 360, height: 780 });
  assert.ok(await noOverflow(a), "the three-player result fits 360px");
  await shot(a, "17-result-3players-360");
  await a.setViewportSize({ width: 1280, height: 900 });

  // money: pot 0.003, the winners split 0.0027 (0.00135 each), c lost the 0.001 stake
  await Promise.all([a, b, c].map((p) => p.click("#backBtn")));
  await until(async () => (await text(a, "#balAvail")) === "1.00035", "tied winner a: 1 - 0.001 + 0.00135");
  await until(async () => (await text(b, "#balAvail")) === "1.00035", "tied winner b");
  await until(async () => (await text(c, "#balAvail")) === "0.999", "loser c");
  for (const p of [a, b, c]) assert.deepEqual(p.errors, [], "no console or page errors");
  assert.deepEqual(stack.app.ledger.audit().problems, []);
});

test("a guest can leave and is refunded; Back to lobby and a reload keep a guest in the lobby; the host's cancel refunds everyone", { skip: !CHROME && "no Chromium available" }, async () => {
  const a = await open(), b = await open(), c = await open();
  await Promise.all([a, b, c].map((p) => signInAndFund(p)));
  const link = await hostLobby(a);
  await openInvite(b, link); await joinInvite(b);
  await openInvite(c, link); await joinInvite(c);
  await Promise.all([a, b, c].map((p) => rosterSize(p, 3)));

  // leaving the page does not drop a guest: the lobby page offers the way back, and the stake stays held
  await b.click("#backToLobby");
  await until(async () => (await view(b)) === "lobby", "b on the lobby page");
  assert.equal(await b.evaluate(() => window.__duel.S.lobby.role), "guest", "b is still in the lobby");
  await b.waitForSelector(".lb-open");
  assert.match(await text(b, ".lb-open"), /You are in a lobby/i);
  assert.match(await text(b, ".lb-open"), /3 \/ 10/);
  assert.match(await text(b, ".lb-open [data-act=go-waiting]"), /Show my lobby/i);
  assert.equal(await b.locator("#cancelBtn").count(), 0, "a guest cannot cancel the host's lobby");
  assert.match(await text(b, "#leaveBtn"), /Leave lobby and refund my stake/i);
  assert.ok(await b.isDisabled("#createBtn"), "someone in a lobby cannot create another");
  await until(async () => (await text(b, "#balAvail")) === "0.999", "b's stake is held while in the lobby");
  await shot(b, "18-guest-lobby-page-1280");
  assert.ok(await b.locator("#openLobby").isVisible(), "the top bar offers the guest's lobby too");
  await b.click("#openLobby");
  await b.waitForSelector("#leaveLobby");
  assert.equal((await roster(b)).length, 3);
  await b.click("#backToLobby");
  await b.waitForSelector(".lb-open");
  await b.click(".lb-open [data-act=go-waiting]");
  await b.waitForSelector("#leaveLobby");

  // a reload restores the guest room (the server knows where the guest is)
  await b.reload();
  await until(async () => (await view(b)) === "waiting", "the guest room is restored after a reload");
  await b.waitForSelector("#leaveLobby");
  await rosterSize(b, 3);
  assert.equal(await b.locator("#startLobby").count(), 0, "a guest never sees Start match");

  // a guest leaves: refunded, gone from the host's list
  await c.click("#leaveLobby");
  await until(async () => (await view(c)) === "lobby", "c back on the lobby page");
  await until(async () => (await text(c, "#balAvail")) === "1", "c's stake came back");
  assert.equal(await c.evaluate(() => window.__duel.S.lobby), null);
  assert.doesNotMatch(await text(c, "#toasts"), /host closed/i, "leaving is not reported as the host closing the lobby");
  await Promise.all([a, b].map((p) => rosterSize(p, 2)));
  assert.match(await text(a, "#startLobby"), /Start match · 2 players/i);
  assert.equal(await view(a), "waiting");

  // c can come back through the same link
  await openInvite(c, link); await joinInvite(c);
  await Promise.all([a, b, c].map((p) => rosterSize(p, 3)));

  // the host cancels: every guest is told, sent to the lobby page and refunded
  await a.click("#closeLobby");
  await until(async () => (await view(a)) === "lobby", "host back on the lobby page");
  await Promise.all([b, c].map(async (p) => {
    await until(async () => (await view(p)) === "lobby", "guest sent back to the lobby page");
    await until(async () => (await text(p, "#balAvail")) === "1", "guest refunded");
    assert.equal(await p.evaluate(() => window.__duel.S.lobby), null);
  }));
  await until(async () => (await text(a, "#balAvail")) === "1", "host refunded");
  assert.equal(await b.locator(".lb-open").count(), 0, "no lobby card once it is closed");
  await openInvite(c, link);
  await c.waitForSelector("#inviteBack", { timeout: 15000 });
  assert.equal(await c.locator("#joinBtn").count(), 0, "a closed lobby cannot be joined");
  assert.match(await text(c, "main"), /closed/i);
  for (const p of [a, b, c]) assert.deepEqual(p.errors, [], "no console or page errors");
  assert.deepEqual(stack.app.ledger.audit().problems, []);
});

test("a full ten-player lobby starts by itself: nine names on the invite page, ten in the ready list, a compact race, standings with shared places", { skip: !CHROME && "no Chromium available" }, async () => {
  const a = await open(), b = await open();
  await Promise.all([signInAndFund(a), signInAndFund(b)]);
  const link = await hostLobby(a);
  const code = link.match(/join=([A-Z0-9]+)/)[1];
  const guests = [];
  try {
    for (let i = 1; i <= 8; i++) guests.push(await apiPlayer(`Guest${i}`));
    for (const g of guests) await g.client.api("POST", `/v1/lobbies/${code}/join`, {});

    // the host's room with nine players, then the invite page for the tenth
    await rosterSize(a, 9);
    assert.match(await text(a, "#lobbyPlayers h2"), /^PLAYERS\s+9 \/ 10$/);
    assert.match(await text(a, "#startLobby"), /Start match · 9 players/i);
    assert.ok(await a.locator("#startLobby").isEnabled());
    await shot(a, "19-waiting-9players-1280");
    await a.setViewportSize({ width: 360, height: 780 });
    assert.ok(await noOverflow(a), "the host room with nine players fits 360px");
    await shot(a, "19b-waiting-9players-360");
    await a.setViewportSize({ width: 1280, height: 900 });

    await openInvite(b, link);
    await b.waitForSelector("#joinBtn", { timeout: 15000 });
    assert.equal((await roster(b)).length, 9, "the invite page lists the nine who are in");
    assert.match(await text(b, "#lobbyPlayers h2"), /^PLAYERS\s+9 \/ 10$/);
    assert.ok(await b.locator("#joinBtn").isEnabled(), "one seat is left, so Join works");
    await shot(b, "20-invite-9players-1280");
    await b.setViewportSize({ width: 360, height: 780 });
    assert.ok(await noOverflow(b), "the invite page with nine players fits 360px");
    await b.setViewportSize({ width: 1280, height: 900 });

    // b takes the last seat: the lobby is full and the match starts without anyone pressing Start
    await b.click("#joinBtn");
    await Promise.all([a, b].map((p) => p.waitForSelector("#readyBtn", { timeout: 15000 })));
    for (const p of [a, b]) {
      assert.equal(await p.locator("#fdList li").count(), 10, "the found screen lists all ten players");
      assert.match(await text(p, "#fdCount"), /0 \/ 10 ready/i);
    }
    const matchId = await a.evaluate(() => window.__duel.S.match.id);
    assert.equal(await a.evaluate(() => window.__duel.S.match.players.length), 10);
    await shot(a, "21-found-10players-1280");
    await a.setViewportSize({ width: 360, height: 780 });
    assert.ok(await noOverflow(a), "the found screen with ten players fits 360px");
    await shot(a, "21b-found-10players-360");
    await a.setViewportSize({ width: 1280, height: 900 });

    // everyone readies up (the API players over the socket)
    const found = await Promise.all(guests.map((g) => g.client.waitFor("match.found", (m) => m.match.id === matchId)));
    await Promise.all([a.click("#readyBtn"), b.click("#readyBtn"), ...guests.map((g) => g.client.ready(matchId))]);
    const starts = await Promise.all(guests.map((g) => g.client.waitFor("match.start", (m) => m.matchId === matchId)));
    await Promise.all([a, b].map((p) => until(() => p.evaluate(() => !!window.__duel.ctx), "game", 30000)));
    const wait = starts[0].startAt - guests[0].client.serverNow();
    if (wait > 0) await sleep(wait + 50);

    // the race: a lane for you and nine others, scores arrive by seat, a forfeit reads "Out"
    assert.equal(await a.locator("#race .mx-lane").count(), 10);
    assert.equal(await a.locator("#race.many").count(), 1, "ten players use the compact race");
    const seat = (i) => found[i].match.you.seat;
    guests[0].client.progress(matchId, 1234);
    await until(async () => (await a.locator(`#race .mx-lane[data-seat="${seat(0)}"] .mx-n`).innerText()) === "1234", "guest 1's live score shows on its lane");
    await guests[7].client.forfeit(matchId);
    await until(async () => (await a.locator(`#race .mx-lane[data-seat="${seat(7)}"] .mx-n`).innerText()) === "Out", "a forfeit shows as Out");
    assert.match(await text(a, "#playNote"), /1 player forfeited/i);
    await shot(a, "22-playing-10players-1280");
    await a.setViewportSize({ width: 360, height: 780 });
    assert.ok(await noOverflow(a), "playing with ten players fits 360px");
    await shot(a, "22b-playing-10players-360");
    await a.setViewportSize({ width: 1280, height: 900 });

    // scores: guests 1-2 tie for first; a (4000) ties with guest 4; b (2500) ties with guest 6; guest 8 forfeited
    const scores = [6000, 6000, 5000, 4000, 3000, 2500, 1000];
    await Promise.all(guests.slice(0, 7).map((g, i) => g.client.submit(matchId, scores[i])));
    await Promise.all([autoplay(a, 200), autoplay(b, 500)]);
    await Promise.all([a, b].map((p) => p.waitForSelector("[data-test=result]", { timeout: 20000 })));
    assert.equal((await text(a, "[data-test=result]")).trim().toLowerCase(), "defeat");
    assert.equal((await text(b, "[data-test=result]")).trim().toLowerCase(), "defeat");
    for (const p of [a, b]) {
      const rows = await standings(p);
      assert.equal(rows.length, 10, "the result lists all ten players");
      assert.deepEqual(rows.slice(0, 9).map((r) => r.score), ["6000", "6000", "5000", "4000", "4000", "3000", "2500", "2500", "1000"]);
      assert.deepEqual([rows[0].place, rows[1].place], ["1st", "1st"], "tied top scores share first place");
      assert.equal(rows[3].place, rows[4].place, "a tie in the middle shares a place");
      assert.equal(rows[6].place, rows[7].place);
      for (let i = 1; i < 9; i++) assert.equal(rows[i].score === rows[i - 1].score, rows[i].place === rows[i - 1].place, `row ${i + 1}: equal scores share a place, different scores do not`);
      for (let i = 1; i < rows.length; i++) assert.ok(placeNo(rows[i]) >= placeNo(rows[i - 1]), "places never go back up");
      assert.match(rows[9].note, /Forfeited/i, "the player who forfeited is last and says so");
      assert.equal(rows.filter((r) => r.you).length, 1, "You is highlighted once");
    }
    await shot(a, "23-result-10players-1280");
    await a.setViewportSize({ width: 360, height: 780 });
    assert.ok(await noOverflow(a), "the ten-player result fits 360px");
    await shot(a, "23b-result-10players-360");
    await a.setViewportSize({ width: 1280, height: 900 });
    for (const p of [a, b]) assert.deepEqual(p.errors, [], "no console or page errors");
    assert.deepEqual(stack.app.ledger.audit().problems, []);
  } finally {
    for (const g of guests) g.client.close();
  }
});

test("forfeiting a three-player match: the match goes on for the others, you wait in a forfeited state (also after a reload), and the result lists you as forfeited", { skip: !CHROME && "no Chromium available" }, async () => {
  const a = await open();
  await signInAndFund(a);
  const link = await hostLobby(a);
  const code = link.match(/join=([A-Z0-9]+)/)[1];
  const guests = [];
  try {
    for (const n of ["Guest1", "Guest2"]) guests.push(await apiPlayer(n));
    for (const g of guests) await g.client.api("POST", `/v1/lobbies/${code}/join`, {});
    await rosterSize(a, 3);
    await a.click("#startLobby");
    await a.waitForSelector("#readyBtn", { timeout: 15000 });
    const matchId = await a.evaluate(() => window.__duel.S.match.id);
    const mySeat = await a.evaluate(() => window.__duel.S.match.you.seat);
    await Promise.all([a.click("#readyBtn"), ...guests.map((g) => g.client.ready(matchId))]);
    const starts = await Promise.all(guests.map((g) => g.client.waitFor("match.start", (m) => m.matchId === matchId)));
    await until(() => a.evaluate(() => !!window.__duel.ctx), "game a", 30000);
    const wait = starts[0].startAt - guests[0].client.serverNow();
    if (wait > 0) await sleep(wait + 50);

    // a forfeits: the match does not end, and a is not sent back to the lobby
    await a.click("#forfeitBtn");
    await a.click("#forfeitYes");
    await until(async () => /You forfeited/i.test(await text(a, "#playNote")), "the forfeited state is shown");
    assert.equal(await view(a), "play", "the forfeiter stays in the match until it ends");
    assert.match(await text(a, "#forfeitArea"), /You forfeited/i);
    assert.equal(await a.locator("#forfeitBtn").count(), 0, "no second Forfeit button");
    assert.ok(await a.locator("#stage").isHidden(), "the stopped game is not left on screen");
    assert.equal(await a.locator("#race .mx-lane.you .mx-n").innerText(), "Out");
    await shot(a, "24-forfeited-3players-1280");
    const told = await Promise.all(guests.map((g) => g.client.waitFor("match.opponent_forfeited", (m) => m.matchId === matchId)));
    for (const t of told) assert.equal(t.seat, mySeat, "the others are told which seat forfeited");

    // a reload while the match is still going: the forfeited state comes back (no Forfeit button to press twice)
    await a.reload();
    await until(async () => (await view(a)) === "orphan", "orphan view after the reload");
    assert.match(await text(a, "#forfeitedNote"), /You forfeited/i);
    assert.equal(await a.locator("#forfeitNow").count(), 0);
    await shot(a, "25-forfeited-orphan-1280");

    // the others finish; the result arrives for the forfeiter too
    await guests[0].client.submit(matchId, 3000);
    await guests[1].client.submit(matchId, 1000);
    await a.waitForSelector("[data-test=result]", { timeout: 20000 });
    assert.equal((await text(a, "[data-test=result]")).trim().toLowerCase(), "defeat");
    const rows = await standings(a);
    assert.equal(rows.length, 3);
    assert.deepEqual(rows.map((r) => r.score), ["3000", "1000", "–"]);
    assert.equal(rows[2].you, true, "the forfeiter is the last row");
    assert.match(rows[2].note, /Forfeited/i);
    assert.deepEqual(a.errors, []);
    assert.deepEqual(stack.app.ledger.audit().problems, []);
  } finally {
    for (const g of guests) g.client.close();
  }
});
