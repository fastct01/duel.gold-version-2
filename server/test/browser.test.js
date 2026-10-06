/* The reference browser client, driven in real Chromium against the dev stack (local chain + server):
   two browsers sign in with their own wallets, get test ETH sent on-chain to their deposit addresses, play each other
   with the real game pack, and one withdraws the winnings on-chain. Invite lobbies hold 2 to 10 players: guests join
   through the link (joining puts them in the lobby), the host presses Start match, and everyone plays the same challenge.
   Further tests cover three browsers (a tied top score = "Shared win"), leaving / cancelling, and a full ten-player lobby
   (two browsers plus eight API players). The client is invite-only (no queue, no matchmaking, no player search) and asks for an
   18+ confirmation before the first staked create / join; a mainnet-mode test overrides GET /v1/config in the browser to check the
   real-money wording, the network badge, the deposit / withdraw copy and the withdraw confirm step. Screenshots go to test/shots/. */
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
    overrides: { match: { countdownMs: 1200, acceptMs: 20000, durationScale: 0.5 }, rate: { authPerMin: 1000, apiPerMin: 100000, wsPerSec: 200 } },
  });
  browser = await chromium.launch({ executablePath: CHROME, args: ["--no-sandbox"] });
});
after(async () => {
  if (browser) await browser.close();
  if (stack) await stack.stop();
});

/* a minimal EIP-1193 browser wallet (stands in for MetaMask): one key per browser context, signs with the page's own ethers.
   window.__wallet records every request and lets a test steer it: .chainId (the network the wallet is on), .account (another selected account),
   .reject (the player closes the popup: code 4001), .unknownChain (the wallet has never heard of the chain: code 4902). */
function mockWallet(pk) {
  let w;
  const wallet = () => (w ||= new window.ethers.Wallet(pk));
  const st = (window.__wallet = { chainId: "0x7a69", account: null, reject: false, unknownChain: false, calls: [] });
  window.ethereum = {
    async request({ method, params = [] }) {
      st.calls.push({ method, params });
      switch (method) {
        case "eth_requestAccounts": case "eth_accounts": return [st.account || wallet().address];
        case "eth_chainId": return st.chainId;
        case "net_version": return String(parseInt(st.chainId, 16));
        case "personal_sign": return wallet().signMessage(window.ethers.getBytes(params[0]));
        case "wallet_switchEthereumChain":
          if (st.unknownChain) throw Object.assign(new Error("Unrecognized chain ID."), { code: 4902 });
          st.chainId = params[0].chainId;
          return null;
        case "eth_sendTransaction":
          if (st.reject) throw Object.assign(new Error("User rejected the request."), { code: 4001 });
          return "0x" + "cd".repeat(32); // a fake hash: nothing is broadcast
        case "eth_getTransactionReceipt": return null;
        default: throw Object.assign(new Error(`unsupported method ${method}`), { code: 4200 });
      }
    },
    on() {}, removeListener() {},
  };
}

/* a signed-in player in its own browser context, with error collection */
async function open(t, { width = 1280, height = 900 } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height } });
  await ctx.addInitScript(mockWallet, Wallet.createRandom().privateKey);
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
  await page.click("#signInjected");
  await page.waitForSelector("#faucetBtn");
  await page.click("#faucetBtn");
  await until(async () => parseFloat(await text(page, "#balAvail")) >= eth, "test ETH credited to the balance");
}

/* The 18+ dialog: shown before a player's first staked create / join (never for free play). Tick the box and confirm; the action the
   player was after then carries on by itself. `next` is what shows once it has. Returns true if the dialog appeared. */
async function passAge(page, next) {
  await page.waitForSelector(`#ageCheck, ${next}`, { timeout: 15000 });
  if (!(await page.locator("#ageCheck").count())) return false;
  await page.check("#ageCheck");
  await page.click("#ageConfirm");
  await page.waitForSelector("#ageCheck", { state: "detached", timeout: 10000 });
  return true;
}

