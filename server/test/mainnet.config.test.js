/* Real-money guards: NETWORK=mainnet is an explicit opt-in, every setting it needs is required, and the mainnet defaults. */
import test, { after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { HDNodeWallet } from "ethers";
import { loadConfig, SERVER_ROOT } from "../src/config.js";
import { createApp } from "../src/app.js";

const ETH = 10n ** 18n;
const MNEMONIC = HDNodeWallet.createRandom().mnemonic.phrase;

/* the smallest environment NETWORK=mainnet accepts */
const GOOD = {
  NETWORK: "mainnet", NODE_ENV: "production", CHAIN_ID: "1", RPC_URL: "https://eth-mainnet.example/v2/KEY",
  HD_MNEMONIC: MNEMONIC, ALLOWED_ORIGINS: "https://duel.example", PUBLIC_DOMAIN: "duel.example", TRUST_PROXY: "true",
};
const without = (k) => { const e = { ...GOOD }; delete e[k]; return e; };

/* ------------------------------------------------------------------ required settings */

test("NETWORK=mainnet with a complete environment loads", () => {
  const c = loadConfig(GOOD);
  assert.equal(c.mainnet, true);
  assert.equal(c.network, "mainnet");
  assert.equal(c.chain.expectedChainId, 1);
  assert.equal(c.trustProxy, true);
  assert.deepEqual(c.allowedOrigins, ["https://duel.example"]);
  assert.equal(loadConfig({ ...GOOD, CHAIN_ID: "8453", TRUST_PROXY: "false" }).chain.expectedChainId, 8453, "Base mainnet is supported");
  assert.equal(loadConfig({ ...GOOD, TRUST_PROXY: "false" }).trustProxy, false, "an explicit false is fine, it only has to be set");
});

test("every missing mainnet requirement fails with a message that names it", () => {
  const cases = [
    ["NODE_ENV", /NODE_ENV=production is required/],
    ["HD_MNEMONIC", /HD_MNEMONIC is required/],
    ["ALLOWED_ORIGINS", /ALLOWED_ORIGINS must list your front-end origin/],
    ["PUBLIC_DOMAIN", /PUBLIC_DOMAIN must be your real public host name/],
    ["CHAIN_ID", /CHAIN_ID is required/],
    ["TRUST_PROXY", /TRUST_PROXY must be set explicitly/],
    ["RPC_URL", /RPC_URL is required/],
  ];
  for (const [key, re] of cases) assert.throws(() => loadConfig(without(key)), re, `${key} missing`);
  // an empty value is the same as missing
  for (const [key, re] of cases) assert.throws(() => loadConfig({ ...GOOD, [key]: "" }), re, `${key} empty`);
});

test("all problems are reported together, and the message says what to do", () => {
  let msg = "";
  try { loadConfig({ NETWORK: "mainnet" }); } catch (e) { msg = e.message; }
  for (const word of ["NODE_ENV=production", "HD_MNEMONIC", "ALLOWED_ORIGINS", "PUBLIC_DOMAIN", "CHAIN_ID", "TRUST_PROXY", "RPC_URL"]) assert.match(msg, new RegExp(word));
  assert.match(msg, /NETWORK=mainnet/);
});

test("NODE_ENV must be exactly production", () => {
  for (const env of ["development", "test", "staging", "Production"]) assert.throws(() => loadConfig({ ...GOOD, NODE_ENV: env }), /NODE_ENV=production/, env);
});

test("ALLOWED_ORIGINS: no wildcard, https only, plain origins", () => {
  assert.throws(() => loadConfig({ ...GOOD, ALLOWED_ORIGINS: "*" }), /"\*" is not allowed/);
  assert.throws(() => loadConfig({ ...GOOD, ALLOWED_ORIGINS: "https://duel.example,*" }), /"\*" is not allowed/);
  assert.throws(() => loadConfig({ ...GOOD, ALLOWED_ORIGINS: "http://duel.example" }), /https origin/);
  assert.throws(() => loadConfig({ ...GOOD, ALLOWED_ORIGINS: "https://duel.example/" }), /no trailing slash/);
  assert.throws(() => loadConfig({ ...GOOD, ALLOWED_ORIGINS: "duel.example" }), /https origin/);
  assert.deepEqual(loadConfig({ ...GOOD, ALLOWED_ORIGINS: "https://duel.example, https://www.duel.example" }).allowedOrigins, ["https://duel.example", "https://www.duel.example"]);
});

test("PUBLIC_DOMAIN must be a real host: not localhost, no scheme, no port", () => {
  for (const d of ["localhost", "127.0.0.1", "0.0.0.0", "::1", "app.localhost", "https://duel.example", "duel.example:8787", "duel.example/play"]) {
    assert.throws(() => loadConfig({ ...GOOD, PUBLIC_DOMAIN: d }), /PUBLIC_DOMAIN/, d);
  }
  assert.equal(loadConfig({ ...GOOD, PUBLIC_DOMAIN: "play.duel.example" }).publicDomain, "play.duel.example");
});

test("CHAIN_ID must be a supported mainnet; TRUST_PROXY must be a boolean", () => {
  for (const id of ["11155111", "31337", "137", "10"]) assert.throws(() => loadConfig({ ...GOOD, CHAIN_ID: id }), /not a supported mainnet/, id);
  assert.throws(() => loadConfig({ ...GOOD, TRUST_PROXY: "maybe" }), /TRUST_PROXY must be true or false/);
});

test("the dev faucet can never be switched on with NETWORK=mainnet", () => {
  assert.throws(() => loadConfig(GOOD, { devFaucet: true }), /dev faucet can never be enabled/);
});

test("NETWORK itself is validated", () => {
  assert.throws(() => loadConfig({ NETWORK: "prod" }), /NETWORK must be one of/);
  assert.throws(() => loadConfig({ NETWORK: "ethereum" }), /NETWORK must be one of/);
  for (const n of ["testnet", "local", "", "MAINNET "]) {
    if (n.trim().toLowerCase() === "mainnet") assert.throws(() => loadConfig({ NETWORK: n }), /refusing to start with NETWORK=mainnet/, "case and whitespace are forgiven, the requirements are not");
    else assert.doesNotThrow(() => loadConfig({ NETWORK: n }));
  }
});

/* ------------------------------------------------------------------ the opt-in works both ways */

test("a mainnet CHAIN_ID without NETWORK=mainnet is refused before any RPC call", () => {
  for (const id of ["1", "8453"]) {
    assert.throws(() => loadConfig({ CHAIN_ID: id }), /mainnet where funds have real value.*NETWORK=mainnet/s, id);
    assert.throws(() => loadConfig({ CHAIN_ID: id, NODE_ENV: "production", HD_MNEMONIC: MNEMONIC, ALLOWED_ORIGINS: "https://duel.example", NETWORK: "testnet" }), /NETWORK=mainnet/, id);
  }
  assert.equal(loadConfig({ CHAIN_ID: "11155111" }).chain.expectedChainId, 11155111, "a testnet id needs no opt-in");
});

/* ------------------------------------------------------------------ defaults */

test("test and local defaults are unchanged", () => {
  const c = loadConfig({});
  assert.equal(c.chain.confirmations, 6);
  assert.equal(c.chain.rpcUrl, "http://127.0.0.1:8545");
  assert.equal(c.chain.sweepMinMultiplier, 1);
  assert.equal(c.chain.solvencyCheckMs, 0);
  assert.equal(c.economy.minStake, ETH / 10000n);
  assert.equal(c.economy.maxStake, ETH / 20n);
  assert.deepEqual(c.economy.stakeTiers, [ETH / 2000n, ETH / 1000n, ETH * 25n / 10000n, ETH * 5n / 1000n, ETH / 100n]);
  assert.equal(c.economy.minDeposit, 0n);
  assert.equal(c.economy.minWithdrawal, ETH / 10000n);
  assert.equal(c.economy.withdrawalFee.mode, "fixed");
  assert.equal(c.economy.withdrawalFee.fixed, 0n);
});

test("mainnet defaults: 12 confirmations, 3x sweep gas, 0.005 minimum deposit, stake 0.001 to 0.05, estimated withdrawal fee", () => {
  const c = loadConfig(GOOD);
  assert.equal(c.chain.confirmations, 12);
  assert.equal(c.chain.sweepMinMultiplier, 3);
  assert.equal(c.chain.solvencyCheckMs, 300000);
  assert.equal(c.economy.minDeposit, 5_000_000_000_000_000n, "0.005 ETH");
  assert.equal(c.economy.minStake, ETH / 1000n, "0.001");
  assert.equal(c.economy.maxStake, ETH / 20n, "0.05");
  assert.deepEqual(c.economy.stakeTiers, [ETH / 1000n, ETH * 25n / 10000n, ETH * 5n / 1000n, ETH / 100n, ETH * 25n / 1000n], "0.001 / 0.0025 / 0.005 / 0.01 / 0.025");
  assert.equal(c.economy.minWithdrawal, ETH / 1000n);
  assert.equal(c.economy.maxWithdrawal, ETH, "unchanged");
  assert.equal(c.economy.dailyWithdrawalCap, 2n * ETH, "unchanged");
  assert.equal(c.economy.withdrawalFee.mode, "estimate");
  assert.equal(c.economy.feeBps, 1000);
});

test("every mainnet default can be overridden from the environment", () => {
  const c = loadConfig({
    ...GOOD, CONFIRMATIONS: "20", SWEEP_MIN_MULTIPLIER: "5", SWEEP_MIN_WEI: "7", MIN_DEPOSIT_WEI: "9", MIN_STAKE_WEI: "2000000000000000",
    MAX_STAKE_WEI: "30000000000000000", STAKE_TIERS_WEI: "2000000000000000,30000000000000000", MIN_WITHDRAWAL_WEI: "11", WITHDRAWAL_FEE_MODE: "fixed",
    WITHDRAWAL_FEE_WEI: "12", SOLVENCY_CHECK_MS: "1000",
  });
  assert.deepEqual([c.chain.confirmations, c.chain.sweepMinMultiplier, c.chain.sweepMinWei, c.economy.minDeposit], [20, 5, 7n, 9n]);
  assert.deepEqual([c.economy.minStake, c.economy.maxStake, c.economy.stakeTiers.length, c.economy.minWithdrawal], [2_000_000_000_000_000n, 30_000_000_000_000_000n, 2, 11n]);
  assert.deepEqual([c.economy.withdrawalFee.mode, c.economy.withdrawalFee.fixed, c.chain.solvencyCheckMs], ["fixed", 12n, 1000]);
  assert.throws(() => loadConfig({ ...GOOD, SWEEP_MIN_MULTIPLIER: "0" }), /SWEEP_MIN_MULTIPLIER/);
  assert.throws(() => loadConfig({ ...GOOD, STAKE_TIERS_WEI: "1" }), /outside/);
});

test("the public queue settings are gone from the config", () => {
  const c = loadConfig({ PUBLIC_QUEUE: "1", QUEUE_TIMEOUT_MS: "5", RATING_WINDOW: "9" });
  for (const k of ["publicQueue", "queueTimeoutMs", "disconnectQueueMs", "ratingBase", "ratingGrowthPerSec", "ratingMax", "pairIntervalMs", "lobbyCacheMs"]) {
    assert.equal(c.match[k], undefined, `match.${k} must not exist`);
  }
  assert.ok(c.match.lobbyTtlMs > 0 && c.match.lobbyMaxPlayers >= 2, "lobbies stay configurable");
});

test(".env.example loads as it is, and adding the mainnet requirements gives the mainnet defaults (it must not pin test values)", () => {
  const env = {};
  for (const line of fs.readFileSync(path.join(SERVER_ROOT, ".env.example"), "utf8").split("\n")) {
    const m = /^([A-Z_]+)=(\S*)/.exec(line); // KEY=value, anything after whitespace is a comment
    if (m) env[m[1]] = m[2];
  }
  assert.ok(Object.keys(env).length > 5);
  assert.doesNotThrow(() => loadConfig(env));
  const real = loadConfig({ ...env, NETWORK: "mainnet", NODE_ENV: "production", CHAIN_ID: "1", RPC_URL: "https://rpc.example", HD_MNEMONIC: MNEMONIC, ALLOWED_ORIGINS: "https://duel.example", PUBLIC_DOMAIN: "duel.example", TRUST_PROXY: "true" });
  assert.equal(real.chain.confirmations, 12);
  assert.equal(real.economy.minDeposit, 5_000_000_000_000_000n);
  assert.equal(real.economy.minStake, ETH / 1000n);
  assert.equal(real.economy.withdrawalFee.mode, "estimate");
  assert.equal(real.chain.sweepMinMultiplier, 3);
  // and the template alone, with only NETWORK=mainnet, is refused (nothing in it satisfies the mainnet requirements by accident)
  assert.throws(() => loadConfig({ ...env, NETWORK: "mainnet" }), /refusing to start with NETWORK=mainnet/);
});

/* ------------------------------------------------------------------ secrets */

test("the mnemonic and the admin token stay out of JSON and console output of the config", () => {
  const c = loadConfig({ ...GOOD, ADMIN_TOKEN: "a-very-long-admin-token-0123456789" });
  const text = JSON.stringify(c, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
  assert.ok(!text.includes(MNEMONIC.split(" ")[0] + " " + MNEMONIC.split(" ")[1]), "mnemonic not serialised");
  assert.ok(!text.includes("a-very-long-admin-token"), "admin token not serialised");
  assert.equal(c.keys.mnemonic, MNEMONIC, "but it is still there for the key manager");
  assert.equal(c.adminToken, "a-very-long-admin-token-0123456789");
});

test("no log call in the source can print a mnemonic or a private key", () => {
  const root = path.join(SERVER_ROOT, "src");
  const files = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) (e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith(".js") && files.push(path.join(d, e.name))); };
  walk(root);
  const bad = [];
  for (const f of files) {
    const src = fs.readFileSync(f, "utf8");
    // a log call is `log.<level>(` or `this.log.<level>(` up to the end of its statement
    for (const m of src.matchAll(/\blog\.(debug|info|warn|error)\(([^;]*?)\);/gs)) {
      // look at identifiers only: the words inside plain string literals ("HD_MNEMONIC is not set") print nothing secret
      const code = m[2].replace(/`(?:[^`\\]|\\.)*`/gs, (t) => [...t.matchAll(/\$\{([^}]*)\}/g)].map((x) => x[1]).join(" ")).replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, "");
      if (/mnemonic|phrase|privateKey|private_key|secret|adminToken|signingKey/i.test(code)) bad.push(`${path.relative(SERVER_ROOT, f)}: ${m[0].slice(0, 100)}`);
    }
  }
  assert.deepEqual(bad, [], "log calls that mention key material");
});

/* ------------------------------------------------------------------ a mainnet server end to end, against a fake RPC */

/* answers eth_chainId and eth_blockNumber and refuses everything else, echoing request ids */
const fakeNode = (chainId) => new Promise((resolve) => {
  const srv = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const answer = (m) => {
        if (m.method === "eth_chainId") return { jsonrpc: "2.0", id: m.id, result: "0x" + chainId.toString(16) };
        if (m.method === "eth_blockNumber") return { jsonrpc: "2.0", id: m.id, result: "0x64" };
        return { jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "not available in this test" } };
      };
      const parsed = JSON.parse(body || "{}");
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(Array.isArray(parsed) ? parsed.map(answer) : answer(parsed)));
    });
  });
  srv.listen(0, "127.0.0.1", () => resolve(srv));
});

const servers = [];
const apps = [];
after(async () => { for (const a of apps) await a.stop().catch(() => {}); for (const s of servers) s.close(); });

async function bootMainnet(chainId, env = {}) {
  const node = await fakeNode(chainId);
  servers.push(node);
  const config = loadConfig({
    ...GOOD, RPC_URL: `http://127.0.0.1:${node.address().port}/v2/SECRETAPIKEY`, PORT: "0", HOST: "127.0.0.1", LOG_LEVEL: "debug",
    ADMIN_TOKEN: "mainnet-admin-token-0123456789ab", ...env,
  }, { dbPath: ":memory:", chain: { pollMs: 50, solvencyCheckMs: 0 } });
  const app = await createApp(config);
  apps.push(app);
  return app;
}

