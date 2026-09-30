/* Wallet integration tests against a real local EVM node (Hardhat) over JSON-RPC. */
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { Wallet, HDNodeWallet, parseEther } from "ethers";
import { Db } from "../src/db/index.js";
import { Ledger, ACCT } from "../src/ledger.js";
import { Users } from "../src/users.js";
import { Hub } from "../src/hub.js";
import { loadConfig } from "../src/config.js";
import { createLogger } from "../src/util/log.js";
import { KeyManager } from "../src/wallet/keys.js";
import { connectChain } from "../src/wallet/chain.js";
import { WalletService } from "../src/wallet/index.js";
import { startChain } from "./helpers/chain.js";

let H; // the running chain
before(async () => { H = await startChain(); });
after(async () => { await H.stop(); });

const ETH = (s) => parseEther(String(s));

async function stack(over = {}) {
  const clock = { t: Date.now() };
  const now = () => clock.t;
  const db = new Db(":memory:");
  const cfg = loadConfig({ NODE_ENV: "test" }, {
    chain: { rpcUrl: H.url, confirmations: 2, sweepMinWei: ETH("0.001"), rebroadcastAfterMs: 1000, ...over.chain },
    economy: { minWithdrawal: ETH("0.001"), maxWithdrawal: ETH(2), dailyWithdrawalCap: ETH(3), ...over.economy },
  });
  const ledger = new Ledger(db, now);
  const users = new Users(db, now);
  const bus = new Hub();
  const events = [];
  bus.on("user", (id, m) => events.push([id, m]));
  const keys = new KeyManager(HDNodeWallet.createRandom().mnemonic.phrase);
  const chain = await connectChain(cfg.chain);
  const wallet = new WalletService({ db, ledger, cfg, log: createLogger("silent"), bus, chain, keys, now });
  await wallet.deposits.scanOnce(); // put the cursor at the tip before any funds move
  const s = {
    clock, db, cfg, ledger, users, bus, events, keys, chain, wallet,
    bal: (u) => ledger.balance(ACCT.user(u.id)),
    mkUser: () => users.getOrCreate(Wallet.createRandom().address.toLowerCase()).user,
    async fundTreasury(eth) { await H.fund(keys.treasury().address, ETH(eth)); },
    /* deposit `eth` on-chain and run the watcher until it is credited */
    async deposit(u, eth) {
      const addr = wallet.depositAddress(u.id);
      await H.fund(addr, ETH(eth));
      await H.mine(cfg.chain.confirmations);
      await wallet.deposits.scanOnce();
      return addr;
    },
    wd: (id) => db.get("SELECT * FROM withdrawals WHERE id = ?", id),
    async finish() { await H.mine(cfg.chain.confirmations); await wallet.withdrawals.pass(); },
  };
  return s;
}

/* ------------------------------------------------------------------ chain guard */

test("refuses to start against a chain that is not a known test network", async () => {
  const fake = (id) => new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      req.resume();
      req.on("end", () => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x" + id.toString(16) })); });
    });
    srv.listen(0, "127.0.0.1", () => resolve(srv));
  });
  const mainnets = { "Ethereum": 1, "Optimism": 10, "BNB": 56, "Polygon": 137, "Base": 8453, "Arbitrum One": 42161 };
  for (const [name, id] of Object.entries(mainnets)) {
    const srv = await fake(id);
    await assert.rejects(connectChain({ rpcUrl: `http://127.0.0.1:${srv.address().port}`, expectedChainId: null }), /not a known test network/, name);
    srv.close();
  }
  await assert.rejects(connectChain({ rpcUrl: H.url, expectedChainId: 11155111 }), /CHAIN_ID/);
  const ok = await connectChain({ rpcUrl: H.url, expectedChainId: 31337 });
  assert.equal(ok.chainId, 31337);
  ok.destroy();
});

/* ------------------------------------------------------------------ deposits */

