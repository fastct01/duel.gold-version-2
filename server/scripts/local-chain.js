#!/usr/bin/env node
/* Local EVM test chain for development (Hardhat node, chain id 31337, instant mining).

     npm run chain                                   start on :8545
     npm run chain -- --port 9545                    another port
     npm run chain -- --fund 0xAbc…,0xDef… --amount 5   also send 5 test ETH to each address once it is up

   Point the server at it with RPC_URL=http://127.0.0.1:8545 (see .env.example). The accounts Hardhat prints are public
   knowledge — never use them anywhere real. */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JsonRpcProvider, Wallet, parseEther, isAddress } from "ethers";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const opt = (name, d) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : d; };
const port = Number(opt("port", 8545));
const fund = String(opt("fund", "")).split(",").map((s) => s.trim()).filter(Boolean);
const amount = String(opt("amount", "10"));
for (const a of fund) if (!isAddress(a)) { console.error(`--fund: "${a}" is not an address`); process.exit(2); }

const child = spawn(process.execPath, [path.join(root, "node_modules/hardhat/internal/cli/bootstrap.js"), "node", "--port", String(port), "--hostname", "127.0.0.1"], {
  cwd: root, stdio: "inherit", env: { ...process.env, HARDHAT_DISABLE_TELEMETRY_PROMPT: "true" },
});
child.on("exit", (code) => process.exit(code ?? 0));
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => child.kill(sig));

if (fund.length) {
  const provider = new JsonRpcProvider(`http://127.0.0.1:${port}`, 31337, { staticNetwork: true, cacheTimeout: -1 });
  // Hardhat's well-known development key #0
  const faucet = new Wallet("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80", provider);
  for (let i = 0; i < 100; i++) {
    try { await provider.getBlockNumber(); break; } catch { await new Promise((r) => setTimeout(r, 200)); }
  }
  for (const to of fund) {
    const tx = await faucet.sendTransaction({ to, value: parseEther(amount) });
    await tx.wait();
    console.log(`funded ${to} with ${amount} test ETH (${tx.hash})`);
  }
}