/* invite-only play: the host creates a lobby and gets a link; the guest opens the link and joins */
async function hostLobby(page, { stakeWei = "1000000000000000" } = {}) {
  await page.click(`[data-act=stake][data-v="${stakeWei}"]`);
  await page.click("#createBtn");
  await passAge(page, "#inviteLink");
  await page.waitForSelector("#inviteLink", { timeout: 15000 });
  const link = await page.inputValue("#inviteLink");
  assert.match(link, /^https?:\/\/[^/]+\/\?join=[A-Z2-9]{8}$/, "invite link is the site root with a join code");
  return link;
}
async function openInvite(page, link) {
  await page.goto(link + "&test=1");
}
/* joining puts the guest in the lobby (the guest room); it does not start a match */
async function joinInvite(page) {
  await page.waitForSelector("#joinBtn", { timeout: 15000 });
  await page.click("#joinBtn");
  await passAge(page, "#leaveLobby");
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
  await client.api("POST", "/v1/me/age", { adult: true }); // staked lobbies need the 18+ confirmation
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
  assert.match(await text(a, ".testnote"), /Test network only/i, "a test network says so on the sign-in page");
  assert.ok(await a.locator("#netTag").isVisible(), "the network badge is there before sign-in too");
  await Promise.all([signInAndFund(a), signInAndFund(b)]);
  assert.equal(await text(a, "#balAvail"), "1");
  await shot(a, "02-lobby-1280");
  assert.ok(await noOverflow(a));

  assert.equal(await a.locator("#findBtn, [data-act=find], [data-act=cancel-queue]").count(), 0, "no public matchmaking button");

  // the network badge: persistent, names the chain; this stack is a local chain, so it speaks of test money, not real money
  const cfg = await a.evaluate(() => window.__duel.S.cfg);
  assert.equal(cfg.chain.realMoney, false, "the test stack is not real money");
  assert.match(await text(a, "#netTag"), new RegExp(cfg.chain.name.split(/[\s(]/)[0], "i"), "the badge names the chain");
  assert.equal(await a.locator("#netTag.real").count(), 0, "a test network gets the quiet badge");
  assert.match(await text(a, "#lbSetup"), /test network/i, "the stake label says test network");
  assert.ok(await a.locator("#faucetBtn").isVisible(), "the faucet is offered on the local chain");

  // 18+ confirmation: the first staked create asks, nothing is created until the player confirms, and Not now backs out cleanly
  await a.click('[data-act=stake][data-v="1000000000000000"]');
  await a.click("#createBtn");
  await a.waitForSelector("#ageCheck");
  assert.match(await text(a, "#ageText"), /adults only/i);
  assert.ok(await a.locator('[role=dialog][aria-modal=true]').isVisible(), "the confirmation is an in-page dialog");
  assert.ok(await a.locator("#ageConfirm").isDisabled(), "Confirm waits for the tick");
  assert.equal(await a.evaluate(() => document.activeElement.id), "ageCheck", "focus moves into the dialog");
  assert.equal(await a.evaluate(() => document.getElementById("main").inert), true, "the page behind it is inert");
  await sleep(450); // let the dialog's fade-in finish, then photograph the viewport (the dialog is fixed, a full-page shot would smear it)
  await a.screenshot({ path: path.join(SHOTS, "01b-age-dialog-1280.png") });
  await a.setViewportSize({ width: 360, height: 780 });
  assert.ok(await noOverflow(a), "the age dialog fits 360px");
  await a.setViewportSize({ width: 1280, height: 900 });
  await a.keyboard.press("Escape");
  await a.waitForSelector("#ageCheck", { state: "detached" });
  assert.equal(await a.evaluate(() => window.__duel.S.lobby), null, "no lobby was created without the confirmation");
  assert.equal(await a.evaluate(() => document.activeElement.id), "createBtn", "focus goes back to Create lobby");
  assert.equal(await a.evaluate(() => window.__duel.S.me.responsible.adultConfirmed), false);
  const link = await hostLobby(a); // asks again, this time the player confirms
  assert.equal(await view(a), "waiting");
  assert.equal(await a.evaluate(() => window.__duel.S.me.responsible.adultConfirmed), true, "the confirmation is saved on the account");
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
  assert.ok(await v.locator("#signInjected").isVisible());
  await shot(v, "02c-invite-signedout-1280");
  assert.deepEqual(v.errors, [], "no errors for the signed-out visitor");
  await v.context().close();

  await openInvite(b, link);
  await b.waitForSelector("#joinBtn", { timeout: 15000 });
  assert.match(await text(b, "#hi"), /invited/i);
  assert.match(await text(b, "#lobbyPlayers h2"), /^PLAYERS\s+1 \/ 10$/, "the invite page shows how many are in");
  assert.deepEqual((await roster(b)).map((r) => r.tags), [["HOST"]], "a guest sees the host, tagged HOST");
  assert.match(await text(b, ".mx-terms"), /18 or older/i, "a staked invite says the age confirmation comes first");
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

  // withdraw 0.5 to the winner's own wallet address, on-chain
  const addr = await a.evaluate(() => window.__duel.client.address);
  assert.equal(await stack.provider.getBalance(addr), 0n);
  await a.click('[data-go="wallet"]'); // withdrawals live on the wallet page
  await a.waitForSelector("#wdAmt");
  await a.fill("#wdAmt", "0.5");
  await a.click("#wdBtn");
  // a network that names a fee asks for one more confirmation (amount, fee, what arrives); a free local chain goes straight through
  if (await a.locator("#wdConfirmBtn").count() || await a.waitForSelector("#wdConfirmBtn", { timeout: 1500 }).then(() => true, () => false)) {
    assert.match(await text(a, "#wdConfirmBox"), /You receive/i);
    await a.click("#wdConfirmBtn");
  }
  await until(async () => (await a.locator("#txList .tx-wd").allInnerTexts()).join(" ").toLowerCase().includes("confirmed"), "withdrawal confirmed", 20000);
  assert.equal(await stack.provider.getBalance(addr), parseEther("0.5"), "the winnings arrived on-chain");
  await until(async () => (await text(a, "#balAvail")) === "0.5008", "balance after withdrawal");
  await shot(a, "08-wallet-after-1280");
  await a.setViewportSize({ width: 360, height: 900 });
  assert.ok(await noOverflow(a), "wallet fits 360px");
  await a.setViewportSize({ width: 1280, height: 900 });
  await a.click('#nav [data-go="settings"]');
  await a.waitForSelector("#ageStatus");
  assert.equal(await a.getAttribute("#ageStatus", "data-confirmed"), "yes");
  assert.match(await text(a, "#ageStatus"), /Confirmed/i, "the Account page shows the age status");
  await a.setViewportSize({ width: 360, height: 900 });
  assert.ok(await noOverflow(a), "the account page fits 360px");
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

  // free play never asks for the 18+ confirmation
  await a.click('[data-act=stake][data-v="0"]');
  await a.click("#createBtn");
  await a.waitForSelector("#inviteLink", { timeout: 15000 });
  assert.equal(await a.locator("#ageCheck").count(), 0, "a free lobby is created without the age dialog");
  assert.equal(await a.evaluate(() => window.__duel.S.me.responsible.adultConfirmed), false, "and nothing was confirmed behind the player's back");
  await a.click("#closeLobby");
  await until(async () => (await view(a)) === "lobby", "back in the lobby after closing the free lobby");

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
    await passAge(b, "#readyBtn");
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

/* every top-bar piece sits inside the viewport and no two pieces overlap (the badge sits beside the wordmark on wide screens and under it on phones, so
   this compares real rectangles; the wordmark is measured by its text, not by its full-height link box). The page hides horizontal overflow, so noOverflow() cannot see this. */
const topFits = (page) => page.evaluate(() => {
  const W = window.innerWidth, vis = (el) => el && el.getClientRects().length > 0;
  const brand = document.querySelector(".top-brand"), range = document.createRange();
  range.selectNodeContents(brand);
  const named = [["wordmark", range.getBoundingClientRect()]];
  for (const el of document.querySelectorAll("#topNet > *, #topRight > *")) if (vis(el)) named.push([el.id || el.className || el.tagName, el.getBoundingClientRect()]);
  const inside = named.every(([, r]) => r.left >= -0.5 && r.right <= W + 0.5);
  const overlaps = [];
  for (let i = 0; i < named.length; i++) for (let k = i + 1; k < named.length; k++) {
    const [na, a] = named[i], [nb, b] = named[k];
    if (a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5) overlaps.push(`${na} / ${nb}`);
  }
  return { inside, apart: overlaps.length === 0, overlaps };
});

test("invite-only: no queue, no matchmaking and no player search anywhere in the client", { skip: !CHROME && "no Chromium available" }, async () => {
  const a = await open();
  await a.click("#signInjected");
  await a.waitForSelector("#createBtn");
  const BANNED = /matchmaking|find(ing)? an? opponent|random opponent|\bqueue\b|search (for )?(players?|opponents?|users?)|find players?|challenge a player/i;
  const pages = [["lobby", "lobby"], ["games", "games"], ["game/reaction", "game"], ["join", "join"], ["tournaments", "tournaments"], ["history", "history"], ["wallet", "wallet"], ["settings", "settings"]];
  for (const [hash, tab] of pages) {
    await a.evaluate((h) => { location.hash = h; }, hash);
    await until(() => a.evaluate((t) => window.__duel.S.tab === t && document.body.dataset.tab === t, tab), `the ${tab} page`);
    await sleep(150);
    assert.doesNotMatch(await a.evaluate(() => document.body.innerText), BANNED, `${tab}: no queue, matchmaking or player search wording`);
    assert.equal(await a.locator('[data-act="find"], [data-act="cancel-queue"], #findBtn, #cancelQueue, .mx-queue, [data-go="leaderboard"]').count(), 0, `${tab}: no queue or leaderboard controls`);
    // the only search box filters the game library (games, not people)
    const boxes = await a.$$eval('input[type=search], input[placeholder*="earch" i], input[placeholder*="player" i], input[placeholder*="opponent" i]', (els) => els.map((e) => ({ id: e.id, label: (document.querySelector(`label[for="${e.id}"]`) || {}).innerText || "" })));
    for (const b of boxes) assert.deepEqual([b.id, b.label.trim()], ["lbSearch", "Search games"], `${tab}: the only search field is the game filter`);
    assert.notEqual(await view(a), "queue");
  }
  assert.equal(await a.locator("#lbSearch").count(), 0, "the game filter is only on the library page");

  // the server side agrees: no public queue in the config, no queue command in the SDK or on the socket
  const { cfg, hasSdkQueue, refused } = await a.evaluate(async () => ({
    cfg: window.__duel.S.cfg,
    hasSdkQueue: typeof window.__duel.client.joinQueue !== "undefined" || typeof window.__duel.client.leaveQueue !== "undefined",
    refused: await window.__duel.client.request("queue.join", { game: "reaction", stake: "0" }).then(() => null, (e) => e.code || "refused"),
  }));
  assert.equal("publicQueue" in cfg.match, false, "the config has no publicQueue flag");
  assert.equal(hasSdkQueue, false, "the SDK has no queue methods");
  assert.ok(refused, "the socket refuses queue.join");
  assert.deepEqual(a.errors, []);
});

test("mainnet mode (GET /v1/config and /v1/wallet overridden in the browser): real-money wording, network badge, deposit and withdraw copy, no faucet", { skip: !CHROME && "no Chromium available" }, async () => {
  let MIN = "5000000000000000";
  const ago = (days, hour) => { const d = new Date(); d.setDate(d.getDate() - days); d.setHours(hour, 0, 0, 0); return d.getTime(); }; // that many days back at that hour (so day groups do not depend on the time of day)
  const FEE = "300000000000000", ADDR_EXPLORER = "https://etherscan.io", H = (c) => "0x" + c.repeat(32);
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await ctx.addInitScript(mockWallet, Wallet.createRandom().privateKey);
  const a = await ctx.newPage();
  a.errors = [];
  a.on("pageerror", (e) => a.errors.push("pageerror: " + e.message));
  a.on("console", (m) => { if (m.type() === "error" && !/fonts\.g|ERR_FAILED|favicon/.test(m.text() + (m.location().url || ""))) a.errors.push("console: " + m.text()); });
  await a.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
  const chain = (c) => ({ ...c, id: 1, name: "Ethereum Mainnet", explorer: ADDR_EXPLORER, confirmations: 12, network: "mainnet", realMoney: true }); // id 1: the wallet starts on the local chain, so a deposit has to switch it
  await a.route("**/v1/config", async (route) => {
    const res = await route.fetch(), j = await res.json();
    delete j.devFaucet;
    await route.fulfill({ response: res, json: { ...j, network: "mainnet", chain: chain(j.chain) } });
  });
  await a.route("**/v1/wallet", async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    const res = await route.fetch(), j = await res.json();
    await route.fulfill({ response: res, json: { ...j, network: "mainnet", chain: chain(j.chain), deposit: { min: MIN, pending: "1000000000000000", remaining: "4000000000000000", confirmations: 12 }, withdrawalFee: { mode: "estimate", fee: FEE, marginBps: 2500 } } });
  });
  await a.route("**/v1/wallet/deposits", async (route) => {
    const res = await route.fetch(), j = await res.json();
    await route.fulfill({ response: res, json: { ...j, deposits: [
      { txHash: H("ab"), amount: "1000000000000000", blockNumber: 7, status: "pending", credited: false, creditedAt: null, detectedAt: Date.now() - 10000, explorerUrl: `${ADDR_EXPLORER}/tx/${H("ab")}` },
      { txHash: H("ef"), amount: "50000000000000000", blockNumber: 5, status: "credited", credited: true, creditedAt: ago(1, 12), detectedAt: ago(1, 12), explorerUrl: `${ADDR_EXPLORER}/tx/${H("ef")}` },
    ] } });
  });
  /* one withdrawal in each state the server can report (queued, signed, broadcast, confirmed, failed) */
  const WD = (id, status, over = {}) => ({ id, amount: "100000000000000000", fee: FEE, total: "100300000000000000", to: "0x" + "12".repeat(20), status, txHash: null, blockNumber: null, error: null, createdAt: Date.now() - id * 20000, updatedAt: Date.now(), explorerUrl: null, ...over });
  await a.route("**/v1/wallet/withdrawals", async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    const res = await route.fetch(), j = await res.json();
    await route.fulfill({ response: res, json: { ...j, withdrawals: [
      WD(5, "queued"), WD(4, "signed", { txHash: H("a1") }), WD(3, "broadcast", { txHash: H("b2"), explorerUrl: `${ADDR_EXPLORER}/tx/${H("b2")}` }),
      WD(2, "confirmed", { txHash: H("c3"), blockNumber: 9, explorerUrl: `${ADDR_EXPLORER}/tx/${H("c3")}`, createdAt: ago(1, 11) }),
      WD(1, "failed", { txHash: H("d4"), error: "reverted on-chain", createdAt: ago(3, 12) }),
    ] } });
  });
  await a.goto(`${stack.url}/play/?test=1`);

  // signed out: the badge, the title, sober real-money copy, and no test wording
  await a.waitForSelector("#netTag");
  assert.match(await text(a, "#netTag"), /Ethereum Mainnet/i);
  assert.equal(await a.locator("#netTag.real").count(), 1, "real money gets the gold-framed badge");
  assert.match(await a.title(), /real ETH/i);
  assert.match(await text(a, ".testnote"), /Real ETH on Ethereum Mainnet/);
  assert.match(await text(a, ".testnote"), /Stakes are held in escrow until the match is decided\. A 10% fee is taken from the pot\./);
  assert.match(await text(a, ".testnote"), /18 or over/);
  assert.match(await text(a, ".landing-side"), /Invite only: no public matchmaking/);
  assert.doesNotMatch(await a.evaluate(() => document.body.innerText), /test network|test ETH|no real money|Test ETH only/i, "no test wording on mainnet");
  await shot(a, "30-mainnet-signin-1280");
  await a.setViewportSize({ width: 360, height: 780 });
  assert.ok(await noOverflow(a) && (await topFits(a)).inside, "the mainnet sign-in page fits 360px");
  await a.setViewportSize({ width: 1280, height: 900 });

  await a.click("#signInjected");
  await a.waitForSelector("#createBtn");
  const noTest = async (label) => assert.doesNotMatch(await a.evaluate(() => document.body.innerText), /test network|test ETH|no real money|Test ETH only/i, `${label}: no test wording on mainnet`);

  // lobby: real-money stake copy, no faucet anywhere, a visible limits line
  assert.match(await text(a, "#lbSetup"), /ETH\s*·\s*Ethereum Mainnet/i);
  assert.equal(await a.locator("#faucetBtn, #topFaucet, #inviteFaucet").count(), 0, "no faucet or test-ETH buttons when devFaucet is off");
  assert.match(await text(a, ".lb-play"), /Play within your limits/);
  assert.equal(await a.locator(".lb-play a[data-go=settings]").count(), 1, "Play within your limits is a link to the account page");
  await a.click('[data-act=stake][data-v="1000000000000000"]');
  assert.match(await text(a, "#lbCalc"), /real ETH on Ethereum Mainnet, held in escrow until the match is decided/);
  await noTest("lobby");
  await shot(a, "31-mainnet-lobby-1280");
  for (const w of [320, 360, 390, 430, 520, 640]) {
    await a.setViewportSize({ width: w, height: 800 });
    assert.ok(await noOverflow(a), `the mainnet lobby fits ${w}px`);
    const fit = await topFits(a);
    assert.ok(fit.inside && fit.apart, `the top bar and the network badge fit ${w}px without overlap: ${JSON.stringify(fit)}`);
    assert.match(await text(a, "#netTag"), /Mainnet/i, "the phone badge still names the network");
  }
  await shot(a, "32-mainnet-lobby-390");
  await a.setViewportSize({ width: 1280, height: 900 });

  // the first staked create asks for the 18+ confirmation with the real-money wording
  await a.click("#createBtn");
  await a.waitForSelector("#ageCheck");
  assert.equal((await text(a, ".age-check")).trim(), "I am 18 or older and play with real money at my own risk");
  assert.match(await text(a, "#ageTitle"), /real ETH/i);
  await a.keyboard.press("Escape");
  await a.waitForSelector("#ageCheck", { state: "detached" });

  // fund the account (ledger credit) and reload so the page sees the balance
  const uid = await a.evaluate(() => window.__duel.client.me.id);
  stack.app.ledger.post({ kind: "deposit", ref: "mainnet-ui", uniq: "ui-deposit:mainnet-ui", entries: [[ACCT.chain, -parseEther("1")], [ACCT.user(uid), parseEther("1")]] });
  await a.reload();
  await a.waitForSelector("#createBtn");
  await a.click('[data-go="wallet"]');
  await a.waitForSelector("#depositAddr");
  const addr = await text(a, "#depositAddr");

  // wallet: warning, address, copy, explorer link, minimum, confirmations, pending deposit
  assert.match(await text(a, "#depWarn"), /Send only ETH on Ethereum Mainnet\. Other tokens or networks are lost\./);
  assert.ok(await a.locator("#copyAddr").isVisible(), "a copy button for the deposit address");
  assert.equal(await a.getAttribute("#addrExplorer", "href"), `${ADDR_EXPLORER}/address/${addr.trim()}`, "an explorer link for the deposit address");
  assert.match(await text(a, "#depNotes"), /Minimum deposit: 0\.005\sETH/);
  assert.match(await text(a, "#depNotes"), /after 12 confirmations, about 2–3 minutes on Ethereum Mainnet/, "the wait is told roughly: 12 blocks of 12 s");
  assert.match(await text(a, "#depPending"), /0\.001\sETH.*below the minimum deposit.*0\.004\sETH more/s, "a deposit below the minimum shows what is missing");
  assert.equal(await a.locator("#faucetBtn, #qrCode").count(), 0);

  // the amount picker: mainnet presets, a custom amount, one primary action labelled with the amount
  const presets = () => a.$$eval(".dep-amts .dg-chip", (cs) => cs.map((c) => ({ t: c.innerText.trim(), on: c.getAttribute("aria-pressed") === "true", off: c.disabled })));
  assert.deepEqual((await presets()).map((c) => c.t), ["0.01", "0.025", "0.05", "0.1", "0.25", "Custom"]);
  assert.deepEqual((await presets()).filter((c) => c.on).map((c) => c.t), ["0.05"], "0.05 is picked at first");
  assert.match(await text(a, "#depositBtn"), /^Deposit 0\.05\sETH$/i, "the button names the amount");
  await a.click('.dep-amts [data-v="0.25"]');
  assert.match(await text(a, "#depositBtn"), /Deposit 0\.25\sETH/i);
  await a.click('.dep-amts [data-v="custom"]');
  assert.ok(await a.locator("#depCustom").isVisible(), "Custom shows an amount field");
  assert.ok(await a.locator("#depositBtn").isDisabled(), "no deposit until the amount is valid");
  const typeAmt = async (v) => { await a.fill("#depCustom", v); };
  const depErr = () => text(a, "#depErr");
  await typeAmt("0.001");
  assert.match(await depErr(), /The minimum deposit is 0\.005\sETH\./, "below the minimum");
  assert.ok(await a.locator("#depositBtn").isDisabled());
  await typeAmt("0.1234567890123456789");
  assert.match(await depErr(), /at most 18 decimal places/, "too many decimals");
  await typeAmt("abc");
  assert.match(await depErr(), /Enter a number/);
  await typeAmt("0");
  assert.match(await depErr(), /above 0/);
  await typeAmt("11");
  assert.match(await depErr(), /most you can deposit here at once is 10\sETH/, "above 10 ETH");
  await typeAmt("0.3");
  assert.equal(await depErr(), "");
  assert.match(await text(a, "#depositBtn"), /Deposit 0\.3\sETH/i);
  assert.ok(await a.locator("#depositBtn").isEnabled());
  assert.equal(await a.getAttribute("#depCustom", "aria-invalid"), "false");
  await a.click('.dep-amts [data-v="0.05"]');

  // a minimum above some presets disables them, and says why; the pick moves to one that is allowed
  MIN = "30000000000000000";
  await a.click('#nav [data-go="lobby"]');
  await a.click('#nav [data-go="wallet"]');
  await until(async () => (await presets()).find((c) => c.t === "0.01").off, "presets below the new minimum are disabled");
  assert.deepEqual((await presets()).filter((c) => c.off).map((c) => c.t), ["0.01", "0.025"]);
  assert.match(await text(a, "#depMinNote"), /below the minimum deposit of 0\.03\sETH are not available/);
  assert.deepEqual((await presets()).filter((c) => c.on).map((c) => c.t), ["0.05"]);
  MIN = "5000000000000000";
  await a.click('#nav [data-go="lobby"]');
  await a.click('#nav [data-go="wallet"]');
  await until(async () => !(await presets()).some((c) => c.off), "presets are back once the minimum is lower");

  // deposit from the browser wallet. The wallet starts on another chain and has another account selected: nothing is sent until both are right.
  const calls = (m) => a.evaluate((x) => window.__wallet.calls.filter((c) => c.method === x), m);
  const reset = () => a.evaluate(() => { window.__wallet.calls = []; });
  await a.evaluate(() => { window.__wallet.reject = true; });
  await reset();
  await a.click("#depositBtn");
  await until(async () => /Nothing was sent/.test(await text(a, "#depMsg")), "a closed wallet popup is met calmly");
  assert.equal((await calls("eth_sendTransaction")).length, 1, "the wallet was asked once");
  assert.equal(await a.locator("#depSent").count(), 0, "no pending deposit after a rejection");
  assert.equal(await a.locator("#depMsg.warn").count(), 0, "a rejection is not an error");
  await a.evaluate(() => { window.__wallet.reject = false; window.__wallet.chainId = "0x7a69"; window.__wallet.unknownChain = true; });
  await reset();
  await a.click("#depositBtn");
  await until(async () => /does not know Ethereum Mainnet/.test(await text(a, "#depMsg")), "an unknown chain (4902) is explained");
  assert.equal((await calls("eth_sendTransaction")).length, 0, "nothing is sent on an unknown chain");
  await a.evaluate(() => { window.__wallet.unknownChain = false; window.__wallet.account = "0x" + "11".repeat(20); });
  await reset();
  await a.click("#depositBtn");
  await until(async () => /Switch it to .*the account you signed in with/.test(await text(a, "#depMsg")), "the wrong account is named");
  assert.equal((await calls("eth_sendTransaction")).length, 0, "nothing is sent from another account");
  assert.equal((await calls("wallet_switchEthereumChain")).length, 1);
  await a.evaluate(() => { window.__wallet.account = null; window.__wallet.chainId = "0x7a69"; });
  await reset();
  await a.click('.dep-amts [data-v="0.05"]');
  await a.click("#depositBtn");
  await a.waitForSelector("#depSent");
  const me = await a.evaluate(() => window.__duel.client.address);
  const sw = await calls("wallet_switchEthereumChain"), sendTx = await calls("eth_sendTransaction");
  assert.deepEqual(sw.map((c) => c.params[0].chainId), ["0x1"], "the wallet is switched to the deposit chain (id 1)");
  assert.equal(sendTx.length, 1);
  const tx = sendTx[0].params[0];
  assert.equal(tx.to.toLowerCase(), addr.trim().toLowerCase(), "sent to the player's own deposit address");
  assert.equal(tx.from.toLowerCase(), me.toLowerCase(), "from the signed-in account");
  assert.equal(tx.value, "0x" + parseEther("0.05").toString(16), "the value is the picked amount in wei, as hex");
  assert.match(await text(a, "#depSent"), /0\.05\sETH.*Waiting for 12 confirmations, about 2–3 minutes/s, "a pending deposit card");
  assert.equal(await a.getAttribute("#depSentLink", "href"), `${ADDR_EXPLORER}/tx/${H("cd")}`, "with an explorer link to the transaction");
  assert.match(await text(a, "#depSent"), /0xcdcd…cdcd/);
  await until(async () => /1 deposit confirming/.test(await text(a, "#txSummary")), "the summary counts it");
  assert.match(await text(a, '#txList .tx[data-status="confirming"]'), /Deposit[\s\S]*Confirming · 0 \/ 12[\s\S]*\+0\.05\sETH/i, "and so does the list");
  await shot(a, "35-mainnet-wallet-deposit-1280");

  // transactions: every backend status has its own pill, grouped by day, newest first; the filters narrow the list
  const pills = (sel) => a.$$eval(`#txList ${sel} .rpill`, (ps) => ps.map((p) => p.innerText.trim().toLowerCase()));
  const kinds = () => a.$$eval("#txList .tx", (rows) => rows.map((r) => `${r.dataset.kind}:${r.dataset.status}`));
  assert.deepEqual(await kinds(), ["deposit:confirming", "deposit:below", "withdrawal:broadcast", "withdrawal:signed", "withdrawal:queued", "deposit:credited", "withdrawal:confirmed", "withdrawal:failed"], "newest first");
  assert.deepEqual(await pills(""), ["confirming · 0 / 12", "below minimum", "sent", "processing", "queued", "credited", "confirmed", "failed · refunded"], "one pill per backend status");
  const byState = async (st) => (await text(a, `#txList .tx[data-status="${st}"]`)).replace(/\s+/g, " ");
  assert.match(await byState("queued"), /Withdrawal.*Queued.*−0\.1\sETH.*\+ 0\.0003 fee/i, "a queued withdrawal: negative amount, fee under it");
  assert.match(await byState("signed"), /Processing/i);
  assert.match(await byState("broadcast"), /Sent.*Waiting for 12 confirmations/i);
  assert.match(await byState("confirmed"), /Confirmed/i);
  assert.match(await byState("failed"), /Failed · refunded.*Refunded to your balance, network fee included\. Reason: reverted on-chain/i);
  assert.match(await byState("below"), /Below minimum.*\+0\.001\sETH.*Below the minimum deposit of 0\.005\sETH, so it is not credited yet/i);
  assert.match(await byState("credited"), /Deposit.*Credited.*\+0\.05\sETH/i);
  assert.equal(await a.locator('#txList .tx[data-status="credited"] .dg-good').count(), 1, "a credited deposit is in the ok colour");
  assert.equal(await a.locator('#txList .tx[data-status="below"] .dg-good').count(), 0, "one that is not credited is not");
  assert.match(await text(a, "#txSummary"), /1 deposit confirming · 1 deposit below the minimum · 3 withdrawals processing/);
  const days = await a.$$eval("#txList .tx-dayh", (hs) => hs.map((x) => x.textContent.trim()));
  assert.equal(days.length, 3, "grouped by day");
  assert.deepEqual(days.slice(0, 2), ["Today", "Yesterday"]);
  assert.match(await a.getAttribute('#txList .tx[data-status="credited"] time', "title"), /\d/, "the absolute time is in the title");
  assert.match(await text(a, '#txList .tx[data-status="credited"] time'), /\d+ [hd] ago/, "and the time shown is relative");
  assert.equal(await a.getAttribute('#txList .tx[data-status="confirmed"] a.tx-btn', "href"), `${ADDR_EXPLORER}/tx/${H("c3")}`);
  assert.equal(await a.locator('#txList .tx[data-status="queued"] .tx-btn').count(), 0, "a queued withdrawal has no transaction yet");
  const press = (k) => a.$$eval(".tx-filter .dg-chip", (cs) => cs.map((c) => `${c.innerText.trim()}:${c.getAttribute("aria-pressed")}`));
  assert.deepEqual(await press(), ["All:true", "Deposits:false", "Withdrawals:false"]);
  await a.click('.tx-filter [data-v="deposit"]');
  assert.deepEqual((await kinds()).map((k) => k.split(":")[0]).filter((v, i, all) => all.indexOf(v) === i), ["deposit"]);
  assert.equal((await kinds()).length, 3);
  assert.deepEqual(await press(), ["All:false", "Deposits:true", "Withdrawals:false"]);
  await a.click('.tx-filter [data-v="withdrawal"]');
  assert.equal((await kinds()).length, 5);
  assert.ok((await kinds()).every((k) => k.startsWith("withdrawal:")));
  await a.click('.tx-filter [data-v="all"]');
  assert.equal((await kinds()).length, 8);
  // the manual way stays, quieter
  assert.equal(await a.locator("#copyAddr.ghost").count(), 1);
  await shot(a, "36-mainnet-wallet-transactions-1280");
  for (const w of [320, 360, 390, 768, 1024, 1440]) {
    await a.setViewportSize({ width: w, height: 900 });
    assert.ok(await noOverflow(a), `the mainnet wallet fits ${w}px`);
  }
  await a.setViewportSize({ width: 390, height: 900 });
  const small = await a.$$eval(".dep-amts .dg-chip, .tx-filter .dg-chip, .tx-btn, #depositBtn, #copyAddr", (els) => els.filter((e) => e.getBoundingClientRect().height < 43.5 || e.getBoundingClientRect().width < 43.5).map((e) => e.className + " " + e.textContent.trim().slice(0, 12)));
  assert.deepEqual(small, [], "touch targets are at least 44px");
  await shot(a, "37-mainnet-wallet-transactions-390");
  await a.setViewportSize({ width: 1280, height: 900 });
  assert.match(await text(a, "#wlLimits"), /Play within your limits/);
  assert.match(await text(a, "main"), /real ETH: deposits and withdrawals are on-chain/);
  assert.equal(await a.locator("#faucetBtn").count(), 0);
  assert.equal(await a.locator("#burnerWarn, #signBurner").count(), 0, "no burner wallets anywhere");
  await noTest("wallet");

  // withdraw: Max leaves room for the fee; the confirm step shows what arrives, the fee on top and the total
  assert.match(await text(a, "#wdHint"), /Network fee: 0\.0003\sETH, charged on top/);
  await a.click("#wdMax");
  assert.equal(await a.inputValue("#wdAmt"), "0.9997", "Max = balance minus the network fee");
  await a.fill("#wdAmt", "1");
  await a.click("#wdBtn");
  await until(async () => /must cover the amount plus the network fee/i.test(await text(a, "#wdErr")), "a withdrawal the balance cannot cover with the fee is refused");
  await a.fill("#wdAmt", "0.1");
  await a.click("#wdBtn");
  await a.waitForSelector("#wdConfirmBox");
  const box = await text(a, "#wdConfirmBox");
  assert.match(box, /You receive\s*0\.1\sETH/i);
  assert.match(box, /Network fee\s*\+0\.0003\sETH/i);
  assert.match(box, /Taken from your balance\s*0\.1003\sETH/i);
  assert.ok(await a.locator("#wdAmt").evaluate((e) => e.readOnly), "the amount is locked while confirming");
  assert.ok(await a.locator("#wdConfirmBtn").isVisible());
  await shot(a, "33-mainnet-wallet-confirm-1280");
  await a.setViewportSize({ width: 360, height: 800 });
  assert.ok(await noOverflow(a), "the wallet with the confirm step fits 360px");
  await shot(a, "34-mainnet-wallet-confirm-360");
  await a.setViewportSize({ width: 1280, height: 900 });
  await a.click("#wdEdit");
  assert.equal(await a.locator("#wdConfirmBox").count(), 0, "Change amount closes the confirm step");
  assert.equal(await a.locator("#wdAmt").evaluate((e) => e.readOnly), false);

  // account: age status and the daily loss limit stay visible
  await a.click('#nav [data-go="settings"]');
  await a.waitForSelector("#ageStatus");
  assert.equal(await a.getAttribute("#ageStatus", "data-confirmed"), "no", "not confirmed yet");
  assert.ok(await a.locator("#ageOpen").isVisible(), "the account page offers the confirmation");
  assert.match(await text(a, "main"), /Daily loss limit/);
  assert.match(await text(a, "main"), /Stakes are real ETH on Ethereum Mainnet/);
  await noTest("account");
  await a.click("#ageOpen");
  await a.check("#ageCheck");
  await a.click("#ageConfirm");
  await a.waitForSelector("#ageCheck", { state: "detached" });
  await until(async () => (await a.getAttribute("#ageStatus", "data-confirmed")) === "yes", "the account page shows the confirmation");
  assert.deepEqual(a.errors, [], "no console or page errors");
  await ctx.close();
});

