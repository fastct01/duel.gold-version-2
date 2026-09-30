#!/usr/bin/env node
/* One-command development environment: a local EVM chain + the Duel.gold server with the wallet switched on,
   plus a local-only faucet so a fresh browser wallet can get test ETH.

     npm run dev                 → http://localhost:8787/play/
     npm run dev -- --fresh      wipe the dev database first
     npm run dev -- --port 9000 --chain-port 9545

   Exported as startDevStack() so the browser tests can run the very same thing on ephemeral ports.
   The faucet (POST /v1/dev/faucet) exists only here, only on chain ids 31337/1337, and is capped at 1 ETH per call. */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { JsonRpcProvider, Wallet, parseEther, isAddress, HDNodeWallet } from "ethers";
import { loadConfig, SERVER_ROOT } from "../src/config.js";
import { createApp } from "../src/app.js";
import { bad, forbidden } from "../src/util/errors.js";

const HARDHAT_KEY_0 = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"; // public, local chains only
const LOCAL_CHAINS = new Set([31337, 1337]);

async function freePort() {
  const net = await import("node:net");
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); });
    s.on("error", reject);
  });
}

export async function startDevStack({ port = 0, chainPort = 0, fresh = false, memory = false, overrides = {}, quiet = false } = {}) {
  chainPort = chainPort || (await freePort());
  const child = spawn(process.execPath, [path.join(SERVER_ROOT, "node_modules/hardhat/internal/cli/bootstrap.js"), "node", "--port", String(chainPort), "--hostname", "127.0.0.1"], {
    cwd: SERVER_ROOT, stdio: quiet ? "ignore" : ["ignore", "ignore", "inherit"], env: { ...process.env, HARDHAT_DISABLE_TELEMETRY_PROMPT: "true" },
  });
  const rpcUrl = `http://127.0.0.1:${chainPort}`;
  const provider = new JsonRpcProvider(rpcUrl, 31337, { staticNetwork: true, cacheTimeout: -1 });
  for (let i = 0; ; i++) {
    try { await provider.getBlockNumber(); break; }
    catch { if (i > 300 || child.exitCode != null) { child.kill(); throw new Error("local chain did not start"); } await new Promise((r) => setTimeout(r, 100)); }
  }
  const faucet = new Wallet(HARDHAT_KEY_0, provider);

  const dbPath = memory ? ":memory:" : path.join(SERVER_ROOT, "data", "dev.db");
  if (fresh && !memory) for (const f of [dbPath, dbPath + "-wal", dbPath + "-shm"]) fs.rmSync(f, { force: true });
  const config = loadConfig({ NODE_ENV: "development", PORT: String(port), HOST: "127.0.0.1", LOG_LEVEL: quiet ? "silent" : "info" }, {
    dbPath,
    keys: memory ? { mnemonic: HDNodeWallet.createRandom().mnemonic.phrase } : {},
    chain: { rpcUrl, confirmations: 1, pollMs: 400, sweepIntervalMs: 2000, withdrawIntervalMs: 500 },
    devFaucet: true,
    ...overrides,
  });
  const app = await createApp(config);

  /* dev-only faucet, registered here and nowhere in the production code path.
     Sends are serialised: two simultaneous requests from one key would otherwise reuse a nonce. */
  let faucetQueue = Promise.resolve();
  app.router.post("/v1/dev/faucet", { limit: "auth" }, async ({ body }) => {
    if (!LOCAL_CHAINS.has(app.wallet.chain.chainId)) throw forbidden("NOT_LOCAL", "The dev faucet only works on a local chain.");
    if (!isAddress(body.address)) throw bad("BAD_ADDRESS", "address is not a valid Ethereum address.");
    const eth = Math.min(1, Number(body.eth ?? 1));
    if (!(eth > 0)) throw bad("BAD_AMOUNT", "eth must be positive (max 1 per request).");
    const send = faucetQueue.then(async () => {
      const tx = await faucet.sendTransaction({ to: body.address, value: parseEther(String(eth)) });
      await tx.wait();
      return tx.hash;
    });
    faucetQueue = send.catch(() => {}); // a failed send must not block the next one
    return { txHash: await send, eth };
  });

  await app.start();
  await (await faucet.sendTransaction({ to: app.wallet.keys.treasury().address, value: parseEther("100") })).wait(); // hot-wallet float

  return {
    app, url: app.url, rpcUrl, provider, faucet, chainPort,
    async stop() { await app.stop(); provider.destroy(); child.kill("SIGKILL"); await new Promise((r) => child.once("exit", r)); },
  };
}

/* CLI */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
  const stack = await startDevStack({ port: Number(opt("port", 8787)), chainPort: Number(opt("chain-port", 8545)), fresh: args.includes("--fresh") });
  console.log(`\n  Duel.gold dev stack is up\n  ─────────────────────────\n  play      ${stack.url}/play/\n  api       ${stack.url}/v1/config\n  chain     ${stack.rpcUrl}  (chain id 31337, test ETH is free at /v1/dev/faucet)\n`);
  let stopping = false;
  for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, async () => { if (stopping) return; stopping = true; await stack.stop(); process.exit(0); });
}