/* capture stderr while `fn` runs */
async function captureLogs(fn) {
  const chunks = [];
  const real = process.stderr.write;
  process.stderr.write = (c, ...rest) => { chunks.push(String(c)); return typeof rest[rest.length - 1] === "function" ? rest[rest.length - 1]() : true; };
  try { await fn(); } finally { process.stderr.write = real; }
  return chunks.join("");
}

test("a mainnet server reports network, realMoney and the mainnet economics in GET /v1/config, and never logs the mnemonic, keys or RPC URL", async () => {
  const logs = await captureLogs(async () => {
    const app = await bootMainnet(1);
    await app.start();
    const cfg = await fetch(app.url + "/v1/config").then((r) => r.json());
    assert.equal(cfg.network, "mainnet");
    assert.equal(cfg.chain.realMoney, true);
    assert.equal(cfg.chain.network, "mainnet");
    assert.deepEqual([cfg.chain.id, cfg.chain.name, cfg.chain.symbol, cfg.chain.explorer, cfg.chain.confirmations], [1, "Ethereum", "ETH", "https://etherscan.io", 12]);
    assert.match(cfg.notice, /Real money/);
    assert.equal(cfg.deposit.min, "5000000000000000");
    assert.equal(cfg.withdrawal.feeMode, "estimate");
    assert.equal(cfg.withdrawal.feeMarginBps, 2500);
    assert.deepEqual(cfg.stake.tiers, ["1000000000000000", "2500000000000000", "5000000000000000", "10000000000000000", "25000000000000000"]);
    assert.equal(cfg.stake.min, "1000000000000000");
    assert.equal(cfg.stake.max, "50000000000000000");
    assert.equal(cfg.devFaucet, undefined);
    assert.equal(cfg.match.publicQueue, undefined);
    assert.equal(cfg.age.requiredForStakes, true);
    assert.equal((await fetch(app.url + "/v1/health").then((r) => r.json())).wallet.network, "mainnet");
    // the faucet does not exist here, on any path or method
    for (const method of ["POST", "GET"]) assert.equal((await fetch(app.url + "/v1/dev/faucet", { method, headers: { "content-type": "application/json" }, body: method === "POST" ? "{}" : undefined })).status, 404);
    await app.stop();
  });
  assert.ok(logs.includes("connected to MAINNET"), "the operator is told which network this is");
  assert.ok(logs.includes("treasury"), "the treasury address is logged");
  assert.ok(!logs.includes(MNEMONIC.split(" ").slice(0, 3).join(" ")), "not even the first words of the mnemonic");
  assert.ok(!logs.includes(MNEMONIC), "the mnemonic is never logged");
  assert.ok(!/privateKey|private key/i.test(logs), "no private key material in the logs");
  assert.ok(!logs.includes("SECRETAPIKEY"), "the RPC URL (it carries the API key) is never logged");
});

