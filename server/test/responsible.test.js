import test from "node:test";
import assert from "node:assert/strict";
import { Db } from "../src/db/index.js";
import { Users } from "../src/users.js";
import { Responsible, dayKey } from "../src/responsible.js";
import { loadConfig } from "../src/config.js";

const ETH = 10n ** 18n;
const HOUR = 3600000;

function setup() {
  const clock = { t: Date.UTC(2026, 5, 15, 12, 0, 0) };
  const now = () => clock.t;
  const db = new Db(":memory:");
  const users = new Users(db, now);
  const config = loadConfig({ NODE_ENV: "test" });
  const rp = new Responsible({ db, config, now });
  const u = users.getOrCreate("0x" + "11".repeat(20)).user;
  return { clock, db, rp, u, config };
}

test("free play needs no age confirmation; staked play does", () => {
  const { rp, u } = setup();
  rp.assertCanStake(u.id, 0n);
  assert.throws(() => rp.assertCanStake(u.id, ETH / 1000n), { code: "AGE_NOT_CONFIRMED" });
  rp.attestAdult(u.id);
  rp.assertCanStake(u.id, ETH / 1000n);
});

test("cool-off blocks staked play only, and can be extended but never shortened", () => {
  const { rp, u, clock } = setup();
  rp.attestAdult(u.id);
  const until = rp.setCoolOff(u.id, 168);
  assert.equal(until, clock.t + 168 * HOUR);
  assert.throws(() => rp.assertCanStake(u.id, 1n), { code: "COOL_OFF" });
  rp.assertCanStake(u.id, 0n);
  assert.equal(rp.setCoolOff(u.id, 24), until, "a shorter cool-off must not replace a longer one");
  clock.t = until + 1;
  rp.assertCanStake(u.id, 1n);
  assert.throws(() => rp.setCoolOff(u.id, 5), { code: "BAD_COOL_OFF" });
});

test("lowering a loss limit applies at once; raising or removing it waits 24 h", () => {
  const { rp, u, clock, db, config } = setup();
  assert.deepEqual(rp.setLossLimit(u.id, 1000n), { applied: true }, "first limit from 'off' is stricter");
  assert.deepEqual(rp.setLossLimit(u.id, 500n), { applied: true });
  const raise = rp.setLossLimit(u.id, 2000n);
  assert.equal(raise.applied, false);
  assert.equal(raise.effectiveAt, clock.t + config.responsible.lossLimitDelayMs);
  assert.equal(rp.view(u.id).lossLimit, "500", "still the old limit while the change is pending");
  assert.equal(rp.view(u.id).pending.lossLimit, "2000");

  clock.t = raise.effectiveAt;
  assert.equal(rp.view(u.id).lossLimit, "2000", "promoted once the delay has passed");
  assert.equal(rp.view(u.id).pending, null);

  const off = rp.setLossLimit(u.id, null);
  assert.equal(off.applied, false);
  assert.equal(rp.view(u.id).pending.lossLimit, null);
  // setting the current value again cancels the pending removal
  assert.deepEqual(rp.setLossLimit(u.id, 2000n), { applied: true });
  assert.equal(rp.view(u.id).pending, null);
  clock.t += 30 * 24 * HOUR;
  assert.equal(rp.view(u.id).lossLimit, "2000");
  assert.equal(db.get("SELECT loss_limit_pending FROM users WHERE id = ?", u.id).loss_limit_pending, null);
});

test("limit validation", () => {
  const { rp, u } = setup();
  assert.throws(() => rp.setLossLimit(u.id, 0n), { code: "BAD_LIMIT" });
  assert.throws(() => rp.setLossLimit(u.id, -5n), { code: "BAD_LIMIT" });
  assert.throws(() => rp.setLossLimit(u.id, 5), { code: "BAD_LIMIT" });
});

test("daily loss limit counts settled losses and stakes already at risk; wins give room back", () => {
  const { rp, u, clock } = setup();
  rp.attestAdult(u.id);
  rp.setLossLimit(u.id, 1000n);
  rp.assertCanStake(u.id, 1000n);
  assert.throws(() => rp.assertCanStake(u.id, 1001n), { code: "LOSS_LIMIT" });

  rp.recordNet(u.id, -600n);
  assert.equal(rp.lossToday(u.id), 600n);
  rp.assertCanStake(u.id, 400n);
  assert.throws(() => rp.assertCanStake(u.id, 401n), { code: "LOSS_LIMIT" });
  assert.throws(() => rp.assertCanStake(u.id, 300n, 200n), { code: "LOSS_LIMIT" }, "200 already in escrow leaves only 200");
  rp.assertCanStake(u.id, 200n, 200n);

  rp.recordNet(u.id, 500n); // a win: net −100
  assert.equal(rp.lossToday(u.id), 100n);
  rp.recordNet(u.id, 5000n); // net positive: no loss at all
  assert.equal(rp.lossToday(u.id), 0n);
  rp.assertCanStake(u.id, 1000n);

  rp.recordNet(u.id, -6000n);
  assert.throws(() => rp.assertCanStake(u.id, 1n), { code: "LOSS_LIMIT" });
  clock.t += 24 * HOUR; // next UTC day
  assert.notEqual(dayKey(clock.t), dayKey(clock.t - 24 * HOUR));
  rp.assertCanStake(u.id, 1000n);
});

test("view() reports the room left", () => {
  const { rp, u } = setup();
  assert.equal(rp.view(u.id).lossRoom, null);
  rp.setLossLimit(u.id, 1000n);
  rp.recordNet(u.id, -250n);
  const v = rp.view(u.id);
  assert.equal(v.lossToday, "250");
  assert.equal(v.lossRoom, "750");
  assert.equal(v.adultConfirmed, false);
});
