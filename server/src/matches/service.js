/* Player-vs-player matches (race games).

   Life of a match (2 players from the public queue, 2 to lobbyMaxPlayers from an invite lobby; seats 0..N-1)
     queue     join() puts the stake in escrow:ticket:<id> and the player in a bucket (game + stake [+ private code]).
     found     compatible tickets are paired: stakes move to escrow:match:<id>. Every player must call ready()
               within acceptMs, otherwise the match is voided, everyone is refunded and no-shows get a strike.
     playing   when all are ready the server draws the seed, and sends it — once, to the socket that said ready — with a
               start time a few seconds ahead. Each player plays the identical seeded challenge locally and calls submit().
     settled   see matches/standings.js. Highest score among those who did not forfeit wins; tied winners split the payout;
               everyone tied (nobody forfeited) = draw; forfeits and missing scores lose; the last player standing after
               forfeits wins; no scores at all → void, refunds. The pot minus the fee (10%) is shared between the winners,
               and the fee plus any wei that did not divide evenly goes to house:fees.

   Invite-only lobbies reuse the ticket machinery: a lobby is the host's escrowed ticket (escrow:ticket:<id>) carrying a
   server-generated invite code (tickets.lobby_code) that is never put in a matching bucket. A guest's join escrows the
   guest's stake in their own ticket (tickets.lobby_ticket_id → the host's ticket) and only adds them to the roster.
   The host starts the match (or the lobby starts itself when it reaches lobbyMaxPlayers): then every member's ticket goes
   through the same #createMatch as the queue, host first. Leaving, closing and expiry refund the stakes held in tickets.

   Every transition is a compare-and-set on the match state inside a DB transaction together with its ledger movement, so
   a timer, a submit and a forfeit racing each other can settle a match only once and can never create or lose money.

   Trust model: the server picks the seed and the clock, but the SCORE is reported by the player's own client. A modified
   client can lie. Mitigations here are the once-only seed delivery, hard deadlines, sanity bounds, and an advisory flag
   when a score is far above what the strongest bot manages on that seed. Real-money play would need server-side replay.  */
import crypto from "node:crypto";
import { AppError, bad, conflict, forbidden, notFound } from "../util/errors.js";
import { ACCT } from "../ledger.js";
import { big, parseWei, splitPot, toStr } from "../util/amounts.js";
import { shortAddress } from "../util/address.js";
import { START_RATING, pairwiseDeltas } from "./elo.js";
import { decide, placesOf, standings } from "./standings.js";
import { bucketKey, findPartner } from "./queue.js";

const CODE_RE = /^[A-Za-z0-9]{4,16}$/;
const LOBBY_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no 0 O 1 I L
const LOBBY_CODE_LEN = 8;
const LOBBY_MIN_PLAYERS = 2;
const PROGRESS_MIN_GAP_MS = 200;
const MAX_DETAIL = 2000;

