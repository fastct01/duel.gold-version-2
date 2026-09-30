/* Player-vs-player matches (race games).

   Life of a match
     queue     join() puts the stake in escrow:ticket:<id> and the player in a bucket (game + stake [+ private code]).
     found     two compatible tickets are paired: stakes move to escrow:match:<id>. Both players must call ready()
               within acceptMs, otherwise the match is voided, everyone is refunded and no-shows get a strike.
     playing   when both are ready the server draws the seed, and sends it — once, to the socket that said ready — with a
               start time a few seconds ahead. Each player plays the identical seeded challenge locally and calls submit().
     settled   both scores in → higher wins (equal = draw). One score by the deadline → that player wins. Forfeit → the
               other player wins. No scores at all → void, refunds. Winner gets pot − fee; the fee goes to house:fees.

   Every transition is a compare-and-set on the match state inside a DB transaction together with its ledger movement, so
   a timer, a submit and a forfeit racing each other can settle a match only once and can never create or lose money.

   Trust model: the server picks the seed and the clock, but the SCORE is reported by the player's own client. A modified
   client can lie. Mitigations here are the once-only seed delivery, hard deadlines, sanity bounds, and an advisory flag
   when a score is far above what the strongest bot manages on that seed. Real-money play would need server-side replay.  */
import crypto from "node:crypto";
import { AppError, bad, conflict, forbidden, notFound } from "../util/errors.js";
import { ACCT } from "../ledger.js";
import { big, parseWei, splitPot, toStr } from "../util/amounts.js";
import { START_RATING, delta } from "./elo.js";
import { bucketKey, findPartner } from "./queue.js";

const CODE_RE = /^[A-Za-z0-9]{4,16}$/;
const PROGRESS_MIN_GAP_MS = 200;
const MAX_DETAIL = 2000;

export class MatchService {
  constructor({ db, ledger, users, responsible, catalog, cfg, log, hub, now = () => Date.now() }) {
    Object.assign(this, { db, ledger, users, responsible, catalog, cfg, log, hub, now });
    this.tickets = new Map(); // id -> ticket (queued only)
    this.buckets = new Map(); // bucket key -> ticket[]
    this.busy = new Map(); // userId -> { kind: 'ticket' | 'match', id }
    this.timers = new Map();
    this.progressAt = new Map();
    this.readyConn = new Map(); // `${matchId}:${seat}` -> connection id that said ready
    this.pairTimer = null;
    this.pendingFlags = new Set();
  }

  /* ------------------------------------------------------------ lifecycle */

  start() {
    this.recover();
    this.pairTimer = setInterval(() => this.#sweep(), this.cfg.match.pairIntervalMs);
    this.pairTimer.unref?.();
  }

  stop() {
    if (this.pairTimer) clearInterval(this.pairTimer);
    this.pairTimer = null;
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }

  /* After a restart: queue tickets are gone (refund them), matches that never started are voided, running matches get
     their deadline timer back. Money is never stranded because escrow is in the ledger, not in memory. */
  recover() {
    for (const t of this.db.all("SELECT * FROM tickets WHERE state = 'queued'")) {
      this.#cancelTicketRow(t, "cancelled");
    }
    for (const m of this.db.all("SELECT * FROM matches WHERE state = 'found'")) {
      this.#voidFound(m.id, "server_restart", []);
    }
    for (const m of this.db.all("SELECT * FROM matches WHERE state = 'playing'")) {
      for (const p of this.#players(m.id)) this.busy.set(p.user_id, { kind: "match", id: m.id });
      this.#arm(`deadline:${m.id}`, Math.max(0, m.submit_deadline - this.now()), () => this.#deadline(m.id));
    }
    if (this.busy.size) this.log.info("recovered running matches", { players: this.busy.size });
  }

  #arm(key, ms, fn) {
    this.#disarm(key);
    const t = setTimeout(() => {
      this.timers.delete(key);
      try { fn(); } catch (e) { this.log.error("match timer failed", { key, error: e }); }
    }, ms);
    t.unref?.();
    this.timers.set(key, t);
  }
  #disarm(key) {
    const t = this.timers.get(key);
    if (t) { clearTimeout(t); this.timers.delete(key); }
  }

