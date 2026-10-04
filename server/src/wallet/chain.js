/* JSON-RPC connection to an EVM network, with a hard allow-list of chain ids (see networks.js).
   A mainnet is only accepted when the operator opted in with NETWORK=mainnet, and with that opt-in only a mainnet is
   accepted: a misconfigured RPC URL must never silently move real money, or silently run a "real" deployment on a testnet. */
import { JsonRpcProvider } from "ethers";
import { MAINNETS, TESTNETS, chainMeta } from "./networks.js";

export { MAINNETS, TESTNETS };

/* Throws unless `chainId` may be used given the declared NETWORK ("mainnet" | "testnet" | "local" | falsy) and CHAIN_ID. */
export function assertChainAllowed(chainId, { network = null, expectedChainId = null } = {}) {
  const meta = chainMeta(chainId);
  if (!meta) {
    throw new Error(`Refusing to start: chain id ${chainId} is not a known network. ` +
      `Known mainnets: ${[...MAINNETS.keys()].join(", ")}; known test networks: ${[...TESTNETS.keys()].join(", ")}.`);
  }
  if (meta.network === "mainnet" && network !== "mainnet") {
    throw new Error(`Refusing to start: chain id ${chainId} (${meta.name}) is a MAINNET where funds have real value, but NETWORK=mainnet is not set. ` +
      `Set NETWORK=mainnet to run with real money on purpose, otherwise point RPC_URL at a test network.`);
  }
  if (network === "mainnet" && meta.network !== "mainnet") {
    throw new Error(`Refusing to start: NETWORK=mainnet but the RPC reports chain id ${chainId} (${meta.name}), which is a ${meta.network === "local" ? "local development chain" : "test network"}. ` +
      `Point RPC_URL at an Ethereum mainnet (${[...MAINNETS.keys()].join(" or ")}) node.`);
  }
  if (network === "local" && meta.network !== "local") {
    throw new Error(`Refusing to start: NETWORK=local but the RPC reports chain id ${chainId} (${meta.name}), which is not a local chain.`);
  }
  if (expectedChainId != null && expectedChainId !== chainId) {
    throw new Error(`RPC reports chain id ${chainId} but CHAIN_ID is ${expectedChainId}`);
  }
  return meta;
}

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

  get network() { return this.meta.network; }
  get realMoney() { return this.meta.realMoney; }

  /* EIP-1559 fee fields from the provider (never hard-coded), with a floor so a zero-priority local node still produces
     valid transactions. maxFeePerGas is the cap a transaction is signed with; expectedFeePerGas is what it is likely to
     actually pay (current base fee + tip, never above the cap) and is what fee estimates should be based on. */
  async feeData() {
    const f = await this.provider.getFeeData();
    const maxFeePerGas = f.maxFeePerGas ?? f.gasPrice ?? 1_000_000_000n;
    const maxPriorityFeePerGas = f.maxPriorityFeePerGas ?? 0n;
    const tip = maxPriorityFeePerGas > maxFeePerGas ? maxFeePerGas : maxPriorityFeePerGas;
    let expectedFeePerGas = maxFeePerGas;
    try {
      const head = await this.provider.getBlock("latest");
      if (head && head.baseFeePerGas != null) {
        const e = head.baseFeePerGas + tip;
        expectedFeePerGas = e < maxFeePerGas ? e : maxFeePerGas;
      }
    } catch { /* keep the cap as the estimate */ }
    return { maxFeePerGas, maxPriorityFeePerGas: tip, expectedFeePerGas };
  }

  destroy() { this.provider.destroy(); }
}

export async function connectChain({ rpcUrl, expectedChainId = null, network = null }) {
  const chainId = await rawChainId(rpcUrl);
  const meta = assertChainAllowed(chainId, { network, expectedChainId });
  // cacheTimeout -1: ethers memoises identical RPC calls for 250 ms by default, which would return a stale
  // getTransactionCount right after a broadcast and let two withdrawals share a nonce.
  const provider = new JsonRpcProvider(rpcUrl, chainId, { staticNetwork: true, cacheTimeout: -1 });
  return new Chain(provider, chainId, meta, rpcUrl);
}
