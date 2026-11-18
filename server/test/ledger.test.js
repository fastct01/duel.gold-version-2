import test, { after } from "node:test";
import assert from "node:assert/strict";
import { openTestDb, closeTestDbs } from "./helpers/app.js";
import { Ledger, ACCT } from "../src/ledger.js";
import { splitPot, parseWei } from "../src/util/amounts.js";

const ETH = 10n ** 18n;
after(closeTestDbs);
const fresh = async () => { const db = await openTestDb(); return { db, ledger: await new Ledger(db).init() }; };
const deposit = (l, user, amt, uniq) => l.post({ kind: "deposit", uniq, entries: [[ACCT.chain, -amt], [ACCT.user(user), amt]] });

test("deposit then transfer keeps every balance exact beyond 2^53", async () => {
  const { ledger } = await fresh();
  const huge = 123456789012345678901n; // > 2^53 wei and > 9.2e18 (a BIGINT's max): amounts are TEXT, never numbers
  await deposit(ledger, 1, huge);
  await ledger.transfer(ACCT.user(1), ACCT.user(2), 1n, { kind: "t" });
  assert.equal((await ledger.balance(ACCT.user(1))), huge - 1n);
  assert.equal((await ledger.balance(ACCT.user(2))), 1n);
  assert.equal((await ledger.balance(ACCT.chain)), -huge);
  assert.deepEqual((await ledger.audit()).problems, []);
});

test("overdraft is refused and leaves no trace", async () => {
  const { ledger, db } = await fresh();
  await deposit(ledger, 1, 100n);
  const before = (await db.get("SELECT COUNT(*) AS n FROM ledger_tx")).n;
  await assert.rejects(ledger.transfer(ACCT.user(1), ACCT.user(2), 101n, { kind: "t" }), { code: "INSUFFICIENT_FUNDS" });
  assert.equal((await ledger.balance(ACCT.user(1))), 100n);
  assert.equal((await ledger.balance(ACCT.user(2))), 0n);
  assert.equal((await db.get("SELECT COUNT(*) AS n FROM ledger_tx")).n, before, "failed transfer must roll back its tx row");
  assert.ok((await ledger.audit()).ok);
});

test("a multi-leg transaction is all-or-nothing", async () => {
  const { ledger } = await fresh();
  await deposit(ledger, 1, 50n);
  await ledger.post({ kind: "split", entries: [[ACCT.user(1), -50n], [ACCT.user(2), 20n], [ACCT.user(3), 30n], [ACCT.user(4), 0n]] });
  assert.equal((await ledger.balance(ACCT.user(2))), 20n);
  // the first two legs are fine, the third overdraws user 2 (has 20, spends 25): nothing may stick
  await assert.rejects(ledger.post({ kind: "y", entries: [[ACCT.user(3), -10n], [ACCT.user(4), 35n], [ACCT.user(2), -25n]] }), { code: "INSUFFICIENT_FUNDS" });
  assert.equal((await ledger.balance(ACCT.user(3))), 30n, "the debit applied before the failure must be rolled back");
  assert.equal((await ledger.balance(ACCT.user(4))), 0n);
  assert.ok((await ledger.audit()).ok);
});

test("unbalanced transactions are rejected", async () => {
  const { ledger } = await fresh();
  await assert.rejects(ledger.post({ kind: "bad", entries: [[ACCT.chain, -10n], [ACCT.user(1), 11n]] }), /unbalanced/);
  assert.equal((await ledger.balance(ACCT.user(1))), 0n);
});

test("idempotency key: the same deposit can only be credited once", async () => {
  const { ledger } = await fresh();
  const a = await deposit(ledger, 1, 5n, "deposit:0xabc");
  const b = await deposit(ledger, 1, 5n, "deposit:0xabc");
  assert.equal(a.duplicate, false);
  assert.equal(b.duplicate, true);
  assert.equal(b.txId, a.txId);
  assert.equal((await ledger.balance(ACCT.user(1))), 5n);
});

test("BigInt cannot be bound to the database by accident", async () => {
  const { db } = await fresh();
  await assert.rejects(db.run("SELECT ?", 5n), /BigInt/);
});

test("audit detects tampered balances", async () => {
  const { ledger, db } = await fresh();
  await deposit(ledger, 1, 100n);
  assert.ok((await ledger.audit()).ok);
  await db.run("UPDATE accounts SET balance = '101' WHERE id = ?", ACCT.user(1));
  const a = (await ledger.audit());
  assert.equal(a.ok, false);
  assert.ok(a.problems.some((p) => p.includes("user:1")));
  assert.ok(a.problems.some((p) => p.includes("does not sum to zero")));
});

test("statement lists newest first and paginates", async () => {
  const { ledger } = await fresh();
  for (let i = 1; i <= 5; i++) await deposit(ledger, 1, BigInt(i), `d${i}`);
  const first = (await ledger.statement(ACCT.user(1), { limit: 2 }));
  assert.deepEqual(first.map((r) => r.amount), ["5", "4"]);
  const next = (await ledger.statement(ACCT.user(1), { limit: 2, before: first[1].id }));
  assert.deepEqual(next.map((r) => r.amount), ["3", "2"]);
});

test("nested db.tx rolls back only the inner block", async () => {
  const { ledger, db } = await fresh();
  await deposit(ledger, 1, 10n);
  await db.tx(async () => {
    await ledger.transfer(ACCT.user(1), ACCT.user(2), 3n, { kind: "outer" });
    await assert.rejects(db.tx(async () => { await ledger.transfer(ACCT.user(1), ACCT.user(2), 3n, { kind: "inner" }); throw new Error("boom"); }), /boom/);
  });
  assert.equal((await ledger.balance(ACCT.user(2))), 3n);
  assert.ok((await ledger.audit()).ok);
});

test("concurrent postings never interleave: 50 racing debits of a 10-wei balance, exactly 10 succeed", async () => {
  const { ledger } = await fresh();
  await deposit(ledger, 1, 10n);
  const out = await Promise.allSettled(Array.from({ length: 50 }, (_, i) => ledger.transfer(ACCT.user(1), ACCT.user(2), 1n, { kind: "race", uniq: `race:${i}` })));
  assert.equal(out.filter((r) => r.status === "fulfilled").length, 10);
  assert.ok(out.filter((r) => r.status === "rejected").every((r) => r.reason.code === "INSUFFICIENT_FUNDS"));
  assert.equal(await ledger.balance(ACCT.user(1)), 0n);
  assert.equal(await ledger.balance(ACCT.user(2)), 10n);
  assert.ok((await ledger.audit()).ok);
});

test("a transaction that fails part-way leaves nothing behind, and a timer started inside one does not inherit its lock", async () => {
  const { ledger, db } = await fresh();
  await deposit(ledger, 1, 10n);
  let detachedRan = null;
  await assert.rejects(db.tx(async () => {
    await ledger.transfer(ACCT.user(1), ACCT.user(2), 4n, { kind: "t" });
    db.detach(() => setImmediate(() => { detachedRan = db.locked; }));
    throw new Error("abort");
  }), /abort/);
  await new Promise((r) => setImmediate(r));
  assert.equal(detachedRan, false, "detached work runs outside the lock");
  assert.equal(await ledger.balance(ACCT.user(1)), 10n);
  assert.equal(await ledger.balance(ACCT.user(2)), 0n);
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