  /* ------------------------------------------------------------ ratings */

  rating(userId, game) {
    const r = this.db.get("SELECT rating FROM ratings WHERE user_id = ? AND game = ?", userId, game);
    return r ? r.rating : START_RATING;
  }

  ratingsFor(userId) {
    return this.db.all("SELECT game, rating, wins, losses, draws, best FROM ratings WHERE user_id = ? ORDER BY game", userId);
  }

  leaderboard(game, limit = 20) {
    return this.db.all(
      `SELECT r.rating, r.wins, r.losses, r.draws, u.id AS user_id, u.display_name, u.address
         FROM ratings r JOIN users u ON u.id = r.user_id
        WHERE r.game = ? AND (r.wins + r.losses + r.draws) > 0
        ORDER BY r.rating DESC, r.wins DESC, u.id LIMIT ?`, game, limit)
      .map((r, i) => ({ rank: i + 1, player: this.users.publicView({ id: r.user_id, display_name: r.display_name, address: r.address }), rating: r.rating, wins: r.wins, losses: r.losses, draws: r.draws }));
  }

  /* ------------------------------------------------------------ queue */

  join(userId, { game, stake, code } = {}) {
    const g = this.catalog.get(game);
    if (!g) throw bad("UNKNOWN_GAME", "Unknown game.");
    if (!g.pvp) throw bad("GAME_NOT_PVP", `${g.name} cannot be played against another player yet.`);
    const stakeWei = parseWei(stake ?? 0, "stake");
    const e = this.cfg.economy;
    if (stakeWei !== 0n && (stakeWei < e.minStake || stakeWei > e.maxStake)) {
      throw bad("BAD_STAKE", "Stake must be 0 (free play) or within the allowed range.", { min: toStr(e.minStake), max: toStr(e.maxStake) });
    }
    let privateCode = null;
    if (code != null && code !== "") {
      if (typeof code !== "string" || !CODE_RE.test(code)) throw bad("BAD_CODE", "A private-match code is 4–16 letters or numbers.");
      privateCode = code.toUpperCase();
    }
    const user = this.users.require(userId);
    if (user.banned) throw forbidden("ACCOUNT_BANNED", "This account is suspended.");
    if (user.queue_ban_until > this.now()) throw new AppError("QUEUE_BANNED", "You skipped too many matches. Try again shortly.", 403, { until: user.queue_ban_until });
    if (this.busy.has(userId)) throw conflict("ALREADY_ACTIVE", "Finish or leave your current queue or match first.");
    this.responsible.assertCanStake(userId, stakeWei, 0n);

    const rating = this.rating(userId, game);
    const ticket = this.db.tx(() => {
      const id = Number(this.db.run("INSERT INTO tickets (user_id, game, stake, code, rating, state, created_at) VALUES (?, ?, ?, ?, ?, 'queued', ?)",
        userId, game, toStr(stakeWei), privateCode, rating, this.now()).lastInsertRowid);
      if (stakeWei > 0n) this.ledger.transfer(ACCT.user(userId), ACCT.ticket(id), stakeWei, { kind: "stake-hold", ref: id, uniq: `ticket-hold:${id}` });
      return { id, userId, game, stake: stakeWei, code: privateCode, rating, at: this.now() };
    });

    this.tickets.set(ticket.id, ticket);
    const key = bucketKey(ticket);
    ticket.key = key;
    if (!this.buckets.has(key)) this.buckets.set(key, []);
    this.buckets.get(key).push(ticket);
    this.busy.set(userId, { kind: "ticket", id: ticket.id });
    this.#arm(`expire:${ticket.id}`, this.cfg.match.queueTimeoutMs, () => this.#cancelTicket(ticket.id, "expired"));

    const view = this.#ticketView(ticket);
    this.hub.notify(userId, { type: "queue.joined", ticket: view });
    this.hub.notify(userId, { type: "wallet.updated", reason: "stake-held" });
    this.#tryPair(ticket);
    return view;
  }

