import test from "node:test";
import assert from "node:assert/strict";
import { Db } from "../src/db/index.js";
import { Ledger, ACCT } from "../src/ledger.js";
import { splitPot, parseWei } from "../src/util/amounts.js";

const ETH = 10n ** 18n;
const fresh = () => { const db = new Db(":memory:"); return { db, ledger: new Ledger(db) }; };
const deposit = (l, user, amt, uniq) => l.post({ kind: "deposit", uniq, entries: [[ACCT.chain, -amt], [ACCT.user(user), amt]] });

test("deposit then transfer keeps every balance exact beyond 2^53", () => {
  const { ledger } = fresh();
  const huge = 123456789012345678901n; // > 2^53 wei and > 9.2e18 (SQLite INTEGER max)
  deposit(ledger, 1, huge);
  ledger.transfer(ACCT.user(1), ACCT.user(2), 1n, { kind: "t" });
  assert.equal(ledger.balance(ACCT.user(1)), huge - 1n);
  assert.equal(ledger.balance(ACCT.user(2)), 1n);
  assert.equal(ledger.balance(ACCT.chain), -huge);
  assert.deepEqual(ledger.audit().problems, []);
});

test("overdraft is refused and leaves no trace", () => {
  const { ledger, db } = fresh();
  deposit(ledger, 1, 100n);
  const before = db.get("SELECT COUNT(*) AS n FROM ledger_tx").n;
  assert.throws(() => ledger.transfer(ACCT.user(1), ACCT.user(2), 101n, { kind: "t" }), { code: "INSUFFICIENT_FUNDS" });
  assert.equal(ledger.balance(ACCT.user(1)), 100n);
  assert.equal(ledger.balance(ACCT.user(2)), 0n);
  assert.equal(db.get("SELECT COUNT(*) AS n FROM ledger_tx").n, before, "failed transfer must roll back its tx row");
  assert.ok(ledger.audit().ok);
});

test("a multi-leg transaction is all-or-nothing", () => {
  const { ledger } = fresh();
  deposit(ledger, 1, 50n);
  ledger.post({ kind: "split", entries: [[ACCT.user(1), -50n], [ACCT.user(2), 20n], [ACCT.user(3), 30n], [ACCT.user(4), 0n]] });
  assert.equal(ledger.balance(ACCT.user(2)), 20n);
  // the first two legs are fine, the third overdraws user 2 (has 20, spends 25): nothing may stick
  assert.throws(() => ledger.post({ kind: "y", entries: [[ACCT.user(3), -10n], [ACCT.user(4), 35n], [ACCT.user(2), -25n]] }), { code: "INSUFFICIENT_FUNDS" });
  assert.equal(ledger.balance(ACCT.user(3)), 30n, "the debit applied before the failure must be rolled back");
  assert.equal(ledger.balance(ACCT.user(4)), 0n);
  assert.ok(ledger.audit().ok);
});

test("unbalanced transactions are rejected", () => {
  const { ledger } = fresh();
  assert.throws(() => ledger.post({ kind: "bad", entries: [[ACCT.chain, -10n], [ACCT.user(1), 11n]] }), /unbalanced/);
  assert.equal(ledger.balance(ACCT.user(1)), 0n);
});

test("idempotency key: the same deposit can only be credited once", () => {
  const { ledger } = fresh();
  const a = deposit(ledger, 1, 5n, "deposit:0xabc");
  const b = deposit(ledger, 1, 5n, "deposit:0xabc");
  assert.equal(a.duplicate, false);
  assert.equal(b.duplicate, true);
  assert.equal(b.txId, a.txId);
  assert.equal(ledger.balance(ACCT.user(1)), 5n);
});

test("BigInt cannot be bound to SQLite by accident", () => {
  const { db } = fresh();
  assert.throws(() => db.run("SELECT ?", 5n), /BigInt/);
});

test("audit detects tampered balances", () => {
  const { ledger, db } = fresh();
  deposit(ledger, 1, 100n);
  assert.ok(ledger.audit().ok);
  db.run("UPDATE accounts SET balance = '101' WHERE id = ?", ACCT.user(1));
  const a = ledger.audit();
  assert.equal(a.ok, false);
  assert.ok(a.problems.some((p) => p.includes("user:1")));
  assert.ok(a.problems.some((p) => p.includes("does not sum to zero")));
});

test("statement lists newest first and paginates", () => {
  const { ledger } = fresh();
  for (let i = 1; i <= 5; i++) deposit(ledger, 1, BigInt(i), `d${i}`);
  const first = ledger.statement(ACCT.user(1), { limit: 2 });
  assert.deepEqual(first.map((r) => r.amount), ["5", "4"]);
  const next = ledger.statement(ACCT.user(1), { limit: 2, before: first[1].id });
  assert.deepEqual(next.map((r) => r.amount), ["3", "2"]);
});

test("nested db.tx rolls back only the inner block", () => {
  const { ledger, db } = fresh();
  deposit(ledger, 1, 10n);
  db.tx(() => {
    ledger.transfer(ACCT.user(1), ACCT.user(2), 3n, { kind: "outer" });
    assert.throws(() => db.tx(() => { ledger.transfer(ACCT.user(1), ACCT.user(2), 3n, { kind: "inner" }); throw new Error("boom"); }), /boom/);
  });
  assert.equal(ledger.balance(ACCT.user(2)), 3n);
  assert.ok(ledger.audit().ok);
});

test("async callbacks are refused inside db.tx", () => {
  const { db } = fresh();
  assert.throws(() => db.tx(async () => {}), /synchronous/);
});

test("splitPot: payout + fee always equals the pot, fee absorbs the remainder", () => {
  for (const [pot, bps] of [[2n * ETH, 1000], [3n, 1000], [1n, 1000], [999999999999999999n, 1000], [10n, 0], [7n, 333]]) {
    const { payout, fee } = splitPot(pot, bps);
    assert.equal(payout + fee, pot);
    assert.ok(payout >= 0n && fee >= 0n);
  }
  assert.deepEqual(splitPot(1000n, 1000), { payout: 900n, fee: 100n });
  assert.deepEqual(splitPot(3n, 1000), { payout: 2n, fee: 1n }); // floor(2.7)
});

test("parseWei only accepts whole non-negative amounts", () => {
  assert.equal(parseWei("123"), 123n);
  assert.equal(parseWei(42), 42n);
  for (const bad of ["-1", "1.5", "1e18", "", " 1", "0x10", 1.5, -1, 2 ** 60, null, undefined, {}, "9".repeat(41)]) {
    assert.throws(() => parseWei(bad), { code: "BAD_AMOUNT" }, String(bad));
  }
});
