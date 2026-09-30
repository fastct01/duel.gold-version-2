/* Local EVM test chain used by the integration tests and `npm run chain`. Not used in production. */
module.exports = {
  solidity: "0.8.24",
  networks: {
    hardhat: {
      chainId: 31337,
      // behave like geth/Sepolia: a transaction that reverts on-chain is mined with status 0, not reported as an RPC error
      throwOnTransactionFailures: false,
      throwOnCallFailures: false,
      // instant mining; the tests advance blocks explicitly to simulate confirmations
      mining: { auto: true, interval: 0 },
      accounts: { count: 10, accountsBalance: "10000000000000000000000" },
    },
  },
};
