/* Double-entry ledger in wei.

   Every movement of value is one `ledger_tx` whose entries sum to exactly zero. Account balances are kept in step
   inside the same DB transaction, and only `external:chain` (the counter-party of deposits and withdrawals) may be
   negative — so a player, an escrow or the house can never be overdrawn. `audit()` re-derives everything from the
   entries and reports any drift.

   Accounts:
     user:<id>               spendable balance
     escrow:ticket:<id>      stake held for a queued player
     escrow:match:<id>       both stakes of a running match
     escrow:withdrawal:<id>  funds on their way out of the platform
     house:fees              collected fees
     external:chain          −(net deposits): what the platform owes the chain side                            */
import { AppError } from "./util/errors.js";
import { big, toStr } from "./util/amounts.js";

export const ACCT = {
  user: (id) => `user:${id}`,
  ticket: (id) => `escrow:ticket:${id}`,
  match: (id) => `escrow:match:${id}`,
  withdrawal: (id) => `escrow:withdrawal:${id}`,
  house: "house:fees",
  chain: "external:chain",
};

const kindOf = (id) => id.split(":")[0]; // user | escrow | house | external

export class Ledger {
  constructor(db, now = () => Date.now()) {
    this.db = db;
    this.now = now;
    this.ensure(ACCT.chain);
    this.ensure(ACCT.house);
  }

  ensure(account) {
    this.db.run("INSERT OR IGNORE INTO accounts (id, kind) VALUES (?, ?)", account, kindOf(account));
  }

  balance(account) {
    const r = this.db.get("SELECT balance FROM accounts WHERE id = ?", account);
    return r ? big(r.balance) : 0n;
  }

  has(uniq) {
    return !!this.db.get("SELECT 1 AS x FROM ledger_tx WHERE uniq = ?", uniq);
  }

  /* Post one balanced transaction. entries: [[account, signedBigInt], ...]
     With `uniq`, posting the same key twice is a no-op that returns { duplicate: true }. */
  post({ kind, ref = null, uniq = null, memo = null, entries }) {
    return this.db.tx(() => {
      if (uniq) {
        const prior = this.db.get("SELECT id FROM ledger_tx WHERE uniq = ?", uniq);
        if (prior) return { txId: prior.id, duplicate: true };
      }
      const merged = new Map();
      for (const [account, amount] of entries) {
        if (typeof amount !== "bigint") throw new TypeError("ledger amounts must be BigInt");
        merged.set(account, (merged.get(account) ?? 0n) + amount);
      }
      let sum = 0n;
      for (const v of merged.values()) sum += v;
      if (sum !== 0n) throw new Error(`unbalanced ledger transaction (${kind}): entries sum to ${sum}`);

      const txId = this.db.run("INSERT INTO ledger_tx (kind, ref, uniq, memo, created_at) VALUES (?, ?, ?, ?, ?)",
        kind, ref == null ? null : String(ref), uniq, memo, this.now()).lastInsertRowid;

      for (const [account, amount] of merged) {
        if (amount === 0n) continue;
        this.ensure(account);
        const next = this.balance(account) + amount;
        if (next < 0n && account !== ACCT.chain) {
          throw new AppError("INSUFFICIENT_FUNDS", "Not enough balance for this operation.", 402, { account: account.startsWith("user:") ? undefined : account });
        }
        this.db.run("UPDATE accounts SET balance = ? WHERE id = ?", toStr(next), account);
        this.db.run("INSERT INTO ledger_entries (tx_id, account, amount) VALUES (?, ?, ?)", txId, account, toStr(amount));
      }
      return { txId: Number(txId), duplicate: false };
    });
  }

  transfer(from, to, amount, meta) {
    if (amount <= 0n) throw new TypeError("transfer amount must be positive");
    return this.post({ ...meta, entries: [[from, -amount], [to, amount]] });
  }

  /* newest-first slice of one account's entries, for wallet history */
  statement(account, { limit = 50, before = null } = {}) {
    const rows = this.db.all(
      `SELECT e.id, e.amount, t.kind, t.ref, t.memo, t.created_at
         FROM ledger_entries e JOIN ledger_tx t ON t.id = e.tx_id
        WHERE e.account = ? ${before ? "AND e.id < ?" : ""}
        ORDER BY e.id DESC LIMIT ?`,
      ...(before ? [account, before, limit] : [account, limit]));
    return rows.map((r) => ({ id: r.id, amount: r.amount, kind: r.kind, ref: r.ref, memo: r.memo, at: r.created_at }));
  }

  /* Re-derive every balance from the entries. Returns { ok, problems, totals }. */
  audit() {
    const problems = [];
    const sums = new Map(); // account -> bigint
    const perTx = new Map(); // tx -> bigint
    for (const e of this.db.all("SELECT tx_id, account, amount FROM ledger_entries ORDER BY id")) {
      const a = big(e.amount);
      sums.set(e.account, (sums.get(e.account) ?? 0n) + a);
      perTx.set(e.tx_id, (perTx.get(e.tx_id) ?? 0n) + a);
    }
    for (const [tx, s] of perTx) if (s !== 0n) problems.push(`tx ${tx} does not sum to zero (${s})`);

    let total = 0n, liabilities = 0n;
    for (const a of this.db.all("SELECT id, balance FROM accounts")) {
      const bal = big(a.balance);
      total += bal;
      if (a.id !== ACCT.chain) liabilities += bal;
      if ((sums.get(a.id) ?? 0n) !== bal) problems.push(`account ${a.id}: stored balance ${bal} != entries ${sums.get(a.id) ?? 0n}`);
      if (bal < 0n && a.id !== ACCT.chain) problems.push(`account ${a.id} is negative (${bal})`);
    }
    if (total !== 0n) problems.push(`ledger does not sum to zero (${total})`);
    return { ok: problems.length === 0, problems, liabilities: toStr(liabilities), external: toStr(this.balance(ACCT.chain)) };
  }
}
