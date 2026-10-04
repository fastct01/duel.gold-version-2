/* Withdrawals: a crash-safe state machine.

     request → funds move user → escrow:withdrawal:<id>, row = queued
     queued  → the treasury signs; the RAW signed tx is stored BEFORE it is broadcast          (row = signed)
     signed  → broadcast (re-sent after a crash: same bytes, same hash, so it cannot pay twice)  (row = broadcast)
     broadcast → mined and `confirmations` deep → escrow → external:chain                        (row = confirmed)
               → reverted, or provably replaced/dropped → escrow → user (refund)                  (row = failed)

   "Provably dropped" means the treasury's confirmed nonce has moved past this tx's nonce while our hash still has no
   receipt and is unknown to the node, for long enough that RPC lag cannot explain it. Anything less keeps waiting and
   re-broadcasting, because refunding a transaction that later mines would pay the player twice.

   Payouts go only to the address the player signed in with. Gas is paid by the treasury; the player is charged a network fee
   on top of the amount (WITHDRAWAL_FEE_MODE: the current gas estimate plus a margin, or a fixed amount). The fee is its own
   ledger entry (user → house:gas), taken in the same transaction as the hold and given back with the refund if the
   withdrawal fails. The recipient always receives exactly the amount asked for.
   Only this class may send from the treasury key, so it owns the treasury nonce sequence.                          */
import { Transaction } from "ethers";
import { ACCT } from "../ledger.js";
import { AppError, bad, conflict, safeMessage } from "../util/errors.js";
import { big, toStr } from "../util/amounts.js";
import { broadcast } from "./broadcast.js";
import { checksum } from "../util/address.js";

const TRANSFER_GAS = 21000n;
const DAY = 24 * 3600000;
const FEE_CACHE_MS = 15000;
const IDEM_RE = /^[A-Za-z0-9_-]{1,64}$/;

export class Withdrawals {
  constructor({ db, ledger, chain, keys, cfg, log, bus, now = () => Date.now() }) {
    Object.assign(this, { db, ledger, chain, keys, cfg, log, bus, now });
    this.timer = null;
    this.current = null;
    this.rerun = false;
    this.underfunded = false;
    this.feeCache = null; // { at, fee, gasPrice } for the estimate mode
  }

  /* What a withdrawal costs in network fee right now: { mode, fee: BigInt, ... }. In estimate mode the number comes from the
     provider's EIP-1559 fee data (never hard-coded): gas of a plain transfer × the expected price × (1 + margin). Cached briefly. */
  async quoteFee() {
    const f = this.cfg.economy.withdrawalFee;
    if (f.mode === "fixed") return { mode: "fixed", fee: f.fixed, marginBps: 0 };
    const t = this.now();
    if (!this.feeCache || t - this.feeCache.at > FEE_CACHE_MS || t < this.feeCache.at) {
      let d;
      try { d = await this.chain.feeData(); }
      catch (e) {
        this.log.warn("could not read fee data for a withdrawal quote", { error: safeMessage(e) });
        throw new AppError("FEE_UNAVAILABLE", "The network fee cannot be estimated right now. Try again in a moment.", 503);
      }
      const price = d.expectedFeePerGas ?? d.maxFeePerGas;
      this.feeCache = { at: t, gasPrice: price, fee: (TRANSFER_GAS * price * BigInt(10000 + f.marginBps) + 9999n) / 10000n };
    }
    return { mode: "estimate", fee: this.feeCache.fee, gasPrice: this.feeCache.gasPrice, marginBps: f.marginBps };
  }

