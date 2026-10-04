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
const fakes = []; // fake RPC nodes, closed at the end even if a test failed half-way
before(async () => { H = await startChain(); });
after(async () => { await H.stop(); for (const f of fakes) { f.closeAllConnections?.(); f.close(); } });

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
  const logs = []; // warnings and errors, so tests can see what an operator would see
  const log = { debug() {}, info() {}, warn: (m, f) => logs.push(["warn", m, f]), error: (m, f) => logs.push(["error", m, f]) };
  const keys = new KeyManager(HDNodeWallet.createRandom().mnemonic.phrase);
  const chain = await connectChain(cfg.chain);
  const wallet = new WalletService({ db, ledger, cfg, log, bus, chain, keys, now });
  await wallet.deposits.scanOnce(); // put the cursor at the tip before any funds move
  const s = {
    clock, db, cfg, ledger, users, bus, events, logs, keys, chain, wallet,
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

/* a fake JSON-RPC node that only knows its chain id (what the startup guard asks first) */
const fakeRpc = (id) => new Promise((resolve) => {
  const srv = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x" + id.toString(16) })); });
  });
  srv.listen(0, "127.0.0.1", () => { fakes.push(srv); resolve(srv); });
});
const urlOf = (srv) => `http://127.0.0.1:${srv.address().port}`;

test("refuses to start against a chain id that is not on the allow-list", async () => {
  const unknown = { "Optimism": 10, "BNB": 56, "Polygon": 137, "Arbitrum One": 42161 };
  for (const [name, id] of Object.entries(unknown)) {
    const srv = await fakeRpc(id);
    await assert.rejects(connectChain({ rpcUrl: urlOf(srv), expectedChainId: null }), /not a known network/, name);
    await assert.rejects(connectChain({ rpcUrl: urlOf(srv), expectedChainId: null, network: "mainnet" }), /not a known network/, `${name} even with NETWORK=mainnet`);
    srv.close();
  }
  await assert.rejects(connectChain({ rpcUrl: H.url, expectedChainId: 11155111 }), /CHAIN_ID/);
  const ok = await connectChain({ rpcUrl: H.url, expectedChainId: 31337 });
  assert.equal(ok.chainId, 31337);
  assert.deepEqual([ok.meta.network, ok.meta.realMoney], ["local", false]);
  ok.destroy();
});

test("a mainnet chain id is refused unless NETWORK=mainnet is set", async () => {
  for (const [name, id] of Object.entries({ "Ethereum": 1, "Base": 8453 })) {
    const srv = await fakeRpc(id);
    for (const network of [undefined, null, "", "testnet", "local"]) {
      await assert.rejects(connectChain({ rpcUrl: urlOf(srv), expectedChainId: null, network }), /MAINNET.*NETWORK=mainnet/s, `${name} with NETWORK=${network}`);
    }
    const chain = await connectChain({ rpcUrl: urlOf(srv), expectedChainId: id, network: "mainnet" });
    assert.equal(chain.chainId, id);
    assert.deepEqual([chain.meta.network, chain.meta.realMoney], ["mainnet", true]);
    assert.equal(chain.meta.symbol, "ETH");
    assert.equal(chain.meta.explorer, id === 1 ? "https://etherscan.io" : "https://basescan.org");
    chain.destroy();
    await assert.rejects(connectChain({ rpcUrl: urlOf(srv), expectedChainId: 11155111, network: "mainnet" }), /CHAIN_ID/, "CHAIN_ID must match the RPC");
    srv.close();
  }
});

test("NETWORK=mainnet refuses a testnet or a local chain", async () => {
  const sepolia = await fakeRpc(11155111);
  await assert.rejects(connectChain({ rpcUrl: urlOf(sepolia), expectedChainId: null, network: "mainnet" }), /NETWORK=mainnet but the RPC reports chain id 11155111.*test network/s);
  sepolia.close();
  await assert.rejects(connectChain({ rpcUrl: H.url, expectedChainId: null, network: "mainnet" }), /NETWORK=mainnet but the RPC reports chain id 31337.*local development chain/s);
  await assert.rejects(connectChain({ rpcUrl: H.url, expectedChainId: 1, network: "mainnet" }), /NETWORK=mainnet but the RPC reports chain id 31337/);
  // and a declared local network is not a licence to use a public testnet
  const base = await fakeRpc(84532);
  await assert.rejects(connectChain({ rpcUrl: urlOf(base), expectedChainId: null, network: "local" }), /NETWORK=local/);
  base.close();
});