export class MatchService {
  constructor({ db, ledger, users, responsible, catalog, cfg, log, hub, now = () => Date.now() }) {
    Object.assign(this, { db, ledger, users, responsible, catalog, cfg, log, hub, now });
    this.tickets = new Map(); // id -> ticket (queued only)
    this.buckets = new Map(); // bucket key -> ticket[]
    this.busy = new Map(); // userId -> { kind: 'ticket' | 'lobby' | 'match', id } (lobby: id = the host's ticket, + role, ticketId)
    this.timers = new Map();
    this.progressAt = new Map();
    this.readyConn = new Map(); // `${matchId}:${seat}` -> connection id that said ready
    this.pairTimer = null;
    this.pendingFlags = new Set();
    this.lobbyCache = null; // { at, playing, recent }
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
    for (const t of this.db.all("SELECT * FROM tickets WHERE state = 'queued' AND lobby_code IS NULL AND lobby_ticket_id IS NULL")) {
      this.#cancelTicketRow(t, "cancelled");
    }
    /* A guest still waiting in a lobby that is no longer open cannot normally exist (a lobby and its guests close in one
       transaction); if one ever does, the stake goes back rather than staying stranded. */
    for (const g of this.db.all(
      `SELECT g.* FROM tickets g WHERE g.state = 'queued' AND g.lobby_ticket_id IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM tickets h WHERE h.id = g.lobby_ticket_id AND h.state = 'queued')`)) {
      this.#cancelTicketRow(g, "cancelled");
    }
    /* Open lobbies survive a restart together with everyone waiting in them (the invite link keeps working): same
       escrow, same roster, expiry timer re-armed for the time left. A lobby already past its expiry is closed now and
       every member is refunded. Nothing is refunded twice: closing is a compare-and-set on the ticket state. */
    for (const t of this.db.all("SELECT * FROM tickets WHERE state = 'queued' AND lobby_code IS NOT NULL")) {
      const left = t.created_at + this.cfg.match.lobbyTtlMs - this.now();
      if (left <= 0) { this.#closeLobbyTicket(t.id, "expired"); continue; }
      for (const r of [t, ...this.db.all("SELECT * FROM tickets WHERE lobby_ticket_id = ? AND state = 'queued' ORDER BY id", t.id)]) {
        const ticket = this.#ticketOf(r);
        this.tickets.set(ticket.id, ticket);
        this.busy.set(ticket.userId, { kind: "lobby", id: t.id, ticketId: ticket.id, role: r.id === t.id ? "host" : "guest" });
      }
      this.#arm(`expire:${t.id}`, left, () => this.#closeLobbyTicket(t.id, "expired"));
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

  /* ------------------------------------------------------------ public lobby */

  /* Anonymous, aggregate-only view of live activity for GET /v1/lobby. Private-code tickets and matches are left out
     entirely, and nothing identifies a waiting player. `recent` shows only the winner's public display name.
     Queue counts come straight from memory; the two SQL reads (running matches, last results) are cached briefly
     because every lobby client polls this every few seconds. */
  lobby(online = 0) {
    const t = this.now();
    const ttl = this.cfg.match.lobbyCacheMs;
    if (!this.lobbyCache || t - this.lobbyCache.at >= ttl || t < this.lobbyCache.at) {
      const playing = this.db.all("SELECT game, COUNT(*) AS n FROM matches WHERE state IN ('found', 'playing') AND code IS NULL GROUP BY game");
      const recent = this.db.all(
        `SELECT m.id, m.game, m.stake, m.pot, m.outcome, m.settled_at, u.display_name
           FROM matches m
           LEFT JOIN match_players mp ON mp.match_id = m.id AND mp.seat = m.winner_seat
           LEFT JOIN users u ON u.id = mp.user_id
          WHERE m.state = 'settled' AND m.outcome IN ('win', 'draw') AND m.code IS NULL
          ORDER BY m.id DESC LIMIT 8`)
        .map((r) => ({ id: r.id, game: r.game, stake: r.stake, pot: r.pot, winner: r.outcome === "win" && r.display_name ? { name: r.display_name } : null, result: r.outcome, endedAt: r.settled_at }));
      this.lobbyCache = { at: t, playing, recent };
    }
    const by = new Map(); // game -> { waiting, playing, stakes: Map<stake, waiting> }
    const row = (game) => { let g = by.get(game); if (!g) by.set(game, g = { game, waiting: 0, playing: 0, stakes: new Map() }); return g; };
    for (const tk of this.tickets.values()) {
      if (tk.code) continue;
      const g = row(tk.game), k = toStr(tk.stake);
      g.waiting++;
      g.stakes.set(k, (g.stakes.get(k) || 0) + 1);
    }
    let playing = 0;
    for (const p of this.lobbyCache.playing) { row(p.game).playing = p.n; playing += p.n; }
    const games = [...by.values()]
      .sort((a, b) => b.waiting - a.waiting || b.playing - a.playing || (a.game < b.game ? -1 : 1))
      .map((g) => ({
        game: g.game, waiting: g.waiting, playing: g.playing,
        stakes: [...g.stakes].map(([stake, waiting]) => ({ stake, waiting })).sort((a, b) => (BigInt(a.stake) < BigInt(b.stake) ? -1 : 1)),
      }));
    return { at: t, online, playing, games, recent: this.lobbyCache.recent };
  }

  /* ------------------------------------------------------------ queue */

  #parseGameStake(game, stake) {
    const g = this.catalog.get(game);
    if (!g) throw bad("UNKNOWN_GAME", "Unknown game.");
    if (!g.pvp) throw bad("GAME_NOT_PVP", `${g.name} cannot be played against another player yet.`);
    const stakeWei = parseWei(stake ?? 0, "stake");
    const e = this.cfg.economy;
    if (stakeWei !== 0n && (stakeWei < e.minStake || stakeWei > e.maxStake)) {
      throw bad("BAD_STAKE", "Stake must be 0 (free play) or within the allowed range.", { min: toStr(e.minStake), max: toStr(e.maxStake) });
    }
    return { g, stakeWei };
  }

  /* account-level gates shared by queueing, hosting and joining */
  #assertMayPlay(userId) {
    const user = this.users.require(userId);
    if (user.banned) throw forbidden("ACCOUNT_BANNED", "This account is suspended.");
    if (user.queue_ban_until > this.now()) throw new AppError("QUEUE_BANNED", "You skipped too many matches. Try again shortly.", 403, { until: user.queue_ban_until });
    if (this.busy.has(userId)) {
      const b = this.busy.get(userId);
      throw conflict("ALREADY_ACTIVE", b.kind === "lobby" ? (b.role === "guest" ? "Leave the lobby you joined first." : "Close your open lobby first.") : "Finish or leave your current queue, lobby or match first.");
    }
    return user;
  }

  join(userId, { game, stake, code } = {}) {
    const hasCode = code != null && code !== "";
    if (!hasCode && !this.cfg.match.publicQueue) throw forbidden("PUBLIC_QUEUE_DISABLED", "Random matchmaking is switched off. Create a lobby and invite a friend instead.");
    const { stakeWei } = this.#parseGameStake(game, stake);
    let privateCode = null;
    if (code != null && code !== "") {
      if (typeof code !== "string" || !CODE_RE.test(code)) throw bad("BAD_CODE", "A private-match code is 4–16 letters or numbers.");
      privateCode = code.toUpperCase();
    }
    this.#assertMayPlay(userId);
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
    if (partner) this.#createMatch(partner.at <= ticket.at ? [partner, ticket] : [ticket, partner]);
  }

  /* windows widen with time, so re-check every waiting ticket periodically */
  #sweep() {
    for (const list of [...this.buckets.values()]) {
      for (const t of [...list]) if (this.tickets.has(t.id)) this.#tryPair(t);
    }
  }