test("a deposit is credited exactly once, and only after enough confirmations", async () => {
  const s = await stack();
  const u = s.mkUser();
  const addr = s.wallet.depositAddress(u.id);
  assert.equal(addr, s.keys.userAddress(u.id));
  assert.equal(s.wallet.depositAddress(u.id), addr, "the address is stable");

  const txHash = await H.fund(addr, ETH("0.25")); // mined, 1 confirmation
  assert.equal(await s.wallet.deposits.scanOnce(), 0, "1 confirmation is not enough (need 2)");
  assert.equal(s.bal(u), 0n);

  await H.mine(1);
  assert.equal(await s.wallet.deposits.scanOnce(), 1);
  assert.equal(s.bal(u), ETH("0.25"));
  assert.equal(await s.wallet.deposits.scanOnce(), 0, "scanning again must not credit again");
  assert.equal(s.bal(u), ETH("0.25"));

  const row = s.db.get("SELECT * FROM deposits WHERE tx_hash = ?", txHash);
  assert.equal(row.amount, ETH("0.25").toString());
  assert.equal(row.user_id, u.id);
  assert.ok(s.events.some(([id, m]) => id === u.id && m.type === "wallet.updated" && m.reason === "deposit" && m.txHash === txHash));
  assert.ok(s.ledger.audit().ok);
  assert.equal(s.ledger.balance(ACCT.chain), -ETH("0.25"));
});

test("crediting is idempotent even if the same deposit is offered twice or the cursor is lost", async () => {
  const s = await stack();
  const u = s.mkUser();
  const addr = await s.deposit(u, "0.1");
  const row = s.db.get("SELECT * FROM deposits WHERE user_id = ?", u.id);
  // rewind the cursor to before the deposit: a re-scan sees the same tx again
  s.db.run("UPDATE chain_state SET value = ? WHERE key = 'last_scanned'", String(row.block_number - 1));
  assert.equal(await s.wallet.deposits.scanOnce(), 0);
  assert.equal(s.bal(u), ETH("0.1"), "no double credit after a cursor rewind");
  assert.equal(s.db.get("SELECT COUNT(*) AS n FROM deposits").n, 1);
  assert.ok(addr);
});

test("a restarted server carries on from the stored cursor and misses nothing", async () => {
  const s = await stack();
  const u = s.mkUser();
  await s.deposit(u, "0.1");
  // "restart": a brand-new service over the same database
  const again = new WalletService({ db: s.db, ledger: s.ledger, cfg: s.cfg, log: createLogger("silent"), bus: s.bus, chain: s.chain, keys: s.keys, now: () => s.clock.t });
  await H.fund(again.depositAddress(u.id), ETH("0.2")); // sent while "down"
  await H.mine(2);
  assert.equal(await again.deposits.scanOnce(), 1);
  assert.equal(s.bal(u), ETH("0.3"));
  assert.equal(await again.deposits.scanOnce(), 0);
});

test("several players in one scan; unrelated, zero-value and unknown-address transfers are ignored", async () => {
  const s = await stack();
  const a = s.mkUser(), b = s.mkUser();
  const addrA = s.wallet.depositAddress(a.id), addrB = s.wallet.depositAddress(b.id);
  await H.fund(addrA, ETH("0.05"));
  await H.fund(addrB, ETH("0.07"));
  await H.fund(addrA, ETH("0.01"));
  await H.fund(Wallet.createRandom().address, ETH("0.5")); // someone else entirely
  await H.faucet.sendTransaction({ to: addrB, value: 0n }).then((t) => t.wait()); // zero value
  await H.mine(2);
  assert.equal(await s.wallet.deposits.scanOnce(), 3);
  assert.equal(s.bal(a), ETH("0.06"));
  assert.equal(s.bal(b), ETH("0.07"));
  assert.ok(s.ledger.audit().ok);
});

test("a fresh database starts at the chain tip instead of replaying history", async () => {
  await H.mine(5);
  const s = await stack();
  const head = await H.provider.getBlockNumber();
  const st = s.wallet.deposits.status();
  assert.equal(st.lastScannedBlock, head - s.cfg.chain.confirmations + 1);
});

/* ------------------------------------------------------------------ sweeper */

test("the sweeper moves confirmed deposits to the treasury without touching player balances", async () => {
  const s = await stack();
  const u = s.mkUser();
  const addr = await s.deposit(u, "1");
  const treasury = s.keys.treasury().address;
  const before = await H.provider.getBalance(treasury);

  await s.wallet.sweeper.pass(); // signs + broadcasts (automine mines it)
  await s.wallet.sweeper.pass(); // sees the receipt
  const sweep = s.db.get("SELECT * FROM sweeps WHERE user_id = ?", u.id);
  assert.equal(sweep.status, "confirmed");
  const after = await H.provider.getBalance(treasury);
  assert.equal(after - before, BigInt(sweep.amount), "treasury received exactly the swept amount");
  assert.ok(ETH("1") - BigInt(sweep.amount) < ETH("0.001"), "only gas was deducted");
  assert.ok((await H.provider.getBalance(addr)) < ETH("0.0001"), "the deposit address is emptied (dust from the fee cap at most)");
  assert.equal(s.bal(u), ETH("1"), "the player's balance is unchanged by sweeping");

  await s.wallet.sweeper.pass();
  assert.equal(s.db.get("SELECT COUNT(*) AS n FROM sweeps").n, 1, "nothing left to sweep");
  assert.ok(s.ledger.audit().ok);
});