test("the full wallet service applies the same guard, before any key is derived", async () => {
  const srv = await fakeRpc(1);
  const bus = new Hub(), db = new Db(":memory:");
  const mk = (env, over = {}) => {
    const cfg = loadConfig({ NODE_ENV: "test", ...env }, { chain: { rpcUrl: urlOf(srv) }, keys: { mnemonic: HDNodeWallet.createRandom().mnemonic.phrase }, ...over });
    return WalletService.create({ db, ledger: new Ledger(db), cfg, log: createLogger("silent"), bus, now: () => Date.now() });
  };
  await assert.rejects(mk({}), /MAINNET.*NETWORK=mainnet/s);
  // loadConfig's own mainnet checks (production, origins, ...) are covered in mainnet.config.test.js; here only the chain guard matters
  const cfg = loadConfig({ NODE_ENV: "test" }, { chain: { rpcUrl: urlOf(srv) }, keys: { mnemonic: HDNodeWallet.createRandom().mnemonic.phrase } });
  cfg.network = "mainnet";
  const svc = await WalletService.create({ db, ledger: new Ledger(db), cfg, log: createLogger("silent"), bus, now: () => Date.now() });
  assert.equal(svc.chainInfo().network, "mainnet");
  assert.equal(svc.chainInfo().realMoney, true);
  assert.equal(svc.network(), "mainnet");
  svc.chain.destroy();
  srv.close();
  db.close();
});

test("the dev faucet flag is refused on any chain that is not local", async () => {
  const srv = await fakeRpc(11155111);
  const db = new Db(":memory:");
  const cfg = loadConfig({ NODE_ENV: "test" }, { chain: { rpcUrl: urlOf(srv) }, keys: { mnemonic: HDNodeWallet.createRandom().mnemonic.phrase }, devFaucet: true });
  await assert.rejects(WalletService.create({ db, ledger: new Ledger(db), cfg, log: createLogger("silent"), bus: new Hub(), now: () => Date.now() }), /dev faucet is enabled but chain id 11155111 is not a local chain/);
  srv.close();
  db.close();
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

  const w = await s.wallet.withdrawals.request({ userId: u.id, to: u.address, amount: ETH("0.4") });
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
  const w = await s.wallet.withdrawals.request({ userId: u.id, to: u.address, amount: ETH("0.2") });
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

  await assert.rejects(req(ETH("0.0001")), { code: "BELOW_MINIMUM" });
  await assert.rejects(req(ETH(3)), { code: "ABOVE_MAXIMUM" });
  await assert.rejects(req(ETH("0.6")), { code: "DAILY_WITHDRAWAL_CAP" });
  assert.equal(rows(), 0);

  const other = s.mkUser(); // nothing deposited
  await assert.rejects(s.wallet.withdrawals.request({ userId: other.id, to: other.address, amount: ETH("0.01") }), { code: "INSUFFICIENT_FUNDS" });
  assert.equal(rows(), 0, "an overdraft rolls the withdrawal row back too");
  assert.equal(s.bal(u), ETH(1));

  await req(ETH("0.3"));
  await assert.rejects(req(ETH("0.3")), { code: "DAILY_WITHDRAWAL_CAP" }, "0.3 + 0.3 exceeds the 0.5 rolling cap");
  s.clock.t += 24 * 3600000 + 1;
  await req(ETH("0.3")); // the window has rolled
  assert.equal(rows(), 2);
  assert.ok(s.ledger.audit().ok);
});