test("Base mainnet is accepted with CHAIN_ID=8453 and reports its own explorer", async () => {
  const app = await bootMainnet(8453, { CHAIN_ID: "8453" });
  await app.start();
  const cfg = await fetch(app.url + "/v1/config").then((r) => r.json());
  assert.deepEqual([cfg.network, cfg.chain.id, cfg.chain.name, cfg.chain.explorer, cfg.chain.realMoney], ["mainnet", 8453, "Base", "https://basescan.org", true]);
});

test("startup refuses a mainnet RPC without the opt-in, and a testnet or local RPC with it", async () => {
  // opt-in missing: the config itself says so (CHAIN_ID) ...
  assert.throws(() => loadConfig({ NODE_ENV: "production", HD_MNEMONIC: MNEMONIC, ALLOWED_ORIGINS: "https://duel.example", CHAIN_ID: "1" }), /NETWORK=mainnet/);
  // ... and when CHAIN_ID was left out, the chain guard still catches the mainnet RPC
  const node = await fakeNode(1);
  servers.push(node);
  const cfg = loadConfig({ NODE_ENV: "production", HD_MNEMONIC: MNEMONIC, ALLOWED_ORIGINS: "https://duel.example", RPC_URL: `http://127.0.0.1:${node.address().port}`, PORT: "0" }, { dbPath: ":memory:" });
  await assert.rejects(createApp(cfg), /MAINNET.*NETWORK=mainnet is not set/s);

  for (const [id, what] of [[11155111, "test network"], [84532, "test network"], [31337, "local development chain"]]) {
    await assert.rejects(bootMainnet(id), new RegExp(`NETWORK=mainnet but the RPC reports chain id ${id}.*${what}`, "s"), `chain ${id}`);
  }
  // CHAIN_ID that disagrees with the RPC
  await assert.rejects(bootMainnet(8453, { CHAIN_ID: "1" }), /RPC reports chain id 8453 but CHAIN_ID is 1/);
});