test("dust below the sweep threshold is credited but not swept", async () => {
  const s = await stack();
  const u = s.mkUser();
  await s.deposit(u, "0.0002");
  assert.equal(s.bal(u), ETH("0.0002"));
  await s.wallet.sweeper.pass();
  assert.equal(s.db.get("SELECT COUNT(*) AS n FROM sweeps").n, 0);
});

/* ------------------------------------------------------------------ withdrawals */

test("withdrawal: hold → sign → broadcast → confirm, paying exactly the requested amount once", async () => {
  const s = await stack();
  await s.fundTreasury(5);
  const u = s.mkUser();
  await s.deposit(u, "1");

  const w = s.wallet.withdrawals.request({ userId: u.id, to: u.address, amount: ETH("0.4") });
  assert.equal(w.status, "queued");
  assert.equal(s.bal(u), ETH("0.6"));
  assert.equal(s.ledger.balance(ACCT.withdrawal(w.id)), ETH("0.4"), "funds are held in escrow while in flight");

  await s.wallet.withdrawals.pass();
  const row = s.wd(w.id);
  assert.equal(row.status, "broadcast");
  assert.ok(row.raw_tx && row.tx_hash, "the signed transaction is stored");
  assert.equal(await H.provider.getBalance(u.address), ETH("0.4"), "paid on-chain");
  assert.equal(s.ledger.balance(ACCT.withdrawal(w.id)), ETH("0.4"), "still escrowed until it is deep enough");

  await s.finish();
  assert.equal(s.wd(w.id).status, "confirmed");
  assert.equal(s.ledger.balance(ACCT.withdrawal(w.id)), 0n);
  assert.equal(s.ledger.balance(ACCT.chain), -ETH("0.6"), "net deposits − withdrawals");
  assert.equal(await H.provider.getBalance(u.address), ETH("0.4"), "not paid twice");
  assert.ok(s.ledger.audit().ok);

  const sol = await s.wallet.solvency();
  assert.equal(sol.ledgerOk, true);
  assert.ok(BigInt(sol.assets) >= BigInt(sol.liabilities), "on-chain assets cover what the ledger owes");
});

test("with an empty treasury a withdrawal waits in the queue, then goes through once funded", async () => {
  const s = await stack();
  const u = s.mkUser();
  await s.deposit(u, "0.5");
  const w = s.wallet.withdrawals.request({ userId: u.id, to: u.address, amount: ETH("0.2") });
  await s.wallet.withdrawals.pass();
  assert.equal(s.wd(w.id).status, "queued");
  assert.equal(s.wd(w.id).error, "treasury_underfunded");
  assert.equal(s.wallet.withdrawals.underfunded, true);
  assert.equal(s.bal(u), ETH("0.3"), "the player's money stays held, not lost");

  await s.fundTreasury(1);
  await s.wallet.withdrawals.pass();
  assert.equal(s.wd(w.id).status, "broadcast");
  assert.equal(s.wd(w.id).error, null);
  await s.finish();
  assert.equal(s.wd(w.id).status, "confirmed");
  assert.equal(await H.provider.getBalance(u.address), ETH("0.2"));
});

