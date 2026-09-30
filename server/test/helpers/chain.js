/* Spawns a real local EVM node (Hardhat) for integration tests and talks to it over JSON-RPC, exactly like production
   talks to Sepolia. */
import { spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JsonRpcProvider, Wallet } from "ethers";

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); });
  s.on("error", reject);
});

// Hardhat's well-known dev key #0, funded with 10,000 ETH on the local chain only
const FAUCET_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

export async function startChain() {
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(serverRoot, "node_modules/hardhat/internal/cli/bootstrap.js"), "node", "--port", String(port), "--hostname", "127.0.0.1"], {
    cwd: serverRoot,
    env: { ...process.env, HARDHAT_DISABLE_TELEMETRY_PROMPT: "true" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (d) => (output += d));
  child.stderr.on("data", (d) => (output += d));
  const url = `http://127.0.0.1:${port}`;
  const provider = new JsonRpcProvider(url, 31337, { staticNetwork: true, cacheTimeout: -1 });

  const deadline = Date.now() + 60000;
  for (;;) {
    try { await provider.getBlockNumber(); break; }
    catch {
      if (child.exitCode != null) throw new Error("hardhat node exited early:\n" + output);
      if (Date.now() > deadline) { child.kill(); throw new Error("hardhat node did not start:\n" + output); }
      await new Promise((r) => setTimeout(r, 150));
    }
  }
  const faucet = new Wallet(FAUCET_KEY, provider);
  const rpc = (method, params = []) => provider.send(method, params);
  const chain = {
    url, provider, faucet, rpc,
    /* send ETH from the faucet and wait until it is mined */
    async fund(to, wei) { const tx = await faucet.sendTransaction({ to, value: wei }); await tx.wait(); return tx.hash; },
    async mine(n = 1) { await rpc("hardhat_mine", ["0x" + n.toString(16)]); },
    async stop() { provider.destroy(); child.kill("SIGKILL"); await new Promise((r) => child.once("exit", r)); },
  };
  return chain;
}