test("a deployment with a plain, non-mainnet config still starts on a testnet RPC (no opt-in needed there)", async () => {
  const node = await fakeNode(11155111);
  servers.push(node);
  const cfg = loadConfig({ NODE_ENV: "test", RPC_URL: `http://127.0.0.1:${node.address().port}`, PORT: "0", HOST: "127.0.0.1", LOG_LEVEL: "silent", HD_MNEMONIC: MNEMONIC }, { dbPath: ":memory:" });
  const app = await createApp(cfg);
  apps.push(app);
  await app.start();
  const c = await fetch(app.url + "/v1/config").then((r) => r.json());
  assert.deepEqual([c.network, c.chain.realMoney, c.chain.id], ["testnet", false, 11155111]);
  assert.match(c.notice, /Test network only/);
});

test("without a wallet the server reports network local and no real money", async () => {
  const cfg = loadConfig({ NODE_ENV: "test", PORT: "0", HOST: "127.0.0.1", LOG_LEVEL: "silent" }, { dbPath: ":memory:", chain: { rpcUrl: "" } });
  const app = await createApp(cfg);
  apps.push(app);
  await app.start();
  const c = await fetch(app.url + "/v1/config").then((r) => r.json());
  assert.equal(c.network, "local");
  assert.equal(c.chain, null);
});
