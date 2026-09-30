/* Responsible-play rules, enforced on the server so a modified client cannot skip them.
   They mirror the front-end spec (PLATFORM.md):
     - staking needs a confirmed 18+ attestation; free play does not
     - daily loss limit: lowering it applies at once, raising or removing it waits `lossLimitDelayMs` (24 h)
     - cool-off (24 h or 7 days) blocks staked play and can never be shortened
   "Loss today" is the net of settled staked matches on the UTC day; stakes still in escrow also count as at risk. */
import { AppError, bad } from "./util/errors.js";
import { big, toStr } from "./util/amounts.js";

export const COOL_OFF_HOURS = [24, 168];
export const dayKey = (ts) => new Date(ts).toISOString().slice(0, 10);

export class Responsible {
  constructor({ db, config, now = () => Date.now() }) {
    this.db = db;
    this.cfg = config;
    this.now = now;
  }

  attestAdult(userId) {
    this.db.run("UPDATE users SET age_attested_at = COALESCE(age_attested_at, ?) WHERE id = ?", this.now(), userId);
  }

  /* promote a loosening whose delay has elapsed */
  applyPending(userId) {
    const u = this.db.get("SELECT loss_limit_pending AS p, loss_limit_pending_at AS at FROM users WHERE id = ?", userId);
    if (u && u.p != null && u.at <= this.now()) {
      this.db.run("UPDATE users SET loss_limit = ?, loss_limit_pending = NULL, loss_limit_pending_at = NULL WHERE id = ?", u.p === "off" ? null : u.p, userId);
    }
  }

  /* value: BigInt wei (> 0) or null (= off). Returns { applied, effectiveAt? } */
  setLossLimit(userId, value) {
    if (value !== null && (typeof value !== "bigint" || value <= 0n)) throw bad("BAD_LIMIT", "A loss limit must be more than zero, or null to switch it off.");
    return this.db.tx(() => {
      this.applyPending(userId);
      const u = this.db.get("SELECT loss_limit FROM users WHERE id = ?", userId);
      const current = u.loss_limit == null ? null : big(u.loss_limit);
      const same = value === current;
      const stricter = value !== null && (current === null || value <= current);
      if (same || stricter) {
        this.db.run("UPDATE users SET loss_limit = ?, loss_limit_pending = NULL, loss_limit_pending_at = NULL WHERE id = ?", value === null ? null : toStr(value), userId);
        return { applied: true };
      }
      const at = this.now() + this.cfg.responsible.lossLimitDelayMs;
      this.db.run("UPDATE users SET loss_limit_pending = ?, loss_limit_pending_at = ? WHERE id = ?", value === null ? "off" : toStr(value), at, userId);
      return { applied: false, effectiveAt: at };
    });
  }

  setCoolOff(userId, hours) {
    if (!COOL_OFF_HOURS.includes(hours)) throw bad("BAD_COOL_OFF", `Cool-off must be ${COOL_OFF_HOURS.join(" or ")} hours.`);
    const until = this.now() + hours * 3600000;
    this.db.run("UPDATE users SET cool_off_until = MAX(cool_off_until, ?) WHERE id = ?", until, userId);
    return this.db.get("SELECT cool_off_until FROM users WHERE id = ?", userId).cool_off_until;
  }

  lossToday(userId) {
    const r = this.db.get("SELECT net FROM player_day WHERE user_id = ? AND day = ?", userId, dayKey(this.now()));
    const net = r ? big(r.net) : 0n;
    return net < 0n ? -net : 0n;
  }

  /* record a settled staked match: net = payout − stake (negative for a loss) */
  recordNet(userId, net) {
    if (net === 0n) return;
    const day = dayKey(this.now());
    const r = this.db.get("SELECT net FROM player_day WHERE user_id = ? AND day = ?", userId, day);
    if (r) this.db.run("UPDATE player_day SET net = ? WHERE user_id = ? AND day = ?", toStr(big(r.net) + net), userId, day);
    else this.db.run("INSERT INTO player_day (user_id, day, net) VALUES (?, ?, ?)", userId, day, toStr(net));
  }

  /* Throws if this player may not put `stake` at risk right now. `atRisk` = stakes they already have in escrow. */
  assertCanStake(userId, stake, atRisk = 0n) {
    if (stake === 0n) return;
    this.applyPending(userId);
    const u = this.db.get("SELECT age_attested_at, cool_off_until, loss_limit FROM users WHERE id = ?", userId);
    if (!u.age_attested_at) throw new AppError("AGE_NOT_CONFIRMED", "Confirm you are 18 or older before playing for stakes.", 403);
    if (u.cool_off_until > this.now()) throw new AppError("COOL_OFF", "Cool-off is active. Free play only until it ends.", 403, { until: u.cool_off_until });
    if (u.loss_limit != null) {
      const room = big(u.loss_limit) - this.lossToday(userId) - atRisk;
      if (stake > (room > 0n ? room : 0n)) {
        throw new AppError("LOSS_LIMIT", "That stake is above what is left of your daily loss limit.", 403, { room: toStr(room > 0n ? room : 0n) });
      }
    }
  }

  view(userId) {
    this.applyPending(userId);
    const u = this.db.get("SELECT age_attested_at, cool_off_until, loss_limit, loss_limit_pending, loss_limit_pending_at FROM users WHERE id = ?", userId);
    const limit = u.loss_limit == null ? null : big(u.loss_limit);
    const loss = this.lossToday(userId);
    return {
      adultConfirmed: !!u.age_attested_at,
      coolOffUntil: u.cool_off_until > this.now() ? u.cool_off_until : null,
      lossLimit: limit === null ? null : toStr(limit),
      lossToday: toStr(loss),
      lossRoom: limit === null ? null : toStr(limit > loss ? limit - loss : 0n),
      pending: u.loss_limit_pending == null ? null : { lossLimit: u.loss_limit_pending === "off" ? null : u.loss_limit_pending, effectiveAt: u.loss_limit_pending_at },
    };
  }
}
