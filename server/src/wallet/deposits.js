/* Deposits: every player has their own deposit address (HD-derived, see keys.js). The watcher walks the chain block by
   block — only blocks that are already `confirmations` deep, so a reorg cannot un-credit a deposit — and credits any
   top-level value transfer to a known deposit address. Crediting is idempotent (tx hash is the key) and the scan
   cursor advances in the same DB transaction as the credits, so a crash can neither lose nor repeat a deposit.

   Known limit: transfers made *inside* a contract call (e.g. from a multisig or smart-contract wallet) are not
   top-level transactions and are not seen. Players deposit from a normal wallet (EOA).                             */
import { ACCT } from "../ledger.js";
import { toStr } from "../util/amounts.js";
import { safeMessage } from "../util/errors.js";

const MAX_BLOCKS_PER_PASS = 200;

export class DepositWatcher {
  constructor({ db, ledger, chain, keys, cfg, log, bus, now = () => Date.now() }) {
    Object.assign(this, { db, ledger, chain, keys, cfg, log, bus, now });
    this.byAddress = new Map(); // lowercase address -> userId
    this.timer = null;
    this.current = null;
    this.lastError = null;
    this.lastHead = null;
    for (const r of db.all("SELECT user_id, address FROM deposit_addresses")) this.byAddress.set(r.address, r.user_id);
  }

  /* the player's deposit address, allocated on first use (derivation index = player id) */
  addressFor(userId) {
    const row = this.db.get("SELECT address FROM deposit_addresses WHERE user_id = ?", userId);
    if (row) return row.address;
    const address = this.keys.userAddress(userId);
    this.db.run("INSERT OR IGNORE INTO deposit_addresses (user_id, idx, address, created_at) VALUES (?, ?, ?, ?)", userId, userId, address, this.now());
    this.byAddress.set(address, userId);
    return address;
  }

  #cursor() {
    const r = this.db.get("SELECT value FROM chain_state WHERE key = 'last_scanned'");
    return r ? Number(r.value) : null;
  }
  #setCursor(n) {
    this.db.run("INSERT INTO chain_state (key, value) VALUES ('last_scanned', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", String(n));
  }

  /* DB part of crediting one deposit (call inside a transaction). Returns true if it credited, false if already known. */
  #creditRows({ txHash, blockNumber, address, userId, amount }) {
    const ins = this.db.run("INSERT OR IGNORE INTO deposits (tx_hash, user_id, address, amount, block_number, credited_at) VALUES (?, ?, ?, ?, ?, ?)",
      txHash, userId, address, toStr(amount), blockNumber, this.now());
    if (ins.changes === 0) return false;
    this.ledger.post({
      kind: "deposit", ref: txHash, uniq: `deposit:${txHash}`, memo: `on-chain deposit in block ${blockNumber}`,
      entries: [[ACCT.chain, -amount], [ACCT.user(userId), amount]],
    });
    this.db.run("UPDATE deposit_addresses SET needs_sweep = 1 WHERE user_id = ?", userId);
    return true;
  }

  #announce(h) {
    this.log.info("deposit credited", { userId: h.userId, txHash: h.txHash, amount: toStr(h.amount), blockNumber: h.blockNumber });
    this.bus.notify(h.userId, { type: "wallet.updated", reason: "deposit", txHash: h.txHash, amount: toStr(h.amount) });
  }

  /* Credit one deposit. Safe to call twice for the same tx. Returns true if it credited. */
  credit(h) {
    const credited = this.db.tx(() => this.#creditRows(h));
    if (credited) this.#announce(h);
    return credited;
  }

  /* One pass: scan every confirmed block we have not seen yet. Returns the number of deposits credited. */
  async scanOnce() {
    const head = await this.chain.provider.getBlockNumber();
    this.lastHead = head;
    const safe = head - this.cfg.chain.confirmations + 1;
    let last = this.#cursor();
    if (last == null) {
      // first run: nothing can have been sent to addresses that did not exist yet, so start at the tip
      last = this.cfg.chain.startBlock != null ? this.cfg.chain.startBlock - 1 : Math.max(safe, 0);
      this.#setCursor(last);
    }
    if (safe <= last) return 0;
    const to = Math.min(safe, last + MAX_BLOCKS_PER_PASS);
    let credited = 0;
    for (let n = last + 1; n <= to; n++) {
      const block = await this.chain.provider.getBlock(n, true);
      if (!block) throw new Error(`block ${n} is not available from the RPC yet`);
      const hits = [];
      for (const tx of block.prefetchedTransactions) {
        if (!tx.to || tx.value <= 0n) continue;
        const address = tx.to.toLowerCase();
        const userId = this.byAddress.get(address);
        if (userId != null) hits.push({ txHash: tx.hash, blockNumber: n, address, userId, amount: tx.value });
      }
      const fresh = this.db.tx(() => {
        const done = hits.filter((h) => this.#creditRows(h));
        this.#setCursor(n);
        return done;
      });
      for (const h of fresh) this.#announce(h); // only after the transaction committed
      credited += fresh.length;
    }
    return credited;
  }

  tick() {
    if (this.current) return this.current;
    this.current = (async () => {
      try {
        await this.scanOnce();
        this.lastError = null;
      } catch (e) {
        this.lastError = safeMessage(e); // shown on the public /health, so never the raw RPC error
        this.log.warn("deposit scan failed; will retry", { error: this.lastError });
      } finally {
        this.current = null;
      }
    })();
    return this.current;
  }

  start() {
    this.tick();
    this.timer = setInterval(() => this.tick(), this.cfg.chain.pollMs);
    this.timer.unref?.();
  }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }

  status() {
    const cursor = this.#cursor();
    return { lastScannedBlock: cursor, head: this.lastHead, lag: this.lastHead != null && cursor != null ? Math.max(0, this.lastHead - this.cfg.chain.confirmations + 1 - cursor) : null, lastError: this.lastError };
  }
}
