/* WalletService: one object the API talks to for everything on-chain. */
import { ACCT } from "../ledger.js";
import { big, toStr } from "../util/amounts.js";
import { AppError, safeMessage } from "../util/errors.js";
import { KeyManager, resolveMnemonic } from "./keys.js";
import { connectChain } from "./chain.js";
import { DepositWatcher } from "./deposits.js";
import { Sweeper } from "./sweeper.js";
import { Withdrawals } from "./withdrawals.js";

export class WalletService {
  constructor({ db, ledger, cfg, log, bus, chain, keys, now }) {
    Object.assign(this, { db, ledger, cfg, log, bus, chain, keys, now });
    this.enabled = !!chain;
    this.monitor = null;
    this.lastSolvency = null;
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
    // chain guard first: a wrong or mainnet-without-opt-in RPC must fail before any key material is touched
    const chain = await connectChain({ ...cfg.chain, network: cfg.network });
    if (cfg.devFaucet && chain.network !== "local") {
      chain.destroy();
      throw new Error(`Refusing to start: the dev faucet is enabled but chain id ${chain.chainId} is not a local chain.`);
    }
    const keys = new KeyManager(resolveMnemonic(cfg, log));
    log.info(chain.realMoney ? "connected to MAINNET (real money)" : "connected to test network",
      { chainId: chain.chainId, name: chain.meta.name, network: chain.network, treasury: keys.treasury().address });
    if (chain.realMoney) {
      log.warn("real-money mode: the HD_MNEMONIC controls every deposit address and the treasury. Keep the treasury small and sweep surplus to cold storage.", { treasury: keys.treasury().address });
    }
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
    const every = this.cfg.chain.solvencyCheckMs;
    if (every > 0) {
      const check = () => this.solvency().catch((e) => this.log.warn("solvency check failed", { error: safeMessage(e) }));
      this.monitor = setInterval(check, every);
      this.monitor.unref?.();
      this.firstCheck = setTimeout(check, 10000); // not at the very instant of boot: let the deposit watcher settle first
      this.firstCheck.unref?.();
    }
  }
  /* stop the timers, let any pass that is mid-flight finish, then release the RPC connection */
  async stop() {
    if (!this.enabled) return;
    this.deposits.stop();
    this.sweeper.stop();
    this.withdrawals.stop();
    if (this.monitor) clearInterval(this.monitor);
    if (this.firstCheck) clearTimeout(this.firstCheck);
    this.monitor = this.firstCheck = null;
    await Promise.allSettled([this.deposits.current, this.sweeper.current, this.withdrawals.current]);
    this.chain.destroy();
  }

  chainInfo() {
    if (!this.enabled) return null;
    const c = this.chain;
    return {
      id: c.chainId, name: c.meta.name, symbol: c.meta.symbol, explorer: c.meta.explorer, confirmations: this.cfg.chain.confirmations,
      network: c.meta.network, realMoney: c.meta.realMoney,
    };
  }

  /* "mainnet" | "testnet" | "local"; a server without a wallet moves no money at all, so it reports "local" */
  network() { return this.enabled ? this.chain.meta.network : "local"; }

  /* the minimum-deposit rule as the player sees it: min, what is waiting below it, and what is still missing */
  depositState(userId) {
    const min = this.cfg.economy.minDeposit;
    const pending = this.enabled ? this.deposits.pendingForUser(userId) : 0n;
    const remaining = pending > 0n && min > pending ? min - pending : 0n; // more needed to release the waiting deposits; 0 when none wait
    return { min: toStr(min), pending: toStr(pending), remaining: toStr(remaining), confirmations: this.cfg.chain.confirmations };
  }

  depositAddress(userId) {
    this.require();
    return this.deposits.addressFor(userId);
  }

  balances(userId) {
    return {
      available: toStr(this.ledger.balance(ACCT.user(userId))),
      pendingWithdrawal: this.enabled ? toStr(this.withdrawals.pendingTotal(userId)) : "0",
      pendingDeposit: this.enabled ? toStr(this.deposits.pendingForUser(userId)) : "0", // seen on-chain, below the minimum deposit, not credited yet
    };
  }