test("withdrawal requests are validated; a refused request changes nothing", async () => {
  const s = await stack({ economy: { dailyWithdrawalCap: ETH("0.5") } });
  const u = s.mkUser();
  await s.deposit(u, "1");
  const req = (amount, extra = {}) => s.wallet.withdrawals.request({ userId: u.id, to: u.address, amount, ...extra });
  const rows = () => s.db.get("SELECT COUNT(*) AS n FROM withdrawals").n;

  assert.throws(() => req(ETH("0.0001")), { code: "BELOW_MINIMUM" });
  assert.throws(() => req(ETH(3)), { code: "ABOVE_MAXIMUM" });
  assert.throws(() => req(ETH("0.6")), { code: "DAILY_WITHDRAWAL_CAP" });
  assert.equal(rows(), 0);

  const other = s.mkUser(); // nothing deposited
  assert.throws(() => s.wallet.withdrawals.request({ userId: other.id, to: other.address, amount: ETH("0.01") }), { code: "INSUFFICIENT_FUNDS" });
  assert.equal(rows(), 0, "an overdraft rolls the withdrawal row back too");
  assert.equal(s.bal(u), ETH(1));

  req(ETH("0.3"));
  assert.throws(() => req(ETH("0.3")), { code: "DAILY_WITHDRAWAL_CAP" }, "0.3 + 0.3 exceeds the 0.5 rolling cap");
  s.clock.t += 24 * 3600000 + 1;
  req(ETH("0.3")); // the window has rolled
  assert.equal(rows(), 2);
  assert.ok(s.ledger.audit().ok);
});

test("an Idempotency-Key makes a retried request safe", async () => {
  const s = await stack();
  const u = s.mkUser();
  await s.deposit(u, "1");
  const req = (amount, key) => s.wallet.withdrawals.request({ userId: u.id, to: u.address, amount, idemKey: key });
  const first = req(ETH("0.1"), "retry-1");
  const second = req(ETH("0.1"), "retry-1");
  assert.equal(first.replay, false);
  assert.equal(second.replay, true);
  assert.equal(second.id, first.id);
  assert.equal(s.bal(u), ETH("0.9"), "debited once");
  assert.throws(() => req(ETH("0.2"), "retry-1"), { code: "IDEMPOTENCY_MISMATCH" });
  assert.throws(() => req(ETH("0.1"), "bad key!"), { code: "BAD_IDEMPOTENCY_KEY" });
  // another player may reuse the same key string
  const v = s.mkUser();
  await s.deposit(v, "0.5");
  assert.equal(s.wallet.withdrawals.request({ userId: v.id, to: v.address, amount: ETH("0.1"), idemKey: "retry-1" }).replay, false);
});

test("if broadcasting fails, the same signed bytes are retried, later withdrawals wait, and nobody is paid twice", async () => {
  const s = await stack();
  await s.fundTreasury(5);
  const u = s.mkUser(), v = s.mkUser();
  await s.deposit(u, "0.5");
  await s.deposit(v, "0.5");
  const a = s.wallet.withdrawals.request({ userId: u.id, to: u.address, amount: ETH("0.1") });
  const b = s.wallet.withdrawals.request({ userId: v.id, to: v.address, amount: ETH("0.1") });

  const real = s.chain.provider.broadcastTransaction.bind(s.chain.provider);
  s.chain.provider.broadcastTransaction = async () => { throw new Error("connect ECONNREFUSED 127.0.0.1:8545"); };
  await s.wallet.withdrawals.pass();
  assert.equal(s.wd(a.id).status, "signed", "signed and stored, but not sent");
  assert.equal(s.wd(b.id).status, "queued", "nothing later is signed while an earlier nonce is stuck");
  const signedHash = s.wd(a.id).tx_hash;

  s.chain.provider.broadcastTransaction = real; // the node is back
  await s.wallet.withdrawals.pass();
  assert.equal(s.wd(a.id).status, "broadcast");
  assert.equal(s.wd(a.id).tx_hash, signedHash, "the very same transaction was sent");
  assert.equal(s.wd(b.id).status, "broadcast");
  assert.notEqual(s.wd(b.id).nonce, s.wd(a.id).nonce);
  assert.equal(s.wd(b.id).nonce, s.wd(a.id).nonce + 1);
  await s.finish();
  assert.equal(await H.provider.getBalance(u.address), ETH("0.1"));
  assert.equal(await H.provider.getBalance(v.address), ETH("0.1"));
  assert.ok(s.ledger.audit().ok);
});

test("if the node accepted the transaction but the call errored, we notice the receipt instead of resending", async () => {
  const s = await stack();
  await s.fundTreasury(5);
  const u = s.mkUser();
  await s.deposit(u, "0.5");
  const real = s.chain.provider.broadcastTransaction.bind(s.chain.provider);
  let sent = 0;
  s.chain.provider.broadcastTransaction = async (raw) => { sent++; await real(raw); throw new Error("socket hang up"); };
  const w = s.wallet.withdrawals.request({ userId: u.id, to: u.address, amount: ETH("0.1") });
  await s.wallet.withdrawals.pass();
  await s.wallet.withdrawals.pass();
  assert.equal(sent, 1, "the transaction went out once and was never re-sent");
  assert.equal(s.wd(w.id).status, "broadcast", "the row moved on because a receipt exists");
  s.chain.provider.broadcastTransaction = real;
  await s.finish();
  assert.equal(s.wd(w.id).status, "confirmed");
  assert.equal(await H.provider.getBalance(u.address), ETH("0.1"), "paid exactly once");
  assert.ok(s.ledger.audit().ok);
});

