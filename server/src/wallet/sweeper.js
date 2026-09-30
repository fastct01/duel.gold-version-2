/* Sweeper: moves confirmed deposits from the per-player deposit addresses into the treasury so it has liquidity to
   pay withdrawals. It never touches the ledger — players were credited when the deposit confirmed; this is only
   plumbing. Sweep gas is paid out of the swept funds (so the treasury receives slightly less than was credited).
   A failed or dropped sweep just leaves the funds where they are; the next pass retries. */
import { Transaction } from "ethers";
import { broadcast } from "./broadcast.js";
import { toStr } from "../util/amounts.js";
import { safeMessage } from "../util/errors.js";

const TRANSFER_GAS = 21000n;

export class Sweeper {
  constructor({ db, chain, keys, cfg, log, now = () => Date.now() }) {
    Object.assign(this, { db, chain, keys, cfg, log, now });
    this.timer = null;
    this.current = null;
    this.rerun = false;
  }

  /* Same coalescing rule as Withdrawals.pass: a call during a pass waits, then runs once more. */
  pass() {
    if (this.current) { this.rerun = true; return this.current; }
    this.current = (async () => {
      try {
        do { this.rerun = false; await this.#once(); } while (this.rerun);
      } finally { this.current = null; }
    })();
    return this.current;
  }

  async #once() {
    try {
      await this.#settle();
      await this.#sweepNew();
    } catch (e) {
      this.log.warn("sweep pass failed; will retry", { error: safeMessage(e) });
    }
  }

  async #settle() {
    const { provider } = this.chain;
    for (const s of this.db.all("SELECT * FROM sweeps WHERE status = 'pending'")) {
      const receipt = await provider.getTransactionReceipt(s.tx_hash);
      if (receipt) {
        const ok = receipt.status === 1;
        this.db.tx(() => {
          this.db.run("UPDATE sweeps SET status = ?, updated_at = ? WHERE id = ?", ok ? "confirmed" : "failed", this.now(), s.id);
          if (!ok) this.db.run("UPDATE deposit_addresses SET needs_sweep = 1 WHERE user_id = ?", s.user_id);
        });
        continue;
      }
      if (this.now() - s.created_at < this.cfg.chain.rebroadcastAfterMs) continue;
      const tx = Transaction.from(s.raw_tx);
      const latest = await provider.getTransactionCount(s.address, "latest");
      if (latest > tx.nonce && !(await provider.getTransactionReceipt(s.tx_hash))) {
        this.db.tx(() => {
          this.db.run("UPDATE sweeps SET status = 'failed', updated_at = ? WHERE id = ?", this.now(), s.id);
          this.db.run("UPDATE deposit_addresses SET needs_sweep = 1 WHERE user_id = ?", s.user_id);
        });
      } else {
        await broadcast(provider, s.raw_tx);
      }
    }
  }

  async #sweepNew() {
    const rows = this.db.all(
      `SELECT d.user_id, d.idx, d.address FROM deposit_addresses d
        WHERE d.needs_sweep = 1 AND NOT EXISTS (SELECT 1 FROM sweeps s WHERE s.user_id = d.user_id AND s.status = 'pending')`);
    if (!rows.length) return;
    const { provider, chainId } = this.chain;
    const { maxFeePerGas, maxPriorityFeePerGas } = await this.chain.feeData();
    const gasCost = TRANSFER_GAS * maxFeePerGas;
    const treasury = this.keys.treasury().address;

    for (const r of rows) {
      const balance = await provider.getBalance(r.address);
      if (balance < this.cfg.chain.sweepMinWei || balance <= gasCost) {
        this.db.run("UPDATE deposit_addresses SET needs_sweep = 0 WHERE user_id = ?", r.user_id); // dust waits for the next deposit
        continue;
      }
      const value = balance - gasCost;
      const nonce = await provider.getTransactionCount(r.address, "pending");
      const raw = await this.keys.user(r.idx).signTransaction({
        type: 2, chainId, nonce, to: treasury, value, gasLimit: TRANSFER_GAS, maxFeePerGas, maxPriorityFeePerGas,
      });
      const hash = Transaction.from(raw).hash;
      // persist first, then broadcast: a crash in between leaves a pending row that #settle re-sends
      this.db.tx(() => {
        this.db.run("INSERT INTO sweeps (user_id, address, amount, tx_hash, raw_tx, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)",
          r.user_id, r.address, toStr(value), hash, raw, this.now(), this.now());
        this.db.run("UPDATE deposit_addresses SET needs_sweep = 0 WHERE user_id = ?", r.user_id);
      });
      const res = await broadcast(provider, raw);
      if (!res.ok) {
        this.log.warn("sweep broadcast failed", { userId: r.user_id, error: res.error });
        this.db.tx(() => {
          this.db.run("UPDATE sweeps SET status = 'failed', updated_at = ? WHERE tx_hash = ?", this.now(), hash);
          this.db.run("UPDATE deposit_addresses SET needs_sweep = 1 WHERE user_id = ?", r.user_id);
        });
      } else {
        this.log.info("sweep sent", { userId: r.user_id, txHash: hash, amount: toStr(value) });
      }
    }
  }

  start() {
    this.timer = setInterval(() => this.pass(), this.cfg.chain.sweepIntervalMs);
    this.timer.unref?.();
  }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }
}