  /* cheap health snapshot for /health */
  status() {
    if (!this.enabled) return { enabled: false };
    return { enabled: true, chainId: this.chain.chainId, network: this.chain.meta.network, ...this.deposits.status(), withdrawalsUnderfunded: this.withdrawals.underfunded };
  }

  /* Operator view: does the on-chain money cover what the ledger says we owe?

       assets      = treasury balance + the balances of the deposit addresses that have received deposits (unswept money)
       liabilities = everything the ledger owes: player balances, escrows, withdrawals in flight, house fees, gas fees
       surplus     = assets - liabilities - pendingDeposits

     pendingDeposits (below the minimum, on-chain but not credited) are excluded from the surplus: that money is already owed to
     the player who sent it. A withdrawal that is mined but not yet `confirmations` deep has left the treasury while its escrow
     still sits in the ledger, so a deficit no bigger than the withdrawals in flight is reported as `inFlight` rather than insolvency.
     Anything beyond that logs an ERROR ("INSOLVENT") on every check. Costs one RPC call per address that ever received a deposit. */
  async solvency() {
    this.require();
    const audit = this.ledger.audit();
    const { provider } = this.chain;
    const treasuryAddress = this.keys.treasury().address;
    const treasury = await provider.getBalance(treasuryAddress);
    const addrs = this.db.all("SELECT DISTINCT address FROM deposits").map((r) => r.address);
    let deposits = 0n;
    for (let i = 0; i < addrs.length; i += 8) {
      const part = await Promise.all(addrs.slice(i, i + 8).map((a) => provider.getBalance(a)));
      for (const b of part) deposits += b;
    }
    const liabilities = big(audit.liabilities);
    const pendingDeposits = this.db.all("SELECT amount FROM deposits WHERE status = 'pending'").reduce((t, r) => t + big(r.amount), 0n);
    const inFlight = this.db.all("SELECT amount FROM withdrawals WHERE status IN ('signed','broadcast')").reduce((t, r) => t + big(r.amount), 0n);
    const assets = treasury + deposits;
    const surplus = assets - liabilities - pendingDeposits;
    const deficit = surplus < 0n ? -surplus : 0n;
    const insolvent = deficit > inFlight;
    const out = {
      ledgerOk: audit.ok,
      ledgerProblems: audit.problems,
      network: this.chain.meta.network,
      liabilities: audit.liabilities,
      treasuryAddress,
      treasuryBalance: toStr(treasury),
      depositAddressBalances: toStr(deposits),
      assets: toStr(assets),
      pendingDeposits: toStr(pendingDeposits),
      inFlightWithdrawals: toStr(inFlight),
      surplus: toStr(surplus),
      solvent: !insolvent && audit.ok,
      insolvent,
      checkedAt: this.now(),
      note: "A negative surplus means the treasury has paid gas out of pocket or a withdrawal is in flight; top the treasury up from your own funds. Gas for sweeps is paid from swept deposits, so it also reduces assets.",
    };
    this.lastSolvency = out;
    if (insolvent) {
      this.log.error("INSOLVENT: on-chain assets do not cover ledger liabilities. Stop and investigate; top up the treasury.", {
        assets: out.assets, liabilities: out.liabilities, deficit: toStr(deficit), inFlightWithdrawals: out.inFlightWithdrawals, treasury: out.treasuryBalance, unswept: out.depositAddressBalances,
      });
    } else if (deficit > 0n) {
      this.log.warn("assets are below liabilities by no more than the withdrawals in flight", { deficit: toStr(deficit), inFlightWithdrawals: out.inFlightWithdrawals });
    }
    if (!audit.ok) this.log.error("LEDGER AUDIT FAILED", { problems: audit.problems.slice(0, 10) });
    return out;
  }
}