  view(r) {
    const fee = big(r.fee ?? "0");
    return {
      id: r.id, amount: r.amount, fee: toStr(fee), total: toStr(big(r.amount) + fee), to: checksum(r.to_address), status: r.status, txHash: r.tx_hash, blockNumber: r.block_number,
      error: r.error, createdAt: r.created_at, updatedAt: r.updated_at,
      explorerUrl: r.tx_hash && this.chain.meta.explorer ? `${this.chain.meta.explorer}/tx/${r.tx_hash}` : null,
    };
  }
  list(userId, limit = 20) {
    return this.db.all("SELECT * FROM withdrawals WHERE user_id = ? ORDER BY id DESC LIMIT ?", userId, limit).map((r) => this.view(r));
  }
  pendingTotal(userId) {
    return this.db.all(`SELECT amount FROM withdrawals WHERE user_id = ? AND status IN ('queued','signed','broadcast')`, userId)
      .reduce((s, r) => s + big(r.amount), 0n);
  }

  /* Ask to withdraw `amount` wei to the player's own sign-in address. The player pays `amount + fee`; the recipient gets `amount`.
     `maxFee` (optional) is the most network fee the player agreed to: a quote above it is refused with FEE_CHANGED. */
  async request({ userId, to, amount, idemKey = null, maxFee = null }) {
    const e = this.cfg.economy;
    if (idemKey != null && !IDEM_RE.test(idemKey)) throw bad("BAD_IDEMPOTENCY_KEY", "Idempotency-Key must be 1–64 characters: letters, numbers, dash or underscore.");
    if (amount < e.minWithdrawal) throw bad("BELOW_MINIMUM", `The minimum withdrawal is ${e.minWithdrawal} wei.`, { min: toStr(e.minWithdrawal) });
    if (amount > e.maxWithdrawal) throw bad("ABOVE_MAXIMUM", `The maximum single withdrawal is ${e.maxWithdrawal} wei.`, { max: toStr(e.maxWithdrawal) });

    const quote = await this.quoteFee();
    const fee = quote.fee;
    if (maxFee != null && fee > maxFee) {
      throw conflict("FEE_CHANGED", "The network fee went up since you looked. Review it and try again.", { fee: toStr(fee), maxFee: toStr(maxFee) });
    }

    const out = this.db.tx(() => {
      if (idemKey) {
        const prior = this.db.get("SELECT * FROM withdrawals WHERE user_id = ? AND idem_key = ?", userId, idemKey);
        if (prior) {
          if (big(prior.amount) !== amount) throw conflict("IDEMPOTENCY_MISMATCH", "That Idempotency-Key was already used with a different amount.");
          return { row: prior, replay: true };
        }
      }
      const since = this.now() - DAY;
      const recent = this.db.all("SELECT amount FROM withdrawals WHERE user_id = ? AND created_at > ? AND status != 'failed'", userId, since)
        .reduce((s, r) => s + big(r.amount), 0n);
      if (recent + amount > e.dailyWithdrawalCap) {
        throw new AppError("DAILY_WITHDRAWAL_CAP", "That would exceed your rolling 24-hour withdrawal limit.", 403, { cap: toStr(e.dailyWithdrawalCap), used: toStr(recent) });
      }
      if (this.ledger.balance(ACCT.user(userId)) < amount + fee) {
        throw new AppError("INSUFFICIENT_FUNDS", "Not enough balance: a withdrawal needs the amount plus the network fee.", 402, { amount: toStr(amount), fee: toStr(fee), total: toStr(amount + fee) });
      }
      const id = Number(this.db.run(
        "INSERT INTO withdrawals (user_id, to_address, amount, fee, status, idem_key, created_at, updated_at) VALUES (?, ?, ?, ?, 'queued', ?, ?, ?)",
        userId, to, toStr(amount), toStr(fee), idemKey, this.now(), this.now()).lastInsertRowid);
      this.ledger.transfer(ACCT.user(userId), ACCT.withdrawal(id), amount, { kind: "withdrawal-hold", ref: id, uniq: `wd-hold:${id}` });
      if (fee > 0n) this.ledger.transfer(ACCT.user(userId), ACCT.gas, fee, { kind: "withdrawal-fee", ref: id, uniq: `wd-fee:${id}`, memo: `network fee (${quote.mode})` });
      return { row: this.db.get("SELECT * FROM withdrawals WHERE id = ?", id), replay: false };
    });
    if (!out.replay) {
      this.bus.notify(userId, { type: "wallet.updated", reason: "withdrawal-requested", withdrawalId: out.row.id });
      this.pass(); // don't wait for the next tick
    }
    return { ...this.view(out.row), replay: out.replay };
  }