  /* ------------------------------------------------------------ invite-only lobbies */

  #newLobbyCode() {
    for (let i = 0; i < 20; i++) {
      let c = "";
      for (let j = 0; j < LOBBY_CODE_LEN; j++) c += LOBBY_ALPHABET[crypto.randomInt(LOBBY_ALPHABET.length)];
      if (!this.db.get("SELECT 1 AS x FROM tickets WHERE lobby_code = ?", c)) return c;
    }
    throw new Error("could not allocate a lobby code");
  }

  #lobbyRow(code) {
    const c = typeof code === "string" ? code.trim().toUpperCase() : "";
    if (c.length !== LOBBY_CODE_LEN || ![...c].every((ch) => LOBBY_ALPHABET.includes(ch))) return null;
    return this.db.get("SELECT * FROM tickets WHERE lobby_code = ?", c) || null;
  }

  /* in-memory form of a ticket row */
  #ticketOf(r) {
    return { id: r.id, userId: r.user_id, game: r.game, stake: big(r.stake), code: r.code, lobbyCode: r.lobby_code, rating: r.rating, at: r.created_at, key: null };
  }

  /* Everyone in a lobby, the host first, then guests in join order. Members are the host's ticket plus the guest tickets
     that share its state: the waiting guests while the lobby is open, the players of the match once it started, and
     whoever was inside when it closed. A guest who left has the ticket state 'left' and is never listed. */
  #lobbyMembers(row) {
    return this.db.all(
      `SELECT t.id AS ticket_id, t.user_id, u.display_name, u.address
         FROM tickets t JOIN users u ON u.id = t.user_id
        WHERE t.id = ? OR (t.lobby_ticket_id = ? AND t.state = ?)
        ORDER BY t.id`, row.id, row.id, row.state);
  }

  /* The lobby as one person sees it. Public (no viewer, or a viewer who is not a member): names only, never a user id or
     an address. Member view (host and guests): adds `role` and, per player, `you` and a short address as `avatar`. */
  #lobbyView(row, viewerId = null, members = this.#lobbyMembers(row)) {
    const g = this.catalog.get(row.game);
    const host = members.find((m) => m.ticket_id === row.id) || this.users.byId(row.user_id);
    const stake = big(row.stake), count = members.length, pot = stake * BigInt(count);
    const { payout } = splitPot(pot, this.cfg.economy.feeBps);
    const state = row.state === "queued" ? "open" : row.state === "matched" ? "matched" : "closed";
    const mine = viewerId == null ? null : members.find((m) => m.user_id === viewerId) || null;
    return {
      code: row.lobby_code,
      game: { id: row.game, name: g ? g.name : row.game },
      stake: toStr(stake), pot: toStr(pot), winnerPayout: toStr(payout), feeBps: this.cfg.economy.feeBps,
      host: { name: host ? host.display_name : "Player" },
      state,
      ...(state === "open" ? {} : { closedReason: state === "matched" ? "matched" : row.state }),
      createdAt: row.created_at, expiresAt: row.created_at + this.cfg.match.lobbyTtlMs,
      ...(state === "matched" && row.match_id != null ? { matchId: row.match_id } : {}),
      minPlayers: LOBBY_MIN_PLAYERS, maxPlayers: this.cfg.match.lobbyMaxPlayers, playerCount: count,
      ...(mine ? { role: mine.user_id === row.user_id ? "host" : "guest" } : {}),
      players: members.map((m) => ({
        name: m.display_name, host: m.ticket_id === row.id,
        ...(mine ? { you: m.user_id === viewerId, avatar: shortAddress(m.address) } : {}),
      })),
    };
  }

  /* tell every member, each with their own view */
  #notifyLobby(row, type, members = this.#lobbyMembers(row)) {
    for (const m of members) this.hub.notify(m.user_id, { type, lobby: this.#lobbyView(row, m.user_id, members) });
  }

  /* forget a lobby ticket (host or guest) in memory; the player is free again */
  #dropLobbyTicket(hostId, userId, ticketId) {
    this.tickets.delete(ticketId);
    this.#disarm(`expire:${ticketId}`);
    const b = this.busy.get(userId);
    if (b && b.kind === "lobby" && b.id === hostId) this.busy.delete(userId);
  }

  createLobby(userId, { game, stake } = {}) {
    const { stakeWei } = this.#parseGameStake(game, stake);
    this.#assertMayPlay(userId);
    this.responsible.assertCanStake(userId, stakeWei, 0n);
    const rating = this.rating(userId, game);
    const code = this.#newLobbyCode();
    const ticket = this.db.tx(() => {
      const at = this.now();
      const id = Number(this.db.run("INSERT INTO tickets (user_id, game, stake, code, lobby_code, rating, state, created_at) VALUES (?, ?, ?, ?, ?, ?, 'queued', ?)",
        userId, game, toStr(stakeWei), code, code, rating, at).lastInsertRowid);
      if (stakeWei > 0n) this.ledger.transfer(ACCT.user(userId), ACCT.ticket(id), stakeWei, { kind: "stake-hold", ref: id, uniq: `ticket-hold:${id}` });
      return { id, userId, game, stake: stakeWei, code, lobbyCode: code, rating, at, key: null };
    });
    /* in the ticket map (stakeAtRisk, sync) but deliberately never in a bucket, so nobody can be auto-paired into it */
    this.tickets.set(ticket.id, ticket);
    this.busy.set(userId, { kind: "lobby", id: ticket.id, ticketId: ticket.id, role: "host" });
    this.#arm(`expire:${ticket.id}`, this.cfg.match.lobbyTtlMs, () => this.#closeLobbyTicket(ticket.id, "expired"));
    const lobby = this.#lobbyView(this.db.get("SELECT * FROM tickets WHERE id = ?", ticket.id), userId);
    this.hub.notify(userId, { type: "lobby.created", lobby });
    this.hub.notify(userId, { type: "wallet.updated", reason: "stake-held" });
    this.log.info("lobby created", { ticketId: ticket.id, game, stake: toStr(stakeWei) });
    return lobby;
  }

  /* public view, for anyone with the link */
  getLobby(code) {
    const row = this.#lobbyRow(code);
    if (!row) throw new AppError("LOBBY_NOT_FOUND", "This invite link is not valid.", 404);
    return this.#lobbyView(row);
  }

  /* Host closes: with a code, that lobby (must be theirs); without, their open lobby. Everyone inside is refunded. */
  closeLobby(userId, code) {
    let row;
    if (code == null || code === "") {
      const b = this.busy.get(userId);
      row = b && b.kind === "lobby" ? this.db.get("SELECT * FROM tickets WHERE id = ?", b.id) : null;
      if (!row) throw new AppError("LOBBY_NOT_FOUND", "You have no open lobby.", 404);
    } else {
      row = this.#lobbyRow(code);
      if (!row) throw new AppError("LOBBY_NOT_FOUND", "This invite link is not valid.", 404);
    }
    if (row.user_id !== userId) throw forbidden("LOBBY_NOT_HOST", "Only the host can close this lobby.");
    if (row.state === "matched") throw conflict("LOBBY_CLOSED", "This lobby has already started.");
    if (row.state === "queued") this.#closeLobbyTicket(row.id, "cancelled");
    return this.#lobbyView(this.db.get("SELECT * FROM tickets WHERE id = ?", row.id), userId);
  }

  /* Cancel or expire an open lobby: the host's ticket and every waiting guest's ticket change state and are refunded in
     ONE transaction, compare-and-set on the host ticket's state. Then every member hears lobby.closed + wallet.updated. */
  #closeLobbyTicket(ticketId, state) {
    const row = this.db.get("SELECT * FROM tickets WHERE id = ?", ticketId);
    if (!row || row.state !== "queued" || row.lobby_code == null) return;
    const guests = this.db.all("SELECT * FROM tickets WHERE lobby_ticket_id = ? AND state = 'queued' ORDER BY id", ticketId);
    const members = this.#lobbyMembers(row); // read before the state change
    this.db.tx(() => { for (const t of [row, ...guests]) this.#cancelTicketRow(t, state); });
    for (const t of [row, ...guests]) this.#dropLobbyTicket(ticketId, t.user_id, t.id);
    const closed = this.db.get("SELECT * FROM tickets WHERE id = ?", ticketId);
    for (const m of members) {
      this.hub.notify(m.user_id, { type: "lobby.closed", lobby: this.#lobbyView(closed, m.user_id, members) });
      this.hub.notify(m.user_id, { type: "wallet.updated", reason: "stake-released" });
    }
    this.log.info("lobby closed", { ticketId, reason: state, players: members.length });
  }

  /* Guest joins. The stake goes into escrow and the guest onto the roster, nothing more: the match starts when the host
     says so, or at once if this join fills the lobby. Everything below runs synchronously (node:sqlite, no awaits), so two
     joins can never interleave: the lobby cannot be overfilled, and a lobby closed or started a moment earlier is seen as
     such before any of this player's money moves. Returns { lobby } or, when this join filled it, { lobby, match }. */
  joinLobby(userId, code) {
    const row = this.#lobbyRow(code);
    if (!row) throw new AppError("LOBBY_NOT_FOUND", "This invite link is not valid.", 404);
    if (row.user_id === userId) throw conflict("LOBBY_OWN", "This is your own lobby. Send the invite link to a friend.");
    const max = this.cfg.match.lobbyMaxPlayers;
    const members = this.#lobbyMembers(row);
    if ((row.state === "queued" || row.state === "matched") && members.some((m) => m.user_id === userId)) throw conflict("LOBBY_ALREADY_IN", "You are already in this lobby.");
    if (row.state === "matched" && members.length >= max) throw conflict("LOBBY_FULL", "This lobby is full.", { maxPlayers: max });
    if (row.state !== "queued" || !this.tickets.has(row.id)) throw conflict("LOBBY_CLOSED", "This lobby is no longer open.");
    if (members.length >= max) throw conflict("LOBBY_FULL", "This lobby is full.", { maxPlayers: max });
    const { stakeWei } = this.#parseGameStake(row.game, row.stake);
    this.#assertMayPlay(userId);
    this.responsible.assertCanStake(userId, stakeWei, 0n);

    const rating = this.rating(userId, row.game);
    /* the hold and the ticket insert share one transaction: if it throws, nothing was charged */
    const guest = this.db.tx(() => {
      const id = Number(this.db.run("INSERT INTO tickets (user_id, game, stake, code, lobby_ticket_id, rating, state, created_at) VALUES (?, ?, ?, ?, ?, ?, 'queued', ?)",
        userId, row.game, toStr(stakeWei), row.lobby_code, row.id, rating, this.now()).lastInsertRowid);
      if (stakeWei > 0n) this.ledger.transfer(ACCT.user(userId), ACCT.ticket(id), stakeWei, { kind: "stake-hold", ref: id, uniq: `ticket-hold:${id}` });
      return { id, userId, game: row.game, stake: stakeWei, code: row.lobby_code, lobbyCode: null, rating, at: this.now(), key: null };
    });
    this.tickets.set(guest.id, guest);
    this.busy.set(userId, { kind: "lobby", id: row.id, ticketId: guest.id, role: "guest" });
    this.hub.notify(userId, { type: "wallet.updated", reason: "stake-held" });
    const roster = this.#lobbyMembers(row);
    this.#notifyLobby(row, "lobby.updated", roster);
    this.log.info("lobby joined", { ticketId: row.id, guestTicketId: guest.id, players: roster.length });

    if (roster.length >= max) {
      try { this.#startLobby(row); }
      catch (e) { this.log.error("lobby auto-start failed; the host can still start it", { ticketId: row.id, error: e }); } // everything rolled back
    }
    const now = this.db.get("SELECT * FROM tickets WHERE id = ?", row.id);
    return {
      lobby: this.#lobbyView(now, userId),
      ...(now.state === "matched" ? { match: this.matchView(now.match_id, userId) } : {}),
    };
  }

  /* A guest leaves before the start: the stake comes back, the others see the new roster. The leaver gets lobby.closed
     (and the HTTP answer) with a public view of the lobby marked closed/"left" — for them it is over; it stays open for the rest. */
  leaveLobby(userId, code) {
    const row = this.#lobbyRow(code);
    if (!row) throw new AppError("LOBBY_NOT_FOUND", "This invite link is not valid.", 404);
    if (row.user_id === userId) throw conflict("LOBBY_HOST_LEAVE", "Cancel the lobby instead.");
    if (row.state !== "queued" || !this.tickets.has(row.id)) throw conflict("LOBBY_CLOSED", "This lobby is no longer open.");
    const g = this.db.get("SELECT * FROM tickets WHERE lobby_ticket_id = ? AND user_id = ? AND state = 'queued'", row.id, userId);
    if (!g) throw conflict("LOBBY_NOT_IN", "You are not in this lobby.");
    this.#cancelTicketRow(g, "left");
    this.#dropLobbyTicket(row.id, userId, g.id);
    const roster = this.#lobbyMembers(row);
    const lobby = { ...this.#lobbyView(row, null, roster), state: "closed", closedReason: "left" };
    this.hub.notify(userId, { type: "lobby.closed", lobby });
    this.hub.notify(userId, { type: "wallet.updated", reason: "stake-released" });
    this.#notifyLobby(row, "lobby.updated", roster);
    this.log.info("lobby left", { ticketId: row.id, guestTicketId: g.id, players: roster.length });
    return lobby;
  }

  /* The host starts the match with whoever is in. Returns the host's view of the match. */
  startLobby(userId, code) {
    const row = this.#lobbyRow(code);
    if (!row) throw new AppError("LOBBY_NOT_FOUND", "This invite link is not valid.", 404);
    if (row.user_id !== userId) throw forbidden("LOBBY_NOT_HOST", "Only the host can start this lobby.");
    if (row.state !== "queued" || !this.tickets.has(row.id)) throw conflict("LOBBY_CLOSED", row.state === "matched" ? "This lobby has already started." : "This lobby is no longer open.");
    const count = this.#lobbyMembers(row).length;
    if (count < LOBBY_MIN_PLAYERS) throw conflict("LOBBY_NOT_ENOUGH_PLAYERS", "Wait for at least one more player before starting.", { minPlayers: LOBBY_MIN_PLAYERS, playerCount: count });
    return this.matchView(this.#startLobby(row), userId);
  }

  /* every member's ticket → one match, host in seat 0, guests in join order. Returns the match id. */
  #startLobby(row) {
    const rows = [row, ...this.db.all("SELECT * FROM tickets WHERE lobby_ticket_id = ? AND state = 'queued' ORDER BY id", row.id)];
    return this.#createMatch(rows.map((r) => this.tickets.get(r.id) || this.#ticketOf(r)));
  }

  /* ------------------------------------------------------------ match creation */

  /* tickets in seat order; all must be queued and share game and stake. The stakes move into the match escrow. */
  #createMatch(tickets) {
    const stake = tickets[0].stake;
    const pot = stake * BigInt(tickets.length);
    const { fee } = splitPot(pot, this.cfg.economy.feeBps);
    const readyDeadline = this.now() + this.cfg.match.acceptMs;
    const mid = this.db.tx(() => {
      const id = Number(this.db.run("INSERT INTO matches (game, stake, pot, fee, state, code, created_at, ready_deadline) VALUES (?, ?, ?, ?, 'found', ?, ?, ?)",
        tickets[0].game, toStr(stake), toStr(pot), toStr(fee), tickets[0].code, this.now(), readyDeadline).lastInsertRowid);
      tickets.forEach((t, seat) => {
        this.db.run("INSERT INTO match_players (match_id, seat, user_id, ticket_id, rating_before) VALUES (?, ?, ?, ?, ?)", id, seat, t.userId, t.id, t.rating);
        const c = this.db.run("UPDATE tickets SET state = 'matched', closed_at = ?, match_id = ? WHERE id = ? AND state = 'queued'", this.now(), id, t.id).changes;
        if (!c) throw new Error(`ticket ${t.id} was not queued`);
        if (stake > 0n) this.ledger.transfer(ACCT.ticket(t.id), ACCT.match(id), stake, { kind: "stake-lock", ref: id, uniq: `ticket-lock:${t.id}` });
      });
      return id;
    });
    for (const t of tickets) {
      this.#dequeue(t);
      this.busy.set(t.userId, { kind: "match", id: mid });
    }
    this.#arm(`ready:${mid}`, this.cfg.match.acceptMs, () => this.#readyTimeout(mid));
    this.log.info("match found", { matchId: mid, game: tickets[0].game, stake: toStr(stake), players: tickets.map((t) => t.userId) });
    for (const t of tickets) {
      this.hub.notify(t.userId, { type: "match.found", match: this.matchView(mid, t.userId) });
    }
    return mid;
  }

  /* ------------------------------------------------------------ ready → start */

  ready(userId, matchId, connId = null) {
    const m = this.#matchFor(userId, matchId);
    const seat = this.#seat(m, userId);
    if (m.state === "found") {
      if (this.now() > m.ready_deadline) throw conflict("READY_EXPIRED", "The time to accept this match has passed.");
      this.db.run("UPDATE match_players SET ready_at = COALESCE(ready_at, ?) WHERE match_id = ? AND seat = ?", this.now(), matchId, seat);
      this.readyConn.set(`${matchId}:${seat}`, connId);
      const ps = this.#players(matchId);
      this.#tellOthers(ps, seat, { type: "match.opponent_ready", matchId, seat });
      if (ps.every((p) => p.ready_at != null)) this.#start(matchId);
      return { matchId, state: this.db.get("SELECT state FROM matches WHERE id = ?", matchId).state };
    }
    if (m.state === "playing") {
      // a player whose seed never reached a socket may ask once more, as long as the game is still running
      const p = this.#players(matchId)[seat];
      if (p.forfeited) throw conflict("FORFEITED", "You forfeited this match.");
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

  /* live score for the other players' race bars. Display only; never used for settlement. */
  progress(userId, matchId, score) {
    const m = this.#matchFor(userId, matchId);
    if (m.state !== "playing" || this.now() < m.start_at || !Number.isFinite(score)) return;
    const seat = this.#seat(m, userId);
    const key = `${matchId}:${seat}`;
    const last = this.progressAt.get(key) || 0;
    if (this.now() - last < PROGRESS_MIN_GAP_MS) return;
    const ps = this.#players(matchId);
    if (ps[seat].forfeited) return;
    this.progressAt.set(key, this.now());
    this.#tellOthers(ps, seat, { type: "match.opponent_progress", matchId, seat, score });
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
    if (own.forfeited) throw conflict("FORFEITED", "You forfeited this match.");
    if (own.score != null) throw conflict("ALREADY_SUBMITTED", "You already submitted a result for this match.");
    this.db.run("UPDATE match_players SET score = ?, detail = ?, submitted_at = ? WHERE match_id = ? AND seat = ? AND score IS NULL", score, text, now, matchId, seat);
    this.#tellOthers(this.#players(matchId), seat, { type: "match.opponent_finished", matchId, seat });
    this.#settleIfDone(matchId);
    return { matchId, accepted: true };
  }

  forfeit(userId, matchId) {
    const m = this.#matchFor(userId, matchId);
    const seat = this.#seat(m, userId);
    if (m.state === "found") {
      // declining a match you were paired into wastes the other players' time: counts like a no-show, and voids the match for all
      this.#voidFound(matchId, "declined", [seat]);
      return { matchId, state: "void" };
    }
    if (m.state !== "playing") throw conflict("MATCH_OVER", "This match is over.");
    if (this.#players(matchId)[seat].forfeited) return { matchId, state: "playing" }; // already out; the match goes on without them
    this.db.run("UPDATE match_players SET forfeited = 1 WHERE match_id = ? AND seat = ?", matchId, seat);
    this.#settleIfDone(matchId);
    const state = this.db.get("SELECT state FROM matches WHERE id = ?", matchId).state;
    // the match goes on: tell the others who dropped out (when it ended instead, they get match.result)
    if (state === "playing") this.#tellOthers(this.#players(matchId), seat, { type: "match.opponent_forfeited", matchId, seat });
    return { matchId, state };
  }

  /* Settle the moment nothing can change any more: forfeits left at most one player standing, or every player still
     standing has submitted. Otherwise the deadline timer settles it. */
  #settleIfDone(matchId) {
    const ps = this.#players(matchId);
    const standing = ps.filter((p) => !p.forfeited);
    if ((standing.length < ps.length && standing.length <= 1) || standing.every((p) => p.score != null)) this.#settle(matchId);
  }

  /* one event to every player except the one it is about */
  #tellOthers(ps, exceptSeat, msg) {
    for (const p of ps) if (p.seat !== exceptSeat) this.hub.notify(p.user_id, msg);
  }

  #deadline(matchId) {
    this.#settle(matchId);
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

  /* everybody's stake back out of the match escrow */
  #refund(matchId) {
    const m = this.db.get("SELECT * FROM matches WHERE id = ?", matchId);
    const stake = big(m.stake);
    if (stake === 0n) return;
    const ps = this.#players(matchId);
    this.ledger.post({
      kind: "match-refund", ref: matchId, uniq: `match-refund:${matchId}`,
      entries: [[ACCT.match(matchId), -(stake * BigInt(ps.length))], ...ps.map((p) => [ACCT.user(p.user_id), stake])],
    });
  }

  /* Decide the result (standings.js), move the money, rate the players: one transaction, compare-and-set on the state.
     Money: a win pays the winners an equal share each of pot − fee (integer division); the fee and the wei that did not
     divide go to the house, so the entries always sum to zero. A draw or a void match refunds every stake, no fee. */
  #settle(matchId) {
    const settled = this.db.tx(() => {
      const m = this.db.get("SELECT * FROM matches WHERE id = ?", matchId);
      if (!m || m.state !== "playing") return false; // somebody else already settled it
      const ps = this.#players(matchId);
      const stake = big(m.stake), pot = big(m.pot);
      const { outcome, why, winners } = decide(ps);
      const won = new Set(winners);

      // ---- money
      const share = outcome === "win" ? splitPot(pot, this.cfg.economy.feeBps).payout / BigInt(winners.length) : 0n;
      const houseTake = outcome === "win" ? pot - share * BigInt(winners.length) : 0n; // fee + remainder
      if (outcome !== "win") this.#refund(matchId);
      else if (stake > 0n) {
        const entries = [[ACCT.match(matchId), -pot], ...winners.map((seat) => [ACCT.user(ps[seat].user_id), share])];
        if (houseTake > 0n) entries.push([ACCT.house, houseTake]);
        this.ledger.post({ kind: "match-settle", ref: matchId, uniq: `match-settle:${matchId}`, entries });
      }

      // ---- ratings (a void match changes nobody's rating)
      const before = ps.map((p) => p.rating_before);
      let after = before;
      if (outcome !== "void") {
        const d = pairwiseDeltas(before, standings(ps, why));
        after = before.map((r, i) => r + d[i]);
        ps.forEach((p, seat) => {
          const result = outcome === "draw" ? "draws" : won.has(seat) ? "wins" : "losses";
          this.db.run("INSERT OR IGNORE INTO ratings (user_id, game, rating, updated_at) VALUES (?, ?, ?, ?)", p.user_id, m.game, START_RATING, this.now());
          this.db.run(`UPDATE ratings SET rating = ?, ${result} = ${result} + 1, best = CASE WHEN ? IS NULL THEN best WHEN best IS NULL OR ? > best THEN ? ELSE best END, updated_at = ?
                        WHERE user_id = ? AND game = ?`, after[seat], p.score, p.score, p.score, this.now(), p.user_id, m.game);
        });
      }

      // ---- per-player result + daily net for the loss limit
      ps.forEach((p, seat) => {
        const got = outcome === "win" ? (won.has(seat) ? share : 0n) : stake; // draw/void: own stake back
        this.db.run("UPDATE match_players SET rating_after = ?, payout = ? WHERE match_id = ? AND seat = ?", after[seat], toStr(stake > 0n ? got : 0n), matchId, seat);
        if (stake > 0n && outcome !== "void") this.responsible.recordNet(p.user_id, got - stake);
      });

      const state = outcome === "void" ? "void" : "settled";
      this.db.run("UPDATE matches SET state = ?, outcome = ?, reason = ?, fee = ?, winner_seat = ?, settled_at = ? WHERE id = ?",
        state, outcome, why, toStr(houseTake), winners.length ? winners[0] : null, this.now(), matchId);
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
      const b = this.busy.get(p.user_id);
      if (b && b.kind === "match" && b.id === matchId) this.busy.delete(p.user_id);
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

  /* One match as seen by one of its players. `opponent` is kept for 1v1 clients (the first other player by seat);
     `players` lists everybody by seat. Scores of the others, ratingAfter, payout and place are revealed once the match is over. */
  matchView(matchId, viewerId) {
    const m = this.db.get("SELECT * FROM matches WHERE id = ?", matchId);
    const ps = this.#players(matchId);
    const me = ps.find((p) => p.user_id === viewerId);
    const opp = ps.find((p) => p.user_id !== viewerId);
    const final = m.state === "settled" || m.state === "void";
    const g = this.catalog.get(m.game);
    const { payout } = splitPot(big(m.pot), this.cfg.economy.feeBps);
    // 1 = top; ties share a place. Derived from the stored rows, so matches settled before multi-player existed read the same.
    const places = final && m.outcome !== "void" ? placesOf(standings(ps, m.reason)) : null;
    const place = (p) => (places ? places[p.seat] : null);
    const result = !final ? null : m.outcome === "void" ? "void" : m.outcome === "draw" ? "draw" : place(me) === 1 ? "win" : "loss";
    return {
      id: m.id, state: m.state, result, reason: m.reason,
      game: { id: m.game, name: g ? g.name : m.game, scoreLabel: g ? g.scoreLabel : "score", maxSeconds: g ? Math.round(g.maxMs / 1000) : null },
      stake: m.stake, pot: m.pot, fee: m.fee, winnerPayout: toStr(payout), private: !!m.code,
      readyDeadline: m.ready_deadline, startAt: m.start_at, submitDeadline: m.submit_deadline, settledAt: m.settled_at,
      seed: final ? m.seed : undefined, // revealed only afterwards, so anyone involved can replay and audit
      you: { seat: me.seat, ready: me.ready_at != null, submitted: me.score != null, score: me.score, payout: me.payout, ratingBefore: me.rating_before, ratingAfter: me.rating_after, seedDelivered: !!me.seed_sent, ...(final ? { place: place(me) } : {}) },
      opponent: {
        ...this.users.publicView({ id: opp.user_id, display_name: opp.display_name, address: opp.address }),
        ready: opp.ready_at != null, finished: opp.score != null, score: final ? opp.score : null,
        ratingBefore: opp.rating_before, ratingAfter: final ? opp.rating_after : null,
      },
      playerCount: ps.length,
      players: ps.map((p) => ({
        seat: p.seat, name: p.display_name, address: shortAddress(p.address), you: p.user_id === viewerId,
        ready: p.ready_at != null, finished: p.score != null, forfeited: !!p.forfeited,
        score: final || p.user_id === viewerId ? p.score : null,
        ratingBefore: p.rating_before, ratingAfter: final ? p.rating_after : null,
        payout: final ? p.payout : null, place: final ? place(p) : null,
      })),
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
    if (b.kind === "lobby") {
      const row = this.db.get("SELECT * FROM tickets WHERE id = ?", b.id);
      return { active: row ? { kind: "lobby", lobby: this.#lobbyView(row, userId) } : null };
    }
    return { active: { kind: "match", match: this.matchView(b.id, userId) } };
  }

  active(userId) { return this.busy.get(userId) || null; }

  /* the stake this player currently has in escrow (queued ticket or unfinished match) */
  stakeAtRisk(userId) {
    const b = this.busy.get(userId);
    if (!b) return 0n;
    if (b.kind === "ticket" || b.kind === "lobby") { const t = this.tickets.get(b.ticketId ?? b.id); return t ? t.stake : 0n; }
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
