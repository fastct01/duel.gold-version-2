/* WalletService: one object the API talks to for everything on-chain. */
import { ACCT } from "../ledger.js";
import { big, toStr } from "../util/amounts.js";
import { AppError } from "../util/errors.js";
import { KeyManager, resolveMnemonic } from "./keys.js";
import { connectChain } from "./chain.js";
import { DepositWatcher } from "./deposits.js";
import { Sweeper } from "./sweeper.js";
import { Withdrawals } from "./withdrawals.js";

export class WalletService {
  constructor({ db, ledger, cfg, log, bus, chain, keys, now }) {
    Object.assign(this, { db, ledger, cfg, log, bus, chain, keys, now });
    this.enabled = !!chain;
    if (this.enabled) {
      const deps = { db, ledger, chain, keys, cfg, log, bus, now };
      this.deposits = new DepositWatcher(deps);
      this.sweeper = new Sweeper(deps);
      this.withdrawals = new Withdrawals(deps);
    }
  }

  static async create({ db, ledger, cfg, log, bus, now }) {
    if (!cfg.chain.rpcUrl) {
      log.warn("RPC_URL is empty: wallet features are disabled");
      return new WalletService({ db, ledger, cfg, log, bus, chain: null, keys: null, now });
    }
    const keys = new KeyManager(resolveMnemonic(cfg, log));
    const chain = await connectChain(cfg.chain);
    log.info("connected to test network", { chainId: chain.chainId, name: chain.meta.name, treasury: keys.treasury().address });
    return new WalletService({ db, ledger, cfg, log, bus, chain, keys, now });
  }

  require() {
    if (!this.enabled) throw new AppError("WALLET_DISABLED", "On-chain wallet features are not enabled on this server.", 503);
  }

  start() {
    if (!this.enabled) return;
    this.deposits.start();
    this.sweeper.start();
    this.withdrawals.start();
  }
  /* stop the timers, let any pass that is mid-flight finish, then release the RPC connection */
  async stop() {
    if (!this.enabled) return;
    this.deposits.stop();
    this.sweeper.stop();
    this.withdrawals.stop();
    await Promise.allSettled([this.deposits.current, this.sweeper.current, this.withdrawals.current]);
    this.chain.destroy();
  }

  chainInfo() {
    if (!this.enabled) return null;
    const c = this.chain;
    return { id: c.chainId, name: c.meta.name, symbol: c.meta.symbol, explorer: c.meta.explorer, confirmations: this.cfg.chain.confirmations };
  }

  depositAddress(userId) {
    this.require();
    return this.deposits.addressFor(userId);
  }

  balances(userId) {
    return {
      available: toStr(this.ledger.balance(ACCT.user(userId))),
      pendingWithdrawal: this.enabled ? toStr(this.withdrawals.pendingTotal(userId)) : "0",
    };
  }

  /* cheap health snapshot for /health */
  status() {
    if (!this.enabled) return { enabled: false };
    return { enabled: true, chainId: this.chain.chainId, ...this.deposits.status(), withdrawalsUnderfunded: this.withdrawals.underfunded };
  }

  /* Operator view: does the on-chain money cover what the ledger says we owe? Costs one RPC call per deposit address. */
  async solvency() {
    this.require();
    const audit = this.ledger.audit();
    const { provider } = this.chain;
    const treasury = await provider.getBalance(this.keys.treasury().address);
    let deposits = 0n;
    for (const r of this.db.all("SELECT address FROM deposit_addresses")) deposits += await provider.getBalance(r.address);
    const liabilities = big(audit.liabilities);
    return {
      ledgerOk: audit.ok,
      ledgerProblems: audit.problems,
      liabilities: audit.liabilities,
      treasuryAddress: this.keys.treasury().address,
      treasuryBalance: toStr(treasury),
      depositAddressBalances: toStr(deposits),
      assets: toStr(treasury + deposits),
      surplus: toStr(treasury + deposits - liabilities),
      note: "A negative surplus means the treasury has paid gas out of pocket or a withdrawal is in flight; top the treasury up from a faucet.",
    };
  }
}
