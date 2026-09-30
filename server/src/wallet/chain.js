/* JSON-RPC connection to an EVM test network, with a hard allow-list of test chain ids.
   This prototype must never be pointed at a network where the funds have real value. */
import { JsonRpcProvider } from "ethers";

export const TESTNETS = new Map([
  [11155111, { name: "Sepolia", symbol: "ETH", explorer: "https://sepolia.etherscan.io" }],
  [560048, { name: "Hoodi", symbol: "ETH", explorer: "https://hoodi.etherscan.io" }],
  [84532, { name: "Base Sepolia", symbol: "ETH", explorer: "https://sepolia.basescan.org" }],
  [421614, { name: "Arbitrum Sepolia", symbol: "ETH", explorer: "https://sepolia.arbiscan.io" }],
  [11155420, { name: "OP Sepolia", symbol: "ETH", explorer: "https://sepolia-optimism.etherscan.io" }],
  [80002, { name: "Polygon Amoy", symbol: "POL", explorer: "https://amoy.polygonscan.com" }],
  [31337, { name: "Local (Hardhat/Anvil)", symbol: "ETH", explorer: "" }],
  [1337, { name: "Local (Ganache)", symbol: "ETH", explorer: "" }],
]);

async function rawChainId(rpcUrl, timeoutMs = 10000) {
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`RPC ${rpcUrl} answered HTTP ${res.status}`);
  const body = await res.json();
  if (!body || typeof body.result !== "string") throw new Error(`RPC ${rpcUrl} returned no chain id`);
  return Number(BigInt(body.result));
}

export class Chain {
  constructor(provider, chainId, meta, rpcUrl) {
    this.provider = provider;
    this.chainId = chainId;
    this.meta = meta;
    this.rpcUrl = rpcUrl;
  }

  /* EIP-1559 fee fields with a floor, so a zero-priority local node still produces valid transactions */
  async feeData() {
    const f = await this.provider.getFeeData();
    const maxFeePerGas = f.maxFeePerGas ?? f.gasPrice ?? 1_000_000_000n;
    const maxPriorityFeePerGas = f.maxPriorityFeePerGas ?? 0n;
    return { maxFeePerGas, maxPriorityFeePerGas: maxPriorityFeePerGas > maxFeePerGas ? maxFeePerGas : maxPriorityFeePerGas };
  }

  destroy() { this.provider.destroy(); }
}

export async function connectChain({ rpcUrl, expectedChainId }) {
  const chainId = await rawChainId(rpcUrl);
  const meta = TESTNETS.get(chainId);
  if (!meta) {
    throw new Error(`Refusing to start: chain id ${chainId} is not a known test network. ` +
      `This server only runs on test networks (${[...TESTNETS.keys()].join(", ")}).`);
  }
  if (expectedChainId != null && expectedChainId !== chainId) {
    throw new Error(`RPC reports chain id ${chainId} but CHAIN_ID is ${expectedChainId}`);
  }
  // cacheTimeout -1: ethers memoises identical RPC calls for 250 ms by default, which would return a stale
  // getTransactionCount right after a broadcast and let two withdrawals share a nonce.
  const provider = new JsonRpcProvider(rpcUrl, chainId, { staticNetwork: true, cacheTimeout: -1 });
  return new Chain(provider, chainId, meta, rpcUrl);
}