test("an Idempotency-Key makes a retried request safe", async () => {
  const s = await stack();
  const u = s.mkUser();
  await s.deposit(u, "1");
  const req = (amount, key) => s.wallet.withdrawals.request({ userId: u.id, to: u.address, amount, idemKey: key });
  const first = await req(ETH("0.1"), "retry-1");
  const second = await req(ETH("0.1"), "retry-1");
  assert.equal(first.replay, false);
  assert.equal(second.replay, true);
  assert.equal(second.id, first.id);
  assert.equal(s.bal(u), ETH("0.9"), "debited once");
  await assert.rejects(req(ETH("0.2"), "retry-1"), { code: "IDEMPOTENCY_MISMATCH" });
  await assert.rejects(req(ETH("0.1"), "bad key!"), { code: "BAD_IDEMPOTENCY_KEY" });
  // another player may reuse the same key string
  const v = s.mkUser();
  await s.deposit(v, "0.5");
  assert.equal((await s.wallet.withdrawals.request({ userId: v.id, to: v.address, amount: ETH("0.1"), idemKey: "retry-1" })).replay, false);
});

test("if broadcasting fails, the same signed bytes are retried, later withdrawals wait, and nobody is paid twice", async () => {
  const s = await stack();
  await s.fundTreasury(5);
  const u = s.mkUser(), v = s.mkUser();
  await s.deposit(u, "0.5");
  await s.deposit(v, "0.5");
  const a = await s.wallet.withdrawals.request({ userId: u.id, to: u.address, amount: ETH("0.1") });
  const b = await s.wallet.withdrawals.request({ userId: v.id, to: v.address, amount: ETH("0.1") });

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
  const w = await s.wallet.withdrawals.request({ userId: u.id, to: u.address, amount: ETH("0.1") });
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
  const w = await s.wallet.withdrawals.request({ userId: u.id, to: u.address, amount: ETH("0.2") });
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
  const w = await s.wallet.withdrawals.request({ userId: u.id, to: u.address, amount: ETH("0.2") });
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
  const w = await s.wallet.withdrawals.request({ userId: u.id, to: u.address, amount: ETH("0.2") });
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


/* ------------------------------------------------------------------ mainnet economics: gas-aware sweeps */

const GWEI = 10n ** 9n;
/* pin the fee data the provider would report, so thresholds are exact (the test chain's base fee moves with every block) */
const pinFees = (s, gwei, tip = 1n) => {
  s.chain.feeData = async () => ({ maxFeePerGas: BigInt(gwei) * GWEI, maxPriorityFeePerGas: tip * GWEI, expectedFeePerGas: (BigInt(gwei) / 2n) * GWEI });
};
const SWEEP_GAS = 21000n;

test("sweeps wait until the balance is worth the gas: threshold = gas cost x SWEEP_MIN_MULTIPLIER, from live fee data", async () => {
  const s = await stack({ chain: { sweepMinWei: 0n, sweepMinMultiplier: 3 } });
  pinFees(s, 100); // 100 gwei: a sweep costs 0.0021 ETH, so an address needs 0.0063 ETH
  const gasCost = SWEEP_GAS * 100n * GWEI;
  assert.equal(gasCost, ETH("0.0021"));
  assert.equal(s.wallet.sweeper.minBalanceFor(100n * GWEI), ETH("0.0063"));

  const small = s.mkUser(), big = s.mkUser();
  await s.deposit(small, "0.005");   // above the gas cost, below 3x
  await s.deposit(big, "0.007");     // above 3x
  await s.wallet.sweeper.pass();
  const swept = s.db.all("SELECT user_id FROM sweeps").map((r) => r.user_id);
  assert.deepEqual(swept, [big.id], "only the address whose balance clears 3x the gas cost is swept");
  assert.equal(s.wallet.sweeper.deferred, 1);
  assert.equal(s.db.get("SELECT needs_sweep FROM deposit_addresses WHERE user_id = ?", small.id).needs_sweep, 1, "the deferred address is not forgotten");
  assert.equal(s.bal(small), ETH("0.005"), "deferral never touches the player's credited balance");
  const sweep = s.db.get("SELECT * FROM sweeps WHERE user_id = ?", big.id);
  assert.equal(BigInt(sweep.amount), ETH("0.007") - gasCost, "gas at the live fee cap comes out of the swept amount");

  // gas gets cheaper: the same address is now worth sweeping, and is picked up on a later pass
  pinFees(s, 50); // threshold 0.00315
  await s.wallet.sweeper.pass();
  assert.deepEqual(s.db.all("SELECT user_id FROM sweeps ORDER BY id").map((r) => r.user_id), [big.id, small.id]);
  assert.equal(s.wallet.sweeper.deferred, 0);
  assert.ok(s.ledger.audit().ok);
});

test("the sweep multiplier is 1 outside mainnet (old behaviour) and 3 on mainnet; a balance at or below one gas cost is never swept", async () => {
  assert.equal(loadConfig({}).chain.sweepMinMultiplier, 1);
  const s = await stack({ chain: { sweepMinWei: 0n, sweepMinMultiplier: 1 } });
  pinFees(s, 100);
  assert.equal(s.wallet.sweeper.minBalanceFor(100n * GWEI), ETH("0.0021") + 1n, "x1 and no floor: just over one gas cost, so something is left to send");
  const u = s.mkUser();
  await s.deposit(u, "0.002"); // below one gas cost: nothing would be left to send
  await s.wallet.sweeper.pass();
  assert.equal(s.db.get("SELECT COUNT(*) AS n FROM sweeps").n, 0);
  const v = s.mkUser();
  await s.deposit(v, "0.0025"); // above one gas cost, multiplier 1: swept
  await s.wallet.sweeper.pass();
  assert.deepEqual(s.db.all("SELECT user_id FROM sweeps").map((r) => r.user_id), [v.id]);
});

test("SWEEP_MIN_WEI still applies on top: dust is dropped from the sweep list, gas-deferred balances are kept", async () => {
  const s = await stack({ chain: { sweepMinWei: ETH("0.004"), sweepMinMultiplier: 1 } });
  pinFees(s, 10); // gas 0.00021
  const dust = s.mkUser(), fine = s.mkUser();
  await s.deposit(dust, "0.003");
  await s.deposit(fine, "0.01");
  await s.wallet.sweeper.pass();
  assert.deepEqual(s.db.all("SELECT user_id FROM sweeps").map((r) => r.user_id), [fine.id]);
  assert.equal(s.db.get("SELECT needs_sweep FROM deposit_addresses WHERE user_id = ?", dust.id).needs_sweep, 0, "static dust waits for the next deposit");
});

/* ------------------------------------------------------------------ mainnet economics: minimum deposit */

test("a deposit below MIN_DEPOSIT_WEI is recorded but not credited until the total at that address reaches it", async () => {
  const s = await stack({ economy: { minDeposit: ETH("0.005") } });
  const u = s.mkUser();
  const addr = s.wallet.depositAddress(u.id);
  const pendingEvents = () => s.events.filter(([id, m]) => id === u.id && m.reason === "deposit-pending");

  const h1 = await H.fund(addr, ETH("0.002"));
  await H.mine(2);
  assert.equal(await s.wallet.deposits.scanOnce(), 0, "recorded, not credited");
  assert.equal(s.bal(u), 0n);
  let row = s.db.get("SELECT * FROM deposits WHERE tx_hash = ?", h1);
  assert.equal(row.status, "pending");
  assert.equal(row.amount, ETH("0.002").toString());
  assert.equal(s.ledger.balance(ACCT.chain), 0n, "no ledger movement yet");
  assert.equal(s.wallet.balances(u.id).pendingDeposit, ETH("0.002").toString());
  assert.deepEqual(s.wallet.depositState(u.id), { min: ETH("0.005").toString(), pending: ETH("0.002").toString(), remaining: ETH("0.003").toString(), confirmations: 2 });
  assert.equal(pendingEvents().length, 1);
  assert.equal(pendingEvents()[0][1].pending, ETH("0.002").toString());
  assert.equal(pendingEvents()[0][1].minDeposit, ETH("0.005").toString());
  assert.equal(s.db.get("SELECT needs_sweep FROM deposit_addresses WHERE user_id = ?", u.id).needs_sweep, 0, "nothing to sweep: nothing was credited");

  const h2 = await H.fund(addr, ETH("0.002"));
  await H.mine(2);
  assert.equal(await s.wallet.deposits.scanOnce(), 0, "0.004 in total is still below 0.005");
  assert.equal(s.bal(u), 0n);
  assert.equal(s.wallet.depositState(u.id).remaining, ETH("0.001").toString());

  // a cursor rewind re-sees both transfers: still not credited, and not counted twice
  s.db.run("UPDATE chain_state SET value = ? WHERE key = 'last_scanned'", String(row.block_number - 1));
  assert.equal(await s.wallet.deposits.scanOnce(), 0);
  assert.equal(s.wallet.balances(u.id).pendingDeposit, ETH("0.004").toString());

  const h3 = await H.fund(addr, ETH("0.002"));
  await H.mine(2);
  assert.equal(await s.wallet.deposits.scanOnce(), 3, "the third transfer lifts the total to 0.006: all three are credited together");
  assert.equal(s.bal(u), ETH("0.006"));
  for (const h of [h1, h2, h3]) {
    row = s.db.get("SELECT * FROM deposits WHERE tx_hash = ?", h);
    assert.equal(row.status, "credited");
    assert.ok(row.credited_at > 0);
    assert.ok(s.ledger.has(`deposit:${h}`), "one ledger entry per transfer");
  }
  assert.equal(s.ledger.balance(ACCT.chain), -ETH("0.006"));
  assert.equal(s.wallet.balances(u.id).pendingDeposit, "0");
  assert.equal(s.wallet.depositState(u.id).remaining, "0");
  assert.equal(s.db.get("SELECT needs_sweep FROM deposit_addresses WHERE user_id = ?", u.id).needs_sweep, 1);
  assert.ok(s.events.some(([id, m]) => id === u.id && m.reason === "deposit" && m.txHash === h3));
  assert.ok(s.ledger.audit().ok);

  // once credited, a small top-up is a new pending amount again (the minimum applies to what is waiting at the address)
  await H.fund(addr, ETH("0.001"));
  await H.mine(2);
  assert.equal(await s.wallet.deposits.scanOnce(), 0);
  assert.equal(s.wallet.balances(u.id).pendingDeposit, ETH("0.001").toString());
  assert.equal(s.bal(u), ETH("0.006"));
});

test("a single deposit at or above the minimum is credited at once; with no minimum (testnets) every deposit is", async () => {
  const s = await stack({ economy: { minDeposit: ETH("0.005") } });
  const u = s.mkUser();
  await s.deposit(u, "0.005");
  assert.equal(s.bal(u), ETH("0.005"));
  assert.equal(s.db.get("SELECT status FROM deposits WHERE user_id = ?", u.id).status, "credited");
  const t = await stack();
  assert.equal(t.cfg.economy.minDeposit, 0n);
  const v = t.mkUser();
  await t.deposit(v, "0.000001");
  assert.equal(t.bal(v), ETH("0.000001"));
});

test("pending deposits are not counted as surplus in the solvency view", async () => {
  const s = await stack({ economy: { minDeposit: ETH("0.005") } });
  const u = s.mkUser();
  await s.deposit(u, "0.002");
  const sol = await s.wallet.solvency();
  assert.equal(sol.pendingDeposits, ETH("0.002").toString());
  assert.equal(sol.assets, ETH("0.002").toString());
  assert.equal(sol.surplus, "0", "money that is already owed to a depositor is not spare money");
  assert.equal(sol.solvent, true);
});

/* ------------------------------------------------------------------ mainnet economics: withdrawal network fee */

const FEE_FIXED = { withdrawalFee: { mode: "fixed", fixed: ETH("0.01"), marginBps: 0 } };

test("withdrawal fee (fixed): charged on top, its own ledger entry in house:gas, the recipient gets the full amount, audit clean", async () => {
  const s = await stack({ economy: FEE_FIXED });
  await s.fundTreasury(5);
  const u = s.mkUser();
  await s.deposit(u, "1");

  const w = await s.wallet.withdrawals.request({ userId: u.id, to: u.address, amount: ETH("0.4") });
  assert.equal(w.fee, ETH("0.01").toString());
  assert.equal(w.total, ETH("0.41").toString());
  assert.equal(w.amount, ETH("0.4").toString());
  assert.equal(s.bal(u), ETH("0.59"), "the player pays amount + fee");
  assert.equal(s.ledger.balance(ACCT.withdrawal(w.id)), ETH("0.4"), "only the amount is escrowed for the payout");
  assert.equal(s.ledger.balance(ACCT.gas), ETH("0.01"), "the fee sits in its own account");
  assert.equal(s.wd(w.id).fee, ETH("0.01").toString());
  const kinds = s.ledger.statement(ACCT.user(u.id)).map((e) => [e.kind, e.amount]).reverse();
  assert.deepEqual(kinds, [["deposit", ETH(1).toString()], ["withdrawal-hold", (-ETH("0.4")).toString()], ["withdrawal-fee", (-ETH("0.01")).toString()]]);
  assert.ok(s.ledger.audit().ok, "balanced after the request");

  await s.wallet.withdrawals.pass();
  await s.finish();
  assert.equal(s.wd(w.id).status, "confirmed");
  assert.equal(await H.provider.getBalance(u.address), ETH("0.4"), "exactly the requested amount arrived, not amount minus fee");
  assert.equal(s.ledger.balance(ACCT.gas), ETH("0.01"), "the fee is kept once the withdrawal completes");
  assert.equal(s.ledger.balance(ACCT.withdrawal(w.id)), 0n);
  assert.equal(s.ledger.balance(ACCT.chain), -ETH("0.6"));
  const audit = s.ledger.audit();
  assert.deepEqual(audit.problems, []);
  assert.equal(audit.liabilities, ETH("0.6").toString(), "user 0.59 + house:gas 0.01");
  assert.equal(s.wallet.withdrawals.list(u.id)[0].fee, ETH("0.01").toString());
  assert.equal(s.wallet.withdrawals.list(u.id)[0].total, ETH("0.41").toString());
});

test("a failed withdrawal gives back the amount AND the fee, and the audit stays clean", async () => {
  const s = await stack({ economy: FEE_FIXED });
  await s.fundTreasury(5);
  const u = s.mkUser();
  await s.deposit(u, "0.5");
  await H.rpc("hardhat_setCode", [u.address, "0xfe"]); // a recipient that always reverts
  const w = await s.wallet.withdrawals.request({ userId: u.id, to: u.address, amount: ETH("0.2") });
  assert.equal(s.bal(u), ETH("0.29"));
  await s.wallet.withdrawals.pass();
  await s.finish();
  assert.equal(s.wd(w.id).status, "failed");
  assert.equal(s.bal(u), ETH("0.5"), "everything came back, fee included");
  assert.equal(s.ledger.balance(ACCT.gas), 0n);
  assert.equal(s.ledger.balance(ACCT.withdrawal(w.id)), 0n);
  assert.deepEqual(s.ledger.statement(ACCT.user(u.id)).map((e) => e.kind).reverse(), ["deposit", "withdrawal-hold", "withdrawal-fee", "withdrawal-refund", "withdrawal-fee-refund"]);
  assert.ok(s.ledger.audit().ok);
});

test("withdrawal fee (estimate): live EIP-1559 fee data x 21000 gas x (1 + margin), cached briefly, capped by the player's maxFee", async () => {
  const s = await stack({ economy: { withdrawalFee: { mode: "estimate", fixed: 0n, marginBps: 2500 } } });
  await s.fundTreasury(5);
  const u = s.mkUser();
  await s.deposit(u, "1");
  const priced = (gwei) => { s.chain.feeData = async () => ({ maxFeePerGas: 80n * GWEI, maxPriorityFeePerGas: 2n * GWEI, expectedFeePerGas: BigInt(gwei) * GWEI }); };
  priced(30);
  const expected = (gwei) => (SWEEP_GAS * BigInt(gwei) * GWEI * 125n) / 100n; // +25%

  const q = await s.wallet.withdrawals.quoteFee();
  assert.equal(q.mode, "estimate");
  assert.equal(q.fee, expected(30));
  assert.equal(q.fee, 787_500_000_000_000n, "21000 x 30 gwei x 1.25 = 0.0007875 ETH");

  // gas jumps to 60 gwei: the cached quote is still the 30 gwei one for a moment, then it is refreshed
  priced(60);
  assert.equal((await s.wallet.withdrawals.quoteFee()).fee, expected(30), "cached");
  s.clock.t += 16000;
  assert.equal((await s.wallet.withdrawals.quoteFee()).fee, expected(60));

  // the player saw the old 30 gwei fee and agreed to at most that: the request is refused, nothing is charged
  await assert.rejects(s.wallet.withdrawals.request({ userId: u.id, to: u.address, amount: ETH("0.1"), maxFee: expected(30) }), { code: "FEE_CHANGED", status: 409, extra: { fee: expected(60).toString(), maxFee: expected(30).toString() } });
  assert.equal(s.bal(u), ETH(1));
  assert.equal(s.db.get("SELECT COUNT(*) AS n FROM withdrawals").n, 0);

  const w = await s.wallet.withdrawals.request({ userId: u.id, to: u.address, amount: ETH("0.1"), maxFee: expected(60) });
  assert.equal(w.fee, expected(60).toString());
  assert.equal(s.bal(u), ETH(1) - ETH("0.1") - expected(60));
  assert.equal(s.ledger.balance(ACCT.gas), expected(60));
  await s.wallet.withdrawals.pass();
  await s.finish();
  assert.equal(await H.provider.getBalance(u.address), ETH("0.1"));
  assert.ok(s.ledger.audit().ok);

  // if fee data cannot be read, the request is refused with a retryable 503 rather than charging a guess
  s.clock.t += 16000;
  s.chain.feeData = async () => { throw new Error("connect ECONNREFUSED"); };
  await assert.rejects(s.wallet.withdrawals.request({ userId: u.id, to: u.address, amount: ETH("0.1") }), { code: "FEE_UNAVAILABLE", status: 503 });
  assert.ok(s.ledger.audit().ok);
});

test("the withdrawal needs balance for amount + fee, and the daily cap counts the amount only", async () => {
  const s = await stack({ economy: { ...FEE_FIXED, dailyWithdrawalCap: ETH("0.5") } });
  await s.fundTreasury(5);
  const u = s.mkUser();
  await s.deposit(u, "0.5");
  await assert.rejects(s.wallet.withdrawals.request({ userId: u.id, to: u.address, amount: ETH("0.5") }), {
    code: "INSUFFICIENT_FUNDS", status: 402, extra: { amount: ETH("0.5").toString(), fee: ETH("0.01").toString(), total: ETH("0.51").toString() },
  });
  assert.equal(s.bal(u), ETH("0.5"));
  assert.equal(s.db.get("SELECT COUNT(*) AS n FROM withdrawals").n, 0, "a refused request leaves no row");
  await s.deposit(u, "0.1");
  const w = await s.wallet.withdrawals.request({ userId: u.id, to: u.address, amount: ETH("0.5") }); // exactly the cap: the 0.01 fee does not count
  assert.equal(w.fee, ETH("0.01").toString());
  assert.equal(s.bal(u), ETH("0.09"));
  await assert.rejects(s.wallet.withdrawals.request({ userId: u.id, to: u.address, amount: ETH("0.001") }), { code: "DAILY_WITHDRAWAL_CAP" });
  assert.ok(s.ledger.audit().ok);
});

test("an idempotent retry of a withdrawal with a fee is not charged twice", async () => {
  const s = await stack({ economy: FEE_FIXED });
  const u = s.mkUser();
  await s.deposit(u, "1");
  const a = await s.wallet.withdrawals.request({ userId: u.id, to: u.address, amount: ETH("0.1"), idemKey: "k1" });
  const b = await s.wallet.withdrawals.request({ userId: u.id, to: u.address, amount: ETH("0.1"), idemKey: "k1" });
  assert.equal(b.replay, true);
  assert.equal(b.id, a.id);
  assert.equal(s.bal(u), ETH("0.89"));
  assert.equal(s.ledger.balance(ACCT.gas), ETH("0.01"), "one fee");
});

test("withdrawal fee defaults: fixed and zero outside mainnet, estimate on mainnet", () => {
  assert.deepEqual({ ...loadConfig({}).economy.withdrawalFee }, { mode: "fixed", fixed: 0n, marginBps: 2500 });
  const f = loadConfig({ WITHDRAWAL_FEE_MODE: "estimate", WITHDRAWAL_FEE_MARGIN_BPS: "1000" }).economy.withdrawalFee;
  assert.equal(f.mode, "estimate");
  assert.equal(f.marginBps, 1000);
  assert.equal(loadConfig({ WITHDRAWAL_FEE_MODE: "fixed", WITHDRAWAL_FEE_WEI: "123" }).economy.withdrawalFee.fixed, 123n);
  assert.throws(() => loadConfig({ WITHDRAWAL_FEE_MODE: "free" }), /WITHDRAWAL_FEE_MODE/);
});

/* ------------------------------------------------------------------ mainnet economics: solvency */

test("solvency compares treasury + unswept deposit balances with ledger liabilities", async () => {
  const s = await stack();
  await s.fundTreasury(2);
  const u = s.mkUser();
  await s.deposit(u, "1"); // sits unswept at the deposit address
  const sol = await s.wallet.solvency();
  assert.equal(sol.treasuryBalance, ETH(2).toString());
  assert.equal(sol.depositAddressBalances, ETH(1).toString(), "unswept deposits count as assets");
  assert.equal(sol.assets, ETH(3).toString());
  assert.equal(sol.liabilities, ETH(1).toString());
  assert.equal(sol.surplus, ETH(2).toString());
  assert.equal(sol.solvent, true);
  assert.equal(sol.insolvent, false);
  assert.equal(sol.network, "local");
  assert.equal(s.logs.filter(([lvl]) => lvl === "error").length, 0);
});

test("insolvency is reported and logged as a loud ERROR on every check", async () => {
  const s = await stack();
  const u = s.mkUser();
  await s.deposit(u, "0.5");
  // the ledger now owes 5 ETH that is not on-chain (a bug, a hack, or a hot wallet that was drained)
  s.ledger.post({ kind: "deposit", ref: "phantom", uniq: "phantom:1", entries: [[ACCT.chain, -ETH(5)], [ACCT.user(u.id), ETH(5)]] });
  const sol = await s.wallet.solvency();
  assert.equal(sol.insolvent, true);
  assert.equal(sol.solvent, false);
  assert.equal(BigInt(sol.surplus), ETH("0.5") - ETH("5.5"));
  const errs = s.logs.filter(([lvl, m]) => lvl === "error" && /INSOLVENT/.test(m));
  assert.equal(errs.length, 1);
  assert.equal(errs[0][2].deficit, ETH(5).toString());
  await s.wallet.solvency();
  assert.equal(s.logs.filter(([lvl, m]) => lvl === "error" && /INSOLVENT/.test(m)).length, 2, "it keeps shouting while the books are short");
});

test("a deficit no larger than the withdrawals in flight is not insolvency (the money has left, the escrow has not yet been released)", async () => {
  const s = await stack({ chain: { sweepMinWei: 0n } });
  await s.fundTreasury("0.01");
  const u = s.mkUser();
  await s.deposit(u, "1");
  await s.wallet.sweeper.pass();
  await s.wallet.sweeper.pass(); // the deposit now sits in the treasury
  const w = await s.wallet.withdrawals.request({ userId: u.id, to: u.address, amount: ETH("0.9") });
  await s.wallet.withdrawals.pass(); // paid on-chain, but not `confirmations` deep: still escrowed in the ledger
  assert.equal(s.wd(w.id).status, "broadcast");
  const mid = await s.wallet.solvency();
  assert.ok(BigInt(mid.surplus) < 0n, "the chain really is below the ledger for now");
  assert.equal(mid.inFlightWithdrawals, ETH("0.9").toString());
  assert.equal(mid.insolvent, false, "explained by the withdrawal in flight");
  assert.equal(s.logs.filter(([lvl]) => lvl === "error").length, 0);
  assert.ok(s.logs.some(([lvl, m]) => lvl === "warn" && /in flight/.test(m)));
  await s.finish();
  const done = await s.wallet.solvency();
  assert.equal(done.inFlightWithdrawals, "0");
  assert.equal(done.insolvent, false);
  assert.ok(BigInt(done.surplus) >= 0n);
});

test("the background solvency monitor logs INSOLVENT without anyone calling the admin API", async () => {
  const s = await stack({ chain: { solvencyCheckMs: 60 } });
  const u = s.mkUser();
  s.ledger.post({ kind: "deposit", ref: "phantom", uniq: "phantom:2", entries: [[ACCT.chain, -ETH(1)], [ACCT.user(u.id), ETH(1)]] });
  s.wallet.start();
  try {
    for (let i = 0; i < 100 && !s.logs.some(([lvl, m]) => lvl === "error" && /INSOLVENT/.test(m)); i++) await new Promise((r) => setTimeout(r, 50));
    assert.ok(s.logs.some(([lvl, m]) => lvl === "error" && /INSOLVENT/.test(m)));
  } finally { await s.wallet.stop(); }
});
