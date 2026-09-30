/* The whole journey against a real local chain and the running server:
   wallet sign-in → on-chain deposit → real player-vs-player match → withdrawal back on-chain. */
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { HDNodeWallet, Wallet, parseEther } from "ethers";
import { startChain } from "./helpers/chain.js";
import { FAST, sleep } from "./helpers/app.js";
import { loadConfig } from "../src/config.js";
import { createApp } from "../src/app.js";
import { ACCT } from "../src/ledger.js";
import { DuelClient } from "../client/duel-client.js";

const ETH = (s) => parseEther(String(s));
let H, app;
const clients = [];

before(async () => {
  H = await startChain();
  const cfg = loadConfig({ NODE_ENV: "test", PORT: "0", HOST: "127.0.0.1" }, {
    dbPath: ":memory:",
    keys: { mnemonic: HDNodeWallet.createRandom().mnemonic.phrase },
    chain: { rpcUrl: H.url, confirmations: 2, pollMs: 50, sweepIntervalMs: 100, withdrawIntervalMs: 100, sweepMinWei: ETH("0.001"), rebroadcastAfterMs: 5000 },
    match: FAST.match, rate: FAST.rate,
    economy: { minStake: ETH("0.0001"), maxStake: ETH("0.1"), minWithdrawal: ETH("0.001") },
    adminToken: "e2e-admin-token-e2e-admin-token",
  });
  app = await createApp(cfg);
  await app.start();
  await until(() => app.wallet.deposits.status().lastScannedBlock != null);
});
after(async () => {
  for (const c of clients) c.close();
  await app.stop();
  await H.stop();
});

const until = async (fn, ms = 8000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error("condition not met in time: " + fn.toString());
    await sleep(40);
  }
};

async function player(faucetEth = 1) {
  const wallet = Wallet.createRandom();
  await H.fund(wallet.address, ETH(faucetEth)); // test-network ETH from the "faucet"
  const client = new DuelClient({ baseUrl: app.url, address: wallet.address, sign: (m) => wallet.signMessage(m) });
  await client.login();
  await client.connect();
  clients.push(client);
  return { wallet: wallet.connect(H.provider), client, address: wallet.address };
}