test("a payout that reverts on-chain is refunded to the player", async () => {
  const s = await stack();
  await s.fundTreasury(5);
  const u = s.mkUser();
  await s.deposit(u, "0.5");
  await H.rpc("hardhat_setCode", [u.address, "0xfe"]); // recipient is a contract that always fails
  const w = s.wallet.withdrawals.request({ userId: u.id, to: u.address, amount: ETH("0.2") });
  await s.wallet.withdrawals.pass();
  await s.finish();
  const row = s.wd(w.id);
  assert.equal(row.status, "failed");
  assert.match(row.error, /reverted/);
  assert.equal(s.bal(u), ETH("0.5"), "refunded in full");
  assert.equal(s.ledger.balance(ACCT.withdrawal(w.id)), 0n);
  assert.equal(await H.provider.getBalance(u.address), 0n, "no value reached the reverting contract");
  assert.ok(s.ledger.audit().ok);
});

test("a slow (not dropped) transaction is never refunded; it is re-sent and pays exactly once", async () => {
  const s = await stack();
  await s.fundTreasury(5);
  const u = s.mkUser();
  await s.deposit(u, "0.5");
  const w = s.wallet.withdrawals.request({ userId: u.id, to: u.address, amount: ETH("0.2") });
  await H.rpc("evm_setAutomine", [false]);
  try {
    await s.wallet.withdrawals.pass();
    assert.equal(s.wd(w.id).status, "broadcast");
    s.clock.t += 10 * s.cfg.chain.rebroadcastAfterMs; // far past every threshold, but the nonce is still unspent
    await s.wallet.withdrawals.pass();
    assert.equal(s.wd(w.id).status, "broadcast", "still waiting: the tx can yet be mined");
    assert.equal(s.bal(u), ETH("0.3"));
  } finally {
    await H.rpc("evm_setAutomine", [true]);
  }
  await H.mine(1);
  await s.finish();
  assert.equal(s.wd(w.id).status, "confirmed");
  assert.equal(await H.provider.getBalance(u.address), ETH("0.2"));
  assert.ok(s.ledger.audit().ok);
});

test("a transaction that was replaced (its nonce taken by another tx) is refunded, but only after the safety delay", async () => {
  const s = await stack();
  await s.fundTreasury(5);
  const u = s.mkUser();
  await s.deposit(u, "0.5");
  const w = s.wallet.withdrawals.request({ userId: u.id, to: u.address, amount: ETH("0.2") });
  await H.rpc("evm_setAutomine", [false]);
  try {
    await s.wallet.withdrawals.pass();
    const row = s.wd(w.id);
    assert.equal(row.status, "broadcast");
    await H.rpc("hardhat_dropTransaction", [row.tx_hash]);
    // something else (an operator mistake, say) spends that treasury nonce
    await s.keys.treasury().connect(H.provider).sendTransaction({ to: Wallet.createRandom().address, value: 1n, nonce: row.nonce });
    await H.mine(1);
  } finally {
    await H.rpc("evm_setAutomine", [true]);
  }
  await s.wallet.withdrawals.pass();
  assert.equal(s.wd(w.id).status, "broadcast", "too early to be sure it will never mine");
  s.clock.t += 1.5 * s.cfg.chain.rebroadcastAfterMs;
  await s.wallet.withdrawals.pass();
  assert.equal(s.wd(w.id).status, "broadcast", "still inside the safety window");
  s.clock.t += 1.5 * s.cfg.chain.rebroadcastAfterMs;
  await s.wallet.withdrawals.pass();
  const done = s.wd(w.id);
  assert.equal(done.status, "failed");
  assert.match(done.error, /dropped or replaced/);
  assert.equal(s.bal(u), ETH("0.5"));
  assert.equal(await H.provider.getBalance(u.address), 0n);
  assert.ok(s.ledger.audit().ok);
});