test("wallet on the local chain: preset and custom deposit amounts through the faucet, then one Transactions list with filters", { skip: !CHROME && "no Chromium available" }, async (t) => {
  const a = await open(t);
  await a.click("#signInjected");
  await a.click('[data-go="wallet"]');
  await a.waitForSelector("#faucetBtn");
  const presets = () => a.$$eval(".dep-amts .dg-chip", (cs) => cs.map((c) => ({ t: c.innerText.trim(), on: c.getAttribute("aria-pressed") === "true", off: c.disabled })));
  const btn = async () => (await text(a, "#faucetBtn")).replace(/\s+/g, " ");
  const kinds = () => a.$$eval("#txList .tx", (rows) => rows.map((r) => `${r.dataset.kind}:${r.dataset.status}`));

  // empty states, one per filter
  assert.match(await text(a, "#txList"), /No transactions yet/);
  await a.click('.tx-filter [data-v="deposit"]');
  assert.match(await text(a, "#txList"), /No deposits yet/);
  await a.click('.tx-filter [data-v="withdrawal"]');
  assert.match(await text(a, "#txList"), /No withdrawals yet/);
  await a.click('.tx-filter [data-v="all"]');
  assert.equal(await a.locator("#txSummary").count(), 0, "nothing pending: no summary line");

  // the faucet presets, and the faucet is still driven by #faucetBtn / data-act="faucet"
  assert.deepEqual((await presets()).map((c) => c.t), ["0.1", "0.5", "1", "Custom"]);
  assert.deepEqual((await presets()).filter((c) => c.on).map((c) => c.t), ["1"], "1 is picked at first (the faucet's maximum)");
  assert.equal(await a.getAttribute("#faucetBtn", "data-act"), "faucet");
  assert.match(await btn(), /^Deposit 1 ETH$/i);
  assert.equal(await a.locator("#depositBtn").count(), 0, "the wallet button is for real networks");
  await a.click('.dep-amts [data-v="0.5"]');
  assert.match(await btn(), /^Deposit 0\.5 ETH$/i);
  assert.equal(await a.getAttribute("#faucetBtn", "data-eth"), "0.5");
  await a.click("#faucetBtn");
  await until(async () => (await text(a, "#balAvail")) === "0.5", "the 0.5 preset is credited");
  await until(async () => !/Depositing/i.test(await btn()), "the button is ready again");

  // a custom amount: checked while typing, capped at the faucet's 1 ETH
  await a.click('.dep-amts [data-v="custom"]');
  assert.ok(await a.locator("#faucetBtn").isDisabled(), "no amount yet");
  const err = () => text(a, "#depErr");
  await a.fill("#depCustom", "2");
  assert.match(await err(), /faucet sends at most 1 ETH/);
  assert.ok(await a.locator("#faucetBtn").isDisabled());
  await a.fill("#depCustom", "0.1234567890123456789");
  assert.match(await err(), /at most 18 decimal places/);
  await a.fill("#depCustom", "-1");
  assert.match(await err(), /Enter a number/);
  await a.fill("#depCustom", "0.25");
  assert.equal(await err(), "");
  assert.match(await btn(), /^Deposit 0\.25 ETH$/i);
  await a.press("#depCustom", "Enter"); // Enter in the field deposits too
  await until(async () => (await text(a, "#balAvail")) === "0.75", "the custom 0.25 is credited");
  await until(async () => !/Depositing/i.test(await btn()), "the button is ready again");
  assert.equal(await a.inputValue("#depCustom"), "0.25", "the typed amount stays");

  // withdraw 0.25: one Transactions list shows both directions
  await a.fill("#wdAmt", "0.25");
  await a.click("#wdBtn");
  if (await a.waitForSelector("#wdConfirmBtn", { timeout: 1500 }).then(() => true, () => false)) await a.click("#wdConfirmBtn");
  await until(async () => (await a.locator('#txList .tx-wd[data-status="confirmed"]').count()) === 1, "the withdrawal is confirmed", 20000);
  await until(async () => (await kinds()).filter((k) => k === "deposit:credited").length === 2, "both deposits are listed as credited");
  assert.equal((await kinds()).length, 3);
  const row = async (sel) => (await text(a, sel)).replace(/\s+/g, " ");
  assert.match(await row("#txList .tx-wd"), /Withdrawal.*Confirmed.*−0\.25\sETH/i, "a withdrawal: negative, with its status");
  assert.match(await row('#txList .tx-dep'), /Deposit.*Credited.*\+0\.(25|5)\sETH/i, "a deposit: positive, with its status");
  assert.equal(await a.locator("#txList .tx-dep .dg-good").count(), 2, "credited deposits are in the ok colour");
  assert.match(await text(a, "#txList .tx-dayh"), /Today/i, "grouped by day");
  assert.match(await text(a, "#txList .tx time"), /just now|\d+ s ago|\d+ min ago/);
  assert.ok((await a.getAttribute("#txList .tx time", "title")).length > 5, "the absolute time is in the title");
  assert.equal(await a.locator("#txList .tx .tx-hash").count(), 3, "each row carries a short transaction hash");
  assert.equal(await a.locator('#txList .tx-btn[data-act="copy-tx"]').count(), 3);
  assert.equal(await a.locator('#txSummary').count(), 0);
  const press = () => a.$$eval(".tx-filter .dg-chip", (cs) => cs.map((c) => `${c.innerText.trim()}:${c.getAttribute("aria-pressed")}`));
  assert.deepEqual(await press(), ["All:true", "Deposits:false", "Withdrawals:false"]);
  await a.click('.tx-filter [data-v="deposit"]');
  assert.deepEqual(await kinds(), ["deposit:credited", "deposit:credited"], "Deposits shows only deposits");
  assert.deepEqual(await press(), ["All:false", "Deposits:true", "Withdrawals:false"]);
  await a.click('.tx-filter [data-v="withdrawal"]');
  assert.deepEqual(await kinds(), ["withdrawal:confirmed"], "Withdrawals shows only withdrawals");
  await a.click('.tx-filter [data-v="all"]');
  assert.equal((await kinds()).length, 3);

  // layout: no sideways scroll, big enough touch targets, at the widths the client supports
  for (const w of [320, 360, 390, 768, 1024, 1440]) {
    await a.setViewportSize({ width: w, height: 900 });
    assert.ok(await noOverflow(a), `the wallet fits ${w}px`);
  }
  await a.setViewportSize({ width: 360, height: 900 });
  const small = await a.$$eval(".dep-amts .dg-chip, .tx-filter .dg-chip, .tx-btn, #faucetBtn", (els) => els.filter((e) => e.getBoundingClientRect().height < 43.5 || e.getBoundingClientRect().width < 43.5).map((e) => e.className));
  assert.deepEqual(small, [], "touch targets are at least 44px");
  await a.setViewportSize({ width: 1280, height: 900 });
  assert.deepEqual(a.errors, [], "no console or page errors");
});