test("deposit → play → win → withdraw, with every balance checked on-chain and in the ledger", async () => {
  await H.fund(app.wallet.keys.treasury().address, ETH(5)); // the operator funds the hot wallet once

  const alice = await player(), bob = await player();
  const admin = { authorization: "Bearer e2e-admin-token-e2e-admin-token" };
  const solvency = async () => (await fetch(app.url + "/v1/admin/solvency", { headers: admin })).json();

  // ---- wallet info: a unique deposit address per player, payouts only to the sign-in address
  const wa = await alice.client.api("GET", "/v1/wallet"), wb = await bob.client.api("GET", "/v1/wallet");
  assert.equal(wa.chain.name, "Local (Hardhat/Anvil)");
  assert.equal(wa.chain.confirmations, 2);
  assert.notEqual(wa.depositAddress, wb.depositAddress);
  assert.notEqual(wa.depositAddress, alice.address, "the deposit address is not the player's own wallet");
  assert.equal(wa.withdrawTo, alice.address);

  // ---- deposit on-chain from each player's own wallet
  const seen = alice.client.waitFor("wallet.updated", (m) => m.reason === "deposit", 8000);
  await (await alice.wallet.sendTransaction({ to: wa.depositAddress, value: ETH("0.2") })).wait();
  assert.equal((await alice.client.api("GET", "/v1/wallet")).balances.available, "0", "not credited before it is confirmed");
  await H.mine(2);
  const ev = await seen;
  assert.equal(ev.amount, ETH("0.2").toString(), "the player is told the moment it is credited");
  await (await bob.wallet.sendTransaction({ to: wb.depositAddress, value: ETH("0.2") })).wait();
  await H.mine(2);
  await until(async () => (await bob.client.api("GET", "/v1/wallet")).balances.available === ETH("0.2").toString());
  assert.equal((await alice.client.api("GET", "/v1/wallet")).balances.available, ETH("0.2").toString());
  const deps = (await alice.client.api("GET", "/v1/wallet/deposits")).deposits;
  assert.equal(deps.length, 1);
  assert.equal(deps[0].amount, ETH("0.2").toString());

  // ---- the background sweeper moves the deposits into the treasury (ledger unaffected)
  await until(() => app.db.get("SELECT COUNT(*) AS n FROM sweeps WHERE status = 'confirmed'").n >= 2);
  assert.equal((await alice.client.api("GET", "/v1/wallet")).balances.available, ETH("0.2").toString());

  // ---- play a real match for 0.01 each
  for (const p of [alice, bob]) await p.client.api("POST", "/v1/me/age", { adult: true });
  const stake = ETH("0.01").toString();
  await alice.client.joinQueue({ game: "darts", stake });
  await bob.client.joinQueue({ game: "darts", stake });
  const [fa, fb] = await Promise.all([alice.client.waitFor("match.found"), bob.client.waitFor("match.found")]);
  assert.equal(fa.match.id, fb.match.id);
  assert.equal((await alice.client.api("GET", "/v1/wallet")).balances.available, ETH("0.19").toString(), "stake is held while matched");
  assert.equal((await alice.client.api("GET", "/v1/me")).balances.inPlay, stake);
  await alice.client.ready(fa.match.id); await bob.client.ready(fa.match.id);
  const [sa] = await Promise.all([alice.client.waitFor("match.start"), bob.client.waitFor("match.start")]);
  await sleep(Math.max(0, sa.startAt - alice.client.serverNow()) + 20);
  await alice.client.submit(fa.match.id, 320);
  await bob.client.submit(fa.match.id, 280);
  const res = await alice.client.waitFor("match.result");
  assert.equal(res.match.result, "win");

  // 0.02 pot − 10% = 0.018 to the winner, 0.002 to the house
  assert.equal((await alice.client.api("GET", "/v1/wallet")).balances.available, ETH("0.208").toString());
  assert.equal((await bob.client.api("GET", "/v1/wallet")).balances.available, ETH("0.19").toString());
  assert.equal(app.ledger.balance(ACCT.house), ETH("0.002"));

  // ---- withdraw the winnings; a hostile `to` in the body changes nothing
  const attacker = Wallet.createRandom().address;
  const before = await H.provider.getBalance(alice.address);
  const key = "e2e-withdraw-1";
  const w1 = await fetch(app.url + "/v1/wallet/withdraw", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${alice.client.token}`, "idempotency-key": key }, body: JSON.stringify({ amount: ETH("0.15").toString(), to: attacker }) });
  assert.equal(w1.status, 201);
  const wd = await w1.json();
  assert.equal(wd.to, alice.address, "funds go only to the address that signed in");
  const w2 = await fetch(app.url + "/v1/wallet/withdraw", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${alice.client.token}`, "idempotency-key": key }, body: JSON.stringify({ amount: ETH("0.15").toString() }) });
  assert.equal(w2.status, 200, "a retry with the same key is a replay");
  assert.equal((await w2.json()).id, wd.id);
  assert.equal((await alice.client.api("GET", "/v1/wallet")).balances.available, ETH("0.058").toString(), "debited once");

  await until(() => app.db.get("SELECT status FROM withdrawals WHERE id = ?", wd.id).status === "broadcast");
  await H.mine(2);
  const done = await until(async () => { const r = (await alice.client.api("GET", "/v1/wallet/withdrawals")).withdrawals[0]; return r.status === "confirmed" ? r : null; });
  assert.ok(done.txHash);
  assert.equal((await H.provider.getBalance(alice.address)) - before, ETH("0.15"), "exactly the requested amount arrived on-chain");
  assert.equal(await H.provider.getBalance(attacker), 0n);
  assert.equal((await alice.client.api("GET", "/v1/wallet")).balances.pendingWithdrawal, "0");

  // ---- more than you have, and money that is in play, cannot be withdrawn
  await assert.rejects(alice.client.api("POST", "/v1/wallet/withdraw", { amount: ETH("0.5").toString() }), { code: "INSUFFICIENT_FUNDS", status: 402 });
  await bob.client.joinQueue({ game: "darts", stake: ETH("0.1").toString() });
  await assert.rejects(bob.client.api("POST", "/v1/wallet/withdraw", { amount: ETH("0.15").toString() }), { code: "INSUFFICIENT_FUNDS" }, "0.19 − 0.1 in escrow leaves only 0.09");
  await bob.client.leaveQueue();

  // ---- history tells the whole story
  const kinds = (await alice.client.api("GET", "/v1/wallet/history?limit=50")).entries.map((e) => e.kind);
  // a player's statement lists what touched their own balance; the escrow-to-escrow legs are internal
  assert.deepEqual(kinds.reverse(), ["deposit", "stake-hold", "match-settle", "withdrawal-hold"]);

  // ---- the books balance, and the chain covers them
  const audit = await (await fetch(app.url + "/v1/admin/audit", { headers: admin })).json();
  assert.deepEqual(audit.problems, []);
  const sol = await solvency();
  assert.equal(sol.ledgerOk, true);
  assert.ok(BigInt(sol.assets) >= BigInt(sol.liabilities), `assets ${sol.assets} must cover liabilities ${sol.liabilities}`);
  // liabilities = alice 0.058 + bob 0.19 + house 0.002
  assert.equal(sol.liabilities, ETH("0.25").toString());
});
