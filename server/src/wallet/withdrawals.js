/* Withdrawals: a crash-safe state machine.

     request → funds move user → escrow:withdrawal:<id>, row = queued
     queued  → the treasury signs; the RAW signed tx is stored BEFORE it is broadcast          (row = signed)
     signed  → broadcast (re-sent after a crash: same bytes, same hash, so it cannot pay twice)  (row = broadcast)
     broadcast → mined and `confirmations` deep → escrow → external:chain                        (row = confirmed)
               → reverted, or provably replaced/dropped → escrow → user (refund)                  (row = failed)

   "Provably dropped" means the treasury's confirmed nonce has moved past this tx's nonce while our hash still has no
   receipt and is unknown to the node, for long enough that RPC lag cannot explain it. Anything less keeps waiting and
   re-broadcasting, because refunding a transaction that later mines would pay the player twice.

   Payouts go only to the address the player signed in with. Gas is paid by the treasury.
   Only this class may send from the treasury key, so it owns the treasury nonce sequence.                          */
import { Transaction } from "ethers";
import { ACCT } from "../ledger.js";
import { AppError, bad, conflict, safeMessage } from "../util/errors.js";
import { big, toStr } from "../util/amounts.js";
import { broadcast } from "./broadcast.js";
import { checksum } from "../util/address.js";

const TRANSFER_GAS = 21000n;
const DAY = 24 * 3600000;
const IDEM_RE = /^[A-Za-z0-9_-]{1,64}$/;

export class Withdrawals {
  constructor({ db, ledger, chain, keys, cfg, log, bus, now = () => Date.now() }) {
    Object.assign(this, { db, ledger, chain, keys, cfg, log, bus, now });
    this.timer = null;
    this.current = null;
    this.rerun = false;
    this.underfunded = false;
  }

  view(r) {
    return {
      id: r.id, amount: r.amount, to: checksum(r.to_address), status: r.status, txHash: r.tx_hash, blockNumber: r.block_number,
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

  /* Ask to withdraw `amount` wei to the player's own sign-in address. */
  request({ userId, to, amount, idemKey = null }) {
    const e = this.cfg.economy;
    if (idemKey != null && !IDEM_RE.test(idemKey)) throw bad("BAD_IDEMPOTENCY_KEY", "Idempotency-Key must be 1–64 characters: letters, numbers, dash or underscore.");
    if (amount < e.minWithdrawal) throw bad("BELOW_MINIMUM", `The minimum withdrawal is ${e.minWithdrawal} wei.`, { min: toStr(e.minWithdrawal) });
    if (amount > e.maxWithdrawal) throw bad("ABOVE_MAXIMUM", `The maximum single withdrawal is ${e.maxWithdrawal} wei.`, { max: toStr(e.maxWithdrawal) });

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
      const id = Number(this.db.run(
        "INSERT INTO withdrawals (user_id, to_address, amount, status, idem_key, created_at, updated_at) VALUES (?, ?, ?, 'queued', ?, ?, ?)",
        userId, to, toStr(amount), idemKey, this.now(), this.now()).lastInsertRowid);
      this.ledger.transfer(ACCT.user(userId), ACCT.withdrawal(id), amount, { kind: "withdrawal-hold", ref: id, uniq: `wd-hold:${id}` });
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