  /* ---- state machine passes ---- */

  /* Run the state machine. A call made while a pass is running waits for it and then runs once more,
     so a request that arrives mid-pass is never left until the next timer tick. */
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
      await this.#trackBroadcast();
      const stuck = await this.#resendSigned();
      if (!stuck) await this.#signQueued();
    } catch (e) {
      this.log.warn("withdrawal pass failed; will retry", { error: safeMessage(e) });
    }
  }

  async #signQueued() {
    const queued = this.db.all("SELECT * FROM withdrawals WHERE status = 'queued' ORDER BY id");
    if (!queued.length) { this.underfunded = false; return; }
    const { provider, chainId } = this.chain;
    const treasury = this.keys.treasury();
    const { maxFeePerGas, maxPriorityFeePerGas } = await this.chain.feeData();
    const gasCost = TRANSFER_GAS * maxFeePerGas;
    let available;
    try { available = await provider.getBalance(treasury.address, "pending"); }
    catch { available = await provider.getBalance(treasury.address); }

    for (const row of queued) {
      const amount = big(row.amount);
      if (available < amount + gasCost) {
        if (!this.underfunded) this.log.warn("treasury cannot cover the next withdrawal; it stays queued until the treasury is funded", { treasury: treasury.address, need: toStr(amount + gasCost), have: toStr(available) });
        this.underfunded = true;
        this.db.run("UPDATE withdrawals SET error = 'treasury_underfunded', updated_at = ? WHERE id = ? AND status = 'queued'", this.now(), row.id);
        return; // keep FIFO order
      }
      this.underfunded = false;
      const nonce = await provider.getTransactionCount(treasury.address, "pending");
      const raw = await treasury.signTransaction({ type: 2, chainId, nonce, to: row.to_address, value: amount, gasLimit: TRANSFER_GAS, maxFeePerGas, maxPriorityFeePerGas });
      const hash = Transaction.from(raw).hash;
      // durable BEFORE broadcast
      const changed = this.db.run("UPDATE withdrawals SET status = 'signed', nonce = ?, tx_hash = ?, raw_tx = ?, error = NULL, updated_at = ? WHERE id = ? AND status = 'queued'",
        nonce, hash, raw, this.now(), row.id).changes;
      if (!changed) continue;
      available -= amount + gasCost;
      const res = await broadcast(provider, raw);
      if (res.ok || res.nonceUsed) {
        // nonceUsed: our tx or a foreign one holds this nonce — #trackBroadcast settles which by receipt
        this.db.run("UPDATE withdrawals SET status = 'broadcast', broadcast_at = ?, updated_at = ? WHERE id = ?", this.now(), this.now(), row.id);
        this.log.info("withdrawal broadcast", { id: row.id, userId: row.user_id, txHash: hash, nonce });
        this.bus.notify(row.user_id, { type: "wallet.updated", reason: "withdrawal-broadcast", withdrawalId: row.id, txHash: hash });
      } else {
        // stays 'signed'; #resendSigned retries the same bytes and nothing later is signed until it goes out (nonce order)
        this.log.warn("withdrawal broadcast failed; will retry the same signed transaction", { id: row.id, error: res.error });
        return;
      }
    }
  }

  /* re-send signed-but-not-broadcast rows (crash recovery). Returns true if one is still stuck. */
  async #resendSigned() {
    let stuck = false;
    const { provider } = this.chain;
    for (const row of this.db.all("SELECT * FROM withdrawals WHERE status = 'signed' ORDER BY id")) {
      // a broadcast call can fail after the node accepted the tx, so look for a receipt before sending again
      let sent = !!(await provider.getTransactionReceipt(row.tx_hash));
      if (!sent) {
        const res = await broadcast(provider, row.raw_tx);
        sent = res.ok || !!res.nonceUsed;
        if (!sent) this.log.warn("signed withdrawal still cannot be broadcast", { id: row.id, error: res.error });
      }
      if (sent) this.db.run("UPDATE withdrawals SET status = 'broadcast', broadcast_at = ?, updated_at = ? WHERE id = ? AND status = 'signed'", this.now(), this.now(), row.id);
      else { stuck = true; break; }
    }
    return stuck;
  }

  async #trackBroadcast() {
    const rows = this.db.all("SELECT * FROM withdrawals WHERE status = 'broadcast' ORDER BY id");
    if (!rows.length) return;
    const { provider } = this.chain;
    const head = await provider.getBlockNumber();
    const treasury = this.keys.treasury().address;
    for (const row of rows) {
      const receipt = await provider.getTransactionReceipt(row.tx_hash);
      if (receipt) {
        if (head - receipt.blockNumber + 1 < this.cfg.chain.confirmations) continue; // mined, waiting for depth
        if (receipt.status === 1) this.#finalize(row, receipt.blockNumber);
        else this.#fail(row, "reverted on-chain");
        continue;
      }
      const age = this.now() - (row.broadcast_at ?? row.updated_at);
      if (age < this.cfg.chain.rebroadcastAfterMs) continue;
      const latest = await provider.getTransactionCount(treasury, "latest");
      if (latest > row.nonce && age > 2 * this.cfg.chain.rebroadcastAfterMs) {
        // the nonce is spent; if our hash is still unknown to the node it can never mine
        const [again, known] = await Promise.all([provider.getTransactionReceipt(row.tx_hash), provider.getTransaction(row.tx_hash)]);
        if (!again && !known) this.#fail(row, "transaction was dropped or replaced");
      } else {
        await broadcast(provider, row.raw_tx);
      }
    }
  }

  #finalize(row, blockNumber) {
    const done = this.db.tx(() => {
      const c = this.db.run("UPDATE withdrawals SET status = 'confirmed', block_number = ?, error = NULL, updated_at = ? WHERE id = ? AND status = 'broadcast'", blockNumber, this.now(), row.id).changes;
      if (!c) return false;
      this.ledger.transfer(ACCT.withdrawal(row.id), ACCT.chain, big(row.amount), { kind: "withdrawal", ref: row.id, uniq: `wd-final:${row.id}`, memo: row.tx_hash });
      return true;
    });
    if (done) {
      this.log.info("withdrawal confirmed", { id: row.id, txHash: row.tx_hash });
      this.bus.notify(row.user_id, { type: "wallet.updated", reason: "withdrawal-confirmed", withdrawalId: row.id, txHash: row.tx_hash });
    }
  }

  #fail(row, reason) {
    const done = this.db.tx(() => {
      const c = this.db.run(`UPDATE withdrawals SET status = 'failed', error = ?, updated_at = ? WHERE id = ? AND status IN ('queued','signed','broadcast')`, reason, this.now(), row.id).changes;
      if (!c) return false;
      this.ledger.transfer(ACCT.withdrawal(row.id), ACCT.user(row.user_id), big(row.amount), { kind: "withdrawal-refund", ref: row.id, uniq: `wd-refund:${row.id}`, memo: reason });
      const fee = big(row.fee ?? "0");
      if (fee > 0n) this.ledger.transfer(ACCT.gas, ACCT.user(row.user_id), fee, { kind: "withdrawal-fee-refund", ref: row.id, uniq: `wd-fee-refund:${row.id}`, memo: reason });
      return true;
    });
    if (done) {
      this.log.warn("withdrawal failed and was refunded", { id: row.id, userId: row.user_id, reason });
      this.bus.notify(row.user_id, { type: "wallet.updated", reason: "withdrawal-failed", withdrawalId: row.id });
    }
  }

  start() {
    this.pass();
    this.timer = setInterval(() => this.pass(), this.cfg.chain.withdrawIntervalMs);
    this.timer.unref?.();
  }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }
}
