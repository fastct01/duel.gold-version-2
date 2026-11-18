import test, { after } from "node:test";
import assert from "node:assert/strict";
import { openTestDb, closeTestDbs } from "./helpers/app.js";
import { Users } from "../src/users.js";
import { Responsible, dayKey } from "../src/responsible.js";
import { loadConfig } from "../src/config.js";

after(closeTestDbs);

const ETH = 10n ** 18n;
const HOUR = 3600000;

async function setup({ adult = true } = {}) {
  const clock = { t: Date.UTC(2026, 5, 15, 12, 0, 0) };
  const now = () => clock.t;
  const db = await openTestDb();
  const users = new Users(db, now);
  const config = loadConfig({ NODE_ENV: "test" });
  const rp = new Responsible({ db, config, now });
  const u = (await users.getOrCreate("0x" + "11".repeat(20))).user;
  if (adult) await rp.attestAdult(u.id); // staking needs the 18+ attestation; the loss-limit tests are about the limit
  return { clock, db, rp, u, config };
}

test("with no loss limit set, any stake is allowed, and free play always is", async () => {
  const { rp, u } = await setup();
  await rp.assertCanStake(u.id, 0n);
  await rp.assertCanStake(u.id, ETH / 1000n);
});

test("lowering a loss limit applies at once; raising or removing it waits 24 h", async () => {
  const { rp, u, clock, db, config } = await setup();
  assert.deepEqual(await rp.setLossLimit(u.id, 1000n), { applied: true }, "first limit from 'off' is stricter");
  assert.deepEqual(await rp.setLossLimit(u.id, 500n), { applied: true });
  const raise = await rp.setLossLimit(u.id, 2000n);
  assert.equal(raise.applied, false);
  assert.equal(raise.effectiveAt, clock.t + config.responsible.lossLimitDelayMs);
  assert.equal((await rp.view(u.id)).lossLimit, "500", "still the old limit while the change is pending");
  assert.equal((await rp.view(u.id)).pending.lossLimit, "2000");

  clock.t = raise.effectiveAt;
  assert.equal((await rp.view(u.id)).lossLimit, "2000", "promoted once the delay has passed");
  assert.equal((await rp.view(u.id)).pending, null);

  const off = await rp.setLossLimit(u.id, null);
  assert.equal(off.applied, false);
  assert.equal((await rp.view(u.id)).pending.lossLimit, null);
  // setting the current value again cancels the pending removal
  assert.deepEqual(await rp.setLossLimit(u.id, 2000n), { applied: true });
  assert.equal((await rp.view(u.id)).pending, null);
  clock.t += 30 * 24 * HOUR;
  assert.equal((await rp.view(u.id)).lossLimit, "2000");
  assert.equal((await db.get("SELECT loss_limit_pending FROM users WHERE id = ?", u.id)).loss_limit_pending, null);
});

test("limit validation", async () => {
  const { rp, u } = await setup();
  await assert.rejects(async () => rp.setLossLimit(u.id, 0n), { code: "BAD_LIMIT" });
  await assert.rejects(async () => rp.setLossLimit(u.id, -5n), { code: "BAD_LIMIT" });
  await assert.rejects(async () => rp.setLossLimit(u.id, 5), { code: "BAD_LIMIT" });
});

test("daily loss limit counts settled losses and stakes already at risk; wins give room back", async () => {
  const { rp, u, clock } = await setup();
  await rp.setLossLimit(u.id, 1000n);
  await rp.assertCanStake(u.id, 1000n);
  await assert.rejects(async () => rp.assertCanStake(u.id, 1001n), { code: "LOSS_LIMIT" });

  await rp.recordNet(u.id, -600n);
  assert.equal(await rp.lossToday(u.id), 600n);
  await rp.assertCanStake(u.id, 400n);
  await assert.rejects(async () => rp.assertCanStake(u.id, 401n), { code: "LOSS_LIMIT" });
  await assert.rejects(async () => rp.assertCanStake(u.id, 300n, 200n), { code: "LOSS_LIMIT" }, "200 already in escrow leaves only 200");
  await rp.assertCanStake(u.id, 200n, 200n);

  await rp.recordNet(u.id, 500n); // a win: net −100
  assert.equal(await rp.lossToday(u.id), 100n);
  await rp.recordNet(u.id, 5000n); // net positive: no loss at all
  assert.equal(await rp.lossToday(u.id), 0n);
  await rp.assertCanStake(u.id, 1000n);

  await rp.recordNet(u.id, -6000n);
  await assert.rejects(async () => rp.assertCanStake(u.id, 1n), { code: "LOSS_LIMIT" });
  clock.t += 24 * HOUR; // next UTC day
  assert.notEqual(dayKey(clock.t), dayKey(clock.t - 24 * HOUR));
  await rp.assertCanStake(u.id, 1000n);
});

test("view() reports the room left", async () => {
  const { rp, u } = await setup();
  assert.equal((await rp.view(u.id)).lossRoom, null);
  await rp.setLossLimit(u.id, 1000n);
  await rp.recordNet(u.id, -250n);
  const v = await rp.view(u.id);
  assert.equal(v.lossToday, "250");
  assert.equal(v.lossRoom, "750");
  assert.deepEqual(Object.keys(v).sort(), ["adultConfirmed", "lossLimit", "lossRoom", "lossToday", "pending"], "the summary carries the age attestation and the loss limit");
});

test("18+ attestation: staking needs it, free play does not, the first attestation time is kept", async () => {
  const { rp, u, db, clock } = await setup({ adult: false });
  assert.equal(await rp.adultConfirmed(u.id), false);
  assert.equal((await rp.view(u.id)).adultConfirmed, false);
  await rp.assertAdult(u.id, 0n); // free play
  await rp.assertCanStake(u.id, 0n);
  await assert.rejects(async () => rp.assertAdult(u.id, 1n), { code: "AGE_NOT_CONFIRMED", status: 403 });
  await assert.rejects(async () => rp.assertCanStake(u.id, ETH / 1000n), { code: "AGE_NOT_CONFIRMED", status: 403 });

  await rp.attestAdult(u.id);
  const at = (await db.get("SELECT age_attested_at AS t FROM users WHERE id = ?", u.id)).t;
  assert.equal(at, clock.t);
  clock.t += HOUR;
  await rp.attestAdult(u.id);
  assert.equal((await db.get("SELECT age_attested_at AS t FROM users WHERE id = ?", u.id)).t, at);
  assert.equal(await rp.adultConfirmed(u.id), true);
  assert.equal((await rp.view(u.id)).adultConfirmed, true);
  await rp.assertAdult(u.id, 1n);
  await rp.assertCanStake(u.id, ETH / 1000n);
  await rp.setLossLimit(u.id, 1000n);
  await assert.rejects(async () => rp.assertCanStake(u.id, 1001n), { code: "LOSS_LIMIT" }, "the daily loss limit still applies after attesting");
});