  leave(userId) {
    const b = this.busy.get(userId);
    if (!b || b.kind !== "ticket") throw conflict("NOT_QUEUED", "You are not in a queue.");
    this.#cancelTicket(b.id, "cancelled");
    return { left: true };
  }

  #ticketView(t) {
    return {
      id: t.id, game: t.game, stake: toStr(t.stake), code: t.code, rating: t.rating, since: t.at,
      expiresAt: t.at + this.cfg.match.queueTimeoutMs,
    };
  }

  #dequeue(t) {
    this.tickets.delete(t.id);
    const list = this.buckets.get(t.key);
    if (list) {
      const i = list.indexOf(t);
      if (i >= 0) list.splice(i, 1);
      if (!list.length) this.buckets.delete(t.key);
    }
    this.#disarm(`expire:${t.id}`);
  }

  #cancelTicket(ticketId, state) {
    const t = this.tickets.get(ticketId);
    const row = this.db.get("SELECT * FROM tickets WHERE id = ?", ticketId);
    if (!row || row.state !== "queued") return;
    this.#cancelTicketRow(row, state);
    if (t) this.#dequeue(t);
    this.busy.delete(row.user_id);
    this.hub.notify(row.user_id, { type: state === "expired" ? "queue.expired" : "queue.left", ticketId });
    this.hub.notify(row.user_id, { type: "wallet.updated", reason: "stake-released" });
  }

  /* DB half of cancelling: state change + refund in one transaction */
  #cancelTicketRow(row, state) {
    this.db.tx(() => {
      const c = this.db.run("UPDATE tickets SET state = ?, closed_at = ? WHERE id = ? AND state = 'queued'", state, this.now(), row.id).changes;
      if (!c) return;
      const stake = big(row.stake);
      if (stake > 0n) this.ledger.transfer(ACCT.ticket(row.id), ACCT.user(row.user_id), stake, { kind: "stake-release", ref: row.id, uniq: `ticket-release:${row.id}` });
    });
  }

  #tryPair(ticket) {
    if (!this.tickets.has(ticket.id)) return;
    const others = this.buckets.get(ticket.key) || [];
    const partner = findPartner(ticket, others, this.now(), this.cfg.match);
    if (partner) this.#createMatch(partner.at <= ticket.at ? partner : ticket, partner.at <= ticket.at ? ticket : partner);
  }

  /* windows widen with time, so re-check every waiting ticket periodically */
  #sweep() {
    for (const list of [...this.buckets.values()]) {
      for (const t of [...list]) if (this.tickets.has(t.id)) this.#tryPair(t);
    }
  }

  /* ------------------------------------------------------------ match creation */

  #createMatch(a, b) {
    const stake = a.stake;
    const pot = stake * 2n;
    const { fee } = splitPot(pot, this.cfg.economy.feeBps);
    const readyDeadline = this.now() + this.cfg.match.acceptMs;
    const mid = this.db.tx(() => {
      const id = Number(this.db.run("INSERT INTO matches (game, stake, pot, fee, state, code, created_at, ready_deadline) VALUES (?, ?, ?, ?, 'found', ?, ?, ?)",
        a.game, toStr(stake), toStr(pot), toStr(fee), a.code, this.now(), readyDeadline).lastInsertRowid);
      [a, b].forEach((t, seat) => {
        this.db.run("INSERT INTO match_players (match_id, seat, user_id, ticket_id, rating_before) VALUES (?, ?, ?, ?, ?)", id, seat, t.userId, t.id, t.rating);
        const c = this.db.run("UPDATE tickets SET state = 'matched', closed_at = ?, match_id = ? WHERE id = ? AND state = 'queued'", this.now(), id, t.id).changes;
        if (!c) throw new Error(`ticket ${t.id} was not queued`);
        if (stake > 0n) this.ledger.transfer(ACCT.ticket(t.id), ACCT.match(id), stake, { kind: "stake-lock", ref: id, uniq: `ticket-lock:${t.id}` });
      });
      return id;
    });
    for (const t of [a, b]) {
      this.#dequeue(t);
      this.busy.set(t.userId, { kind: "match", id: mid });
    }
    this.#arm(`ready:${mid}`, this.cfg.match.acceptMs, () => this.#readyTimeout(mid));
    this.log.info("match found", { matchId: mid, game: a.game, stake: toStr(stake), players: [a.userId, b.userId] });
    for (const t of [a, b]) {
      this.hub.notify(t.userId, { type: "match.found", match: this.matchView(mid, t.userId) });
    }
  }

  /* ------------------------------------------------------------ ready → start */

  ready(userId, matchId, connId = null) {
    const m = this.#matchFor(userId, matchId);
    const seat = this.#seat(m, userId);
    if (m.state === "found") {
      if (this.now() > m.ready_deadline) throw conflict("READY_EXPIRED", "The time to accept this match has passed.");
      this.db.run("UPDATE match_players SET ready_at = COALESCE(ready_at, ?) WHERE match_id = ? AND seat = ?", this.now(), matchId, seat);
      this.readyConn.set(`${matchId}:${seat}`, connId);
      this.hub.notify(this.#players(matchId)[1 - seat].user_id, { type: "match.opponent_ready", matchId });
      if (this.#players(matchId).every((p) => p.ready_at != null)) this.#start(matchId);
      return { matchId, state: this.db.get("SELECT state FROM matches WHERE id = ?", matchId).state };
    }
    if (m.state === "playing") {
      // a player whose seed never reached a socket may ask once more, as long as the game is still running
      const p = this.#players(matchId)[seat];
      if (p.seed_sent) throw conflict("SEED_ALREADY_SENT", "The challenge was already delivered to you and cannot be sent again.");
      if (this.now() > m.submit_deadline) throw conflict("MATCH_OVER", "This match is over.");
      const delivered = this.#deliverSeed(m, userId, seat, connId);
      return { matchId, state: "playing", delivered };
    }
    throw conflict("MATCH_OVER", "This match is over.");
  }

  #startMessage(m, withSeed) {
    return { type: "match.start", matchId: m.id, game: m.game, startAt: m.start_at, submitDeadline: m.submit_deadline, serverNow: this.now(), seed: withSeed ? m.seed : null };
  }

  #start(matchId) {
    const g = this.catalog.get(this.db.get("SELECT game FROM matches WHERE id = ?", matchId).game);
    const seed = crypto.randomInt(100000, 1_000_000_000);
    const startAt = this.now() + this.cfg.match.countdownMs;
    const window = Math.round(g.maxMs * this.cfg.match.durationScale * this.cfg.match.durationFactor);
    const deadline = startAt + window + this.cfg.match.graceMs;
    const started = this.db.run("UPDATE matches SET state = 'playing', seed = ?, start_at = ?, submit_deadline = ? WHERE id = ? AND state = 'found'", seed, startAt, deadline, matchId).changes;
    if (!started) return;
    this.#disarm(`ready:${matchId}`);
    this.#arm(`deadline:${matchId}`, deadline - this.now(), () => this.#deadline(matchId));
    const m = this.db.get("SELECT * FROM matches WHERE id = ?", matchId);
    this.log.info("match started", { matchId, game: m.game, startAt, deadline });
    for (const p of this.#players(matchId)) {
      const preferred = this.readyConn.get(`${matchId}:${p.seat}`);
      this.readyConn.delete(`${matchId}:${p.seat}`);
      this.#deliverSeed(m, p.user_id, p.seat, preferred);
    }
  }

  /* The seed goes to exactly ONE socket per player — the one that said ready, or else any open one — and is never
     re-sent once delivered. This stops a second tab from previewing a puzzle and a reload from replaying it.
     Every other socket of the same player hears that the match started, without the seed. */
  #deliverSeed(m, userId, seat, preferred) {
    const conns = this.hub.connections(userId);
    const conn = conns.includes(preferred) ? preferred : conns[0];
    if (conn == null) return false; // nobody connected: seed_sent stays 0, the player may ask again via ready()
    if (!this.hub.notify(userId, this.#startMessage(m, true), { conn })) return false;
    this.db.run("UPDATE match_players SET seed_sent = 1 WHERE match_id = ? AND seat = ?", m.id, seat);
    if (conns.length > 1) this.hub.notify(userId, this.#startMessage(m, false), { except: conn });
    return true;
  }

  /* ------------------------------------------------------------ playing */

  /* live score for the opponent's race bar. Display only; never used for settlement. */
  progress(userId, matchId, score) {
    const m = this.#matchFor(userId, matchId);
    if (m.state !== "playing" || this.now() < m.start_at || !Number.isFinite(score)) return;
    const seat = this.#seat(m, userId);
    const key = `${matchId}:${seat}`;
    const last = this.progressAt.get(key) || 0;
    if (this.now() - last < PROGRESS_MIN_GAP_MS) return;
    this.progressAt.set(key, this.now());
    this.hub.notify(this.#players(matchId)[1 - seat].user_id, { type: "match.opponent_progress", matchId, score });
  }

  submit(userId, matchId, { score, detail } = {}) {
    const m = this.#matchFor(userId, matchId);
    if (m.state !== "playing") throw conflict("MATCH_NOT_PLAYING", "This match is not being played.");
    const seat = this.#seat(m, userId);
    const now = this.now();
    if (now < m.start_at - 250) throw conflict("TOO_EARLY", "The match has not started yet.");
    if (now > m.submit_deadline) throw conflict("TOO_LATE", "The submission deadline has passed.");
    if (typeof score !== "number" || !Number.isFinite(score) || Math.abs(score) > this.cfg.match.maxScore) throw bad("BAD_SCORE", "score must be a finite number.");
    const text = detail == null ? null : String(detail).slice(0, MAX_DETAIL);

    const own = this.#players(matchId)[seat];
    if (own.score != null) throw conflict("ALREADY_SUBMITTED", "You already submitted a result for this match.");
    this.db.run("UPDATE match_players SET score = ?, detail = ?, submitted_at = ? WHERE match_id = ? AND seat = ? AND score IS NULL", score, text, now, matchId, seat);
    this.hub.notify(this.#players(matchId)[1 - seat].user_id, { type: "match.opponent_finished", matchId });
    if (this.#players(matchId).every((p) => p.score != null)) this.#settle(matchId, "scores");
    return { matchId, accepted: true };
  }

  forfeit(userId, matchId) {
    const m = this.#matchFor(userId, matchId);
    const seat = this.#seat(m, userId);
    if (m.state === "found") {
      // declining a match you were paired into wastes the other player's time: counts like a no-show
      this.#voidFound(matchId, "declined", [seat]);
      return { matchId, state: "void" };
    }
    if (m.state !== "playing") throw conflict("MATCH_OVER", "This match is over.");
    this.db.run("UPDATE match_players SET forfeited = 1 WHERE match_id = ? AND seat = ?", matchId, seat);
    this.#settle(matchId, "forfeit");
    return { matchId, state: "settled" };
  }

  #deadline(matchId) {
    this.#settle(matchId, "timeout");
  }

  #readyTimeout(matchId) {
    const late = this.#players(matchId).filter((p) => p.ready_at == null).map((p) => p.seat);
    this.#voidFound(matchId, "no_show", late);
  }

  /* found → void: refund everyone, strike whoever did not show up */
  #voidFound(matchId, reason, strikeSeats) {
    const done = this.db.tx(() => {
      const c = this.db.run("UPDATE matches SET state = 'void', outcome = 'void', reason = ?, settled_at = ? WHERE id = ? AND state = 'found'", reason, this.now(), matchId).changes;
      if (!c) return false;
      this.#refund(matchId);
      const ps = this.#players(matchId);
      for (const p of ps) this.db.run("UPDATE match_players SET rating_after = rating_before WHERE match_id = ? AND seat = ?", matchId, p.seat);
      for (const seat of strikeSeats) this.#strike(ps[seat].user_id);
      return true;
    });
    if (!done) return;
    this.#disarm(`ready:${matchId}`);
    this.#finish(matchId);
    this.log.info("match voided before start", { matchId, reason });
  }

  #strike(userId) {
    const u = this.users.byId(userId);
    const m = this.cfg.match;
    const strikes = (this.now() - u.last_strike_at > m.strikeDecayMs ? 0 : u.strikes) + 1;
    if (strikes >= m.strikesBeforeBan) {
      this.db.run("UPDATE users SET strikes = 0, last_strike_at = ?, queue_ban_until = ? WHERE id = ?", this.now(), this.now() + m.banMs, userId);
    } else {
      this.db.run("UPDATE users SET strikes = ?, last_strike_at = ? WHERE id = ?", strikes, this.now(), userId);
    }
  }

  /* ------------------------------------------------------------ settlement */

  #refund(matchId) {
    const m = this.db.get("SELECT * FROM matches WHERE id = ?", matchId);
    const stake = big(m.stake);
    if (stake === 0n) return;
    const [p0, p1] = this.#players(matchId);
    this.ledger.post({
      kind: "match-refund", ref: matchId, uniq: `match-refund:${matchId}`,
      entries: [[ACCT.match(matchId), -(stake * 2n)], [ACCT.user(p0.user_id), stake], [ACCT.user(p1.user_id), stake]],
    });
  }

  #settle(matchId, reason) {
    const settled = this.db.tx(() => {
      const m = this.db.get("SELECT * FROM matches WHERE id = ?", matchId);
      if (!m || m.state !== "playing") return false; // somebody else already settled it
      const [p0, p1] = this.#players(matchId);
      const stake = big(m.stake), pot = big(m.pot);

      let outcome, winner = null, why = reason;
      if (p0.forfeited || p1.forfeited) { outcome = "win"; winner = p0.forfeited ? 1 : 0; why = "forfeit"; }
      else if (p0.score != null && p1.score != null) {
        why = "scores";
        if (p0.score === p1.score) outcome = "draw"; else { outcome = "win"; winner = p0.score > p1.score ? 0 : 1; }
      } else if (p0.score != null || p1.score != null) { outcome = "win"; winner = p0.score != null ? 0 : 1; why = "timeout"; }
      else { outcome = "void"; why = "no_result"; }

      // ---- money
      const { payout, fee } = outcome === "win" ? splitPot(pot, this.cfg.economy.feeBps) : { payout: 0n, fee: 0n };
      if (outcome === "void" || outcome === "draw") this.#refund(matchId);
      else if (stake > 0n) {
        const entries = [[ACCT.match(matchId), -pot], [ACCT.user([p0, p1][winner].user_id), payout]];
        if (fee > 0n) entries.push([ACCT.house, fee]);
        this.ledger.post({ kind: "match-settle", ref: matchId, uniq: `match-settle:${matchId}`, entries });
      }

      // ---- ratings (a void match changes nobody's rating)
      const before = [p0.rating_before, p1.rating_before];
      let after = [...before];
      if (outcome !== "void") {
        const s0 = outcome === "draw" ? 0.5 : winner === 0 ? 1 : 0;
        const d0 = delta(before[0], before[1], s0);
        after = [before[0] + d0, before[1] - d0];
        [p0, p1].forEach((p, seat) => {
          const result = outcome === "draw" ? "draws" : winner === seat ? "wins" : "losses";
          this.db.run("INSERT OR IGNORE INTO ratings (user_id, game, rating, updated_at) VALUES (?, ?, ?, ?)", p.user_id, m.game, START_RATING, this.now());
          this.db.run(`UPDATE ratings SET rating = ?, ${result} = ${result} + 1, best = CASE WHEN ? IS NULL THEN best WHEN best IS NULL OR ? > best THEN ? ELSE best END, updated_at = ?
                        WHERE user_id = ? AND game = ?`, after[seat], p.score, p.score, p.score, this.now(), p.user_id, m.game);
        });
      }

      // ---- per-player result + daily net for the loss limit
      [p0, p1].forEach((p, seat) => {
        const got = outcome === "win" ? (winner === seat ? payout : 0n) : stake; // draw/void: own stake back
        this.db.run("UPDATE match_players SET rating_after = ?, payout = ? WHERE match_id = ? AND seat = ?", after[seat], toStr(stake > 0n ? got : 0n), matchId, seat);
        if (stake > 0n && outcome !== "void") this.responsible.recordNet(p.user_id, got - stake);
      });

      const state = outcome === "void" ? "void" : "settled";
      this.db.run("UPDATE matches SET state = ?, outcome = ?, reason = ?, fee = ?, winner_seat = ?, settled_at = ? WHERE id = ?",
        state, outcome, why, toStr(fee), winner, this.now(), matchId);
      return true;
    });
    if (!settled) return;
    this.#disarm(`deadline:${matchId}`);
    this.#finish(matchId);
    const m = this.db.get("SELECT * FROM matches WHERE id = ?", matchId);
    this.log.info("match settled", { matchId, outcome: m.outcome, reason: m.reason, winnerSeat: m.winner_seat });
    this.#scheduleFlagCheck(matchId);
  }

  /* after a match reaches a final state: free the players and tell them */
  #finish(matchId) {
    for (const p of this.#players(matchId)) {
      this.busy.delete(p.user_id);
      this.readyConn.delete(`${matchId}:${p.seat}`);
      this.progressAt.delete(`${matchId}:${p.seat}`);
      const v = this.matchView(matchId, p.user_id);
      this.hub.notify(p.user_id, { type: v.state === "void" ? "match.void" : "match.result", match: v });
      this.hub.notify(p.user_id, { type: "wallet.updated", reason: "match-settled", matchId });
    }
  }

  /* advisory: flag a score that is far beyond the strongest bot on the same seed. Off the hot path. */
  #scheduleFlagCheck(matchId) {
    const p = new Promise((resolve) => setImmediate(() => {
      try {
        const m = this.db.get("SELECT * FROM matches WHERE id = ?", matchId);
        const g = m && this.catalog.get(m.game);
        if (!g || m.seed == null) return;
        for (const p of this.#players(matchId)) {
          if (p.score == null) continue;
          const why = this.catalog.plausibility(g, m.seed, p.score);
          if (why) {
            this.db.run("UPDATE match_players SET flag = ? WHERE match_id = ? AND seat = ?", why, matchId, p.seat);
            this.log.warn("implausible score flagged for review", { matchId, userId: p.user_id, reason: why });
          }
        }
      } catch (e) { this.log.error("flag check failed", { matchId, error: e }); }
      finally { resolve(); }
    }));
    this.pendingFlags.add(p);
    p.finally(() => this.pendingFlags.delete(p));
  }
  /* tests await this to see flags written */
  async flagsSettled() { await Promise.all([...this.pendingFlags]); }

  flagged(limit = 50) {
    return this.db.all(
      `SELECT mp.match_id, mp.seat, mp.user_id, mp.score, mp.flag, m.game, m.seed, m.stake, m.state
         FROM match_players mp JOIN matches m ON m.id = mp.match_id
        WHERE mp.flag IS NOT NULL ORDER BY mp.match_id DESC LIMIT ?`, limit);
  }

  /* ------------------------------------------------------------ connection hooks (from the gateway) */

  userDisconnected(userId) {
    const b = this.busy.get(userId);
    if (!b || b.kind !== "ticket") return; // running matches carry on: the deadline decides
    this.#arm(`disc:${userId}`, this.cfg.match.disconnectQueueMs, () => {
      const cur = this.busy.get(userId);
      if (cur && cur.kind === "ticket") this.#cancelTicket(cur.id, "cancelled");
    });
  }
  userConnected(userId) { this.#disarm(`disc:${userId}`); }

  /* ------------------------------------------------------------ reads */

  #players(matchId) {
    return this.db.all(
      `SELECT mp.*, u.display_name, u.address FROM match_players mp JOIN users u ON u.id = mp.user_id
        WHERE mp.match_id = ? ORDER BY mp.seat`, matchId);
  }

  #matchFor(userId, matchId) {
    const id = Number(matchId);
    const m = Number.isInteger(id) ? this.db.get("SELECT * FROM matches WHERE id = ?", id) : null;
    if (!m || !this.db.get("SELECT 1 AS x FROM match_players WHERE match_id = ? AND user_id = ?", id, userId)) throw notFound("No such match.");
    return m;
  }
  #seat(m, userId) {
    return this.db.get("SELECT seat FROM match_players WHERE match_id = ? AND user_id = ?", m.id, userId).seat;
  }

  /* one match as seen by one of its players */
  matchView(matchId, viewerId) {
    const m = this.db.get("SELECT * FROM matches WHERE id = ?", matchId);
    const ps = this.#players(matchId);
    const me = ps.find((p) => p.user_id === viewerId);
    const opp = ps.find((p) => p.user_id !== viewerId);
    const final = m.state === "settled" || m.state === "void";
    const g = this.catalog.get(m.game);
    const { payout } = splitPot(big(m.pot), this.cfg.economy.feeBps);
    const result = !final ? null : m.outcome === "void" ? "void" : m.outcome === "draw" ? "draw" : m.winner_seat === me.seat ? "win" : "loss";
    return {
      id: m.id, state: m.state, result, reason: m.reason,
      game: { id: m.game, name: g ? g.name : m.game, scoreLabel: g ? g.scoreLabel : "score", maxSeconds: g ? Math.round(g.maxMs / 1000) : null },
      stake: m.stake, pot: m.pot, fee: m.fee, winnerPayout: toStr(payout), private: !!m.code,
      readyDeadline: m.ready_deadline, startAt: m.start_at, submitDeadline: m.submit_deadline, settledAt: m.settled_at,
      seed: final ? m.seed : undefined, // revealed only afterwards, so anyone involved can replay and audit
      you: { seat: me.seat, ready: me.ready_at != null, submitted: me.score != null, score: me.score, payout: me.payout, ratingBefore: me.rating_before, ratingAfter: me.rating_after, seedDelivered: !!me.seed_sent },
      opponent: {
        ...this.users.publicView({ id: opp.user_id, display_name: opp.display_name, address: opp.address }),
        ready: opp.ready_at != null, finished: opp.score != null, score: final ? opp.score : null,
        ratingBefore: opp.rating_before, ratingAfter: final ? opp.rating_after : null,
      },
    };
  }

  /* what a (re)connecting client needs to pick up where it left off. Never contains a seed. */
  sync(userId) {
    const b = this.busy.get(userId);
    if (!b) return { active: null };
    if (b.kind === "ticket") {
      const t = this.tickets.get(b.id);
      return { active: t ? { kind: "queue", ticket: this.#ticketView(t) } : null };
    }
    return { active: { kind: "match", match: this.matchView(b.id, userId) } };
  }

  active(userId) { return this.busy.get(userId) || null; }

  /* the stake this player currently has in escrow (queued ticket or unfinished match) */
  stakeAtRisk(userId) {
    const b = this.busy.get(userId);
    if (!b) return 0n;
    if (b.kind === "ticket") { const t = this.tickets.get(b.id); return t ? t.stake : 0n; }
    return big(this.db.get("SELECT stake FROM matches WHERE id = ?", b.id).stake);
  }

  history(userId, { limit = 20, before = null } = {}) {
    const rows = this.db.all(
      `SELECT m.id FROM matches m JOIN match_players mp ON mp.match_id = m.id
        WHERE mp.user_id = ? AND m.state IN ('settled','void') ${before ? "AND m.id < ?" : ""}
        ORDER BY m.id DESC LIMIT ?`, ...(before ? [userId, before, limit] : [userId, limit]));
    return rows.map((r) => this.matchView(r.id, userId));
  }

  get(userId, matchId) {
    const m = this.#matchFor(userId, matchId);
    return this.matchView(m.id, userId);
  }
}
