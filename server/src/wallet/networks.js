/* The chains this server knows, split by what the money on them is worth. No dependencies, so config.js can use it.

   mainnet: real money. Never accepted unless the operator opts in with NETWORK=mainnet.
   testnet: public test networks, worthless funds.
   local:   a developer's own node (Hardhat / Anvil / Ganache).

   Any chain id that is not listed here is refused outright. */

export const MAINNETS = new Map([
  [1, { name: "Ethereum", symbol: "ETH", explorer: "https://etherscan.io" }],
  [8453, { name: "Base", symbol: "ETH", explorer: "https://basescan.org" }],
]);

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

export const LOCAL_CHAIN_IDS = new Set([31337, 1337]);

/* "mainnet" | "testnet" | "local" | null (unknown chain id) */
export function networkOf(chainId) {
  if (MAINNETS.has(chainId)) return "mainnet";
  if (LOCAL_CHAIN_IDS.has(chainId)) return "local";
  if (TESTNETS.has(chainId)) return "testnet";
  return null;
}

/* name, symbol, explorer + network and realMoney, or null for a chain id we do not know */
export function chainMeta(chainId) {
  const network = networkOf(chainId);
  if (!network) return null;
  const base = MAINNETS.get(chainId) || TESTNETS.get(chainId);
  return { ...base, network, realMoney: network === "mainnet" };
}
