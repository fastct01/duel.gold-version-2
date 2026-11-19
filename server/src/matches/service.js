/* Player-vs-player matches (race games). INVITE-ONLY: there is no public matchmaking, no queue and no way to search for or
   challenge a player. The only way two players meet is a lobby code (or the link that carries it).

   Life of a match (2 to lobbyMaxPlayers players from an invite lobby; seats 0..N-1)
     lobby     createLobby() puts the host's stake in escrow:ticket:<id>; each guest's joinLobby() escrows theirs likewise.
     found     the host starts the lobby (or it is full): every member's ticket moves into one match, stakes go to
               escrow:match:<id>. Every player must call ready() within acceptMs, otherwise the match is voided, everyone is
               refunded and no-shows get a strike.
     playing   when all are ready the server draws the seed, and sends it — once, to the socket that said ready — with a
               start time a few seconds ahead. Each player plays the identical seeded challenge locally and calls submit().
     settled   see matches/standings.js. Highest score among those who did not forfeit wins; tied winners split the payout;
               everyone tied (nobody forfeited) = draw; forfeits and missing scores lose; the last player standing after
               forfeits wins; no scores at all → void, refunds. The pot minus the fee (10%) is shared between the winners,
               and the fee plus any wei that did not divide evenly goes to house:fees.

   A lobby is the host's escrowed ticket (escrow:ticket:<id>) carrying a server-generated invite code (tickets.lobby_code).
   A guest's join escrows the guest's stake in their own ticket (tickets.lobby_ticket_id → the host's ticket) and only adds
   them to the roster. The host starts the match (or the lobby starts itself when it reaches lobbyMaxPlayers): then every
   member's ticket goes through #createMatch, host first. Leaving, closing and expiry refund the stakes held in tickets.
   (A ticket's stored state 'queued' means "waiting in an open lobby"; the word is kept so existing databases stay valid.)

   Every transition is a compare-and-set on the match state inside a DB transaction together with its ledger movement, so
   a timer, a submit and a forfeit racing each other can settle a match only once and can never create or lose money.
   On top of that, every public operation that changes something, and every timer, runs inside db.exclusive() — one
   process-wide lock (see db/index.js) — so the in-memory maps below and the rows they mirror are never seen half-updated
   by another operation, exactly as when the database was synchronous.

   Trust model: the server picks the seed and the clock, but the SCORE is reported by the player's own client. A modified
   client can lie. Mitigations here are the once-only seed delivery, hard deadlines, sanity bounds, and an advisory flag
   when a score is far above what the strongest bot manages on that seed. Real-money play needs server-side replay.      */
import crypto from "node:crypto";
import { AppError, bad, conflict, forbidden, notFound } from "../util/errors.js";
import { ACCT } from "../ledger.js";
import { big, parseWei, splitPot, toStr } from "../util/amounts.js";
import { shortAddress } from "../util/address.js";
import { START_RATING, pairwiseDeltas } from "./elo.js";
import { decide, placesOf, standings } from "./standings.js";

const CODE_RE = /^[A-Za-z0-9]{4,16}$/;
const LOBBY_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no 0 O 1 I L
const LOBBY_CODE_LEN = 8;
const LOBBY_MIN_PLAYERS = 2;
const PROGRESS_MIN_GAP_MS = 200;
const MAX_DETAIL = 2000;

export class MatchService {
  constructor({ db, ledger, users, responsible, catalog, cfg, log, hub, now = () => Date.now() }) {
    Object.assign(this, { db, ledger, users, responsible, catalog, cfg, log, hub, now });
    this.tickets = new Map(); // id -> ticket (open lobbies only: the host's and every waiting guest's)
    this.busy = new Map(); // userId -> { kind: 'lobby' | 'match', id } (lobby: id = the host's ticket, + role, ticketId)
    this.timers = new Map();
    this.progressAt = new Map();
    this.readyConn = new Map(); // `${matchId}:${seat}` -> connection id that said ready
    this.pendingFlags = new Set();
    this.tables = new Map(); // matchId -> { g, engine, state, seats: userId[], startAt } for table games being played
  }

  /* run one operation under the process-wide lock */
  #op(fn) { return this.db.exclusive(fn); }

  /* ------------------------------------------------------------ lifecycle */

  start() {
    return this.#op(() => this.recover());
  }

  stop() {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }

  /* After a restart: open lobbies are restored, matches that never started are voided, running matches get their deadline
     timer back. Money is never stranded because escrow is in the ledger, not in memory. */
  async recover() {
    /* A ticket that is neither a lobby nor in one can only be left over from a database written when a public queue existed
       (tickets that sat in a queue). Nothing can ever match it now, so its stake goes back instead of staying in escrow. */
    for (const t of await this.db.all("SELECT * FROM tickets WHERE state = 'queued' AND lobby_code IS NULL AND lobby_ticket_id IS NULL")) {
      await this.#cancelTicketRow(t, "cancelled");
    }
    /* A guest still waiting in a lobby that is no longer open cannot normally exist (a lobby and its guests close in one
       transaction); if one ever does, the stake goes back rather than staying stranded. */
    for (const g of await this.db.all(
      `SELECT g.* FROM tickets g WHERE g.state = 'queued' AND g.lobby_ticket_id IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM tickets h WHERE h.id = g.lobby_ticket_id AND h.state = 'queued')`)) {
      await this.#cancelTicketRow(g, "cancelled");
    }
    /* Open lobbies survive a restart together with everyone waiting in them (the invite link keeps working): same
       escrow, same roster, expiry timer re-armed for the time left. A lobby already past its expiry is closed now and
       every member is refunded. Nothing is refunded twice: closing is a compare-and-set on the ticket state. */
    for (const t of await this.db.all("SELECT * FROM tickets WHERE state = 'queued' AND lobby_code IS NOT NULL")) {
      const left = t.created_at + this.cfg.match.lobbyTtlMs - this.now();
      if (left <= 0) { await this.#closeLobbyTicket(t.id, "expired"); continue; }
      for (const r of [t, ...(await this.db.all("SELECT * FROM tickets WHERE lobby_ticket_id = ? AND state = 'queued' ORDER BY id", t.id))]) {
        const ticket = this.#ticketOf(r);
        this.tickets.set(ticket.id, ticket);
        this.busy.set(ticket.userId, { kind: "lobby", id: t.id, ticketId: ticket.id, role: r.id === t.id ? "host" : "guest" });
      }
      this.#arm(`expire:${t.id}`, left, () => this.#closeLobbyTicket(t.id, "expired"));
    }
    for (const m of await this.db.all("SELECT * FROM matches WHERE state = 'found'")) {
      await this.#voidFound(m.id, "server_restart", []);
    }
    for (const m of await this.db.all("SELECT * FROM matches WHERE state = 'playing'")) {
      const ps = await this.#players(m.id);
      for (const p of ps) this.busy.set(p.user_id, { kind: "match", id: m.id });
      let deadlineAt = m.submit_deadline;
      const g = this.catalog.get(m.game);
      if (g && g.table) {
        if (!m.table_state) { await this.#settle(m.id); continue; } // nothing to resume: void, everyone refunded
        /* the table picks up where it was; every clock moves on by the time the server was down */
        const state = JSON.parse(m.table_state);
        const down = Math.max(0, this.now() - (state.savedAt || this.now()));
        if (down) g.table.engine.shift(state, down);
        deadlineAt += down;
        if (down) await this.db.run("UPDATE matches SET submit_deadline = ? WHERE id = ?", deadlineAt, m.id);
        const t = { g, engine: g.table.engine, state, seats: ps.map((p) => p.user_id), startAt: m.start_at, left: new Set(ps.filter((p) => p.forfeited).map((p) => p.seat)) };
        this.tables.set(m.id, t);
        this.#armTable(m.id, t);
      }
      this.#arm(`deadline:${m.id}`, Math.max(0, deadlineAt - this.now()), () => this.#deadline(m.id));
    }
    if (this.busy.size) this.log.info("recovered running matches", { players: this.busy.size });
  }

  /* A timer fires outside whatever operation armed it (db.detach) and then queues for the lock like any other operation.
     If it was disarmed or re-armed while it waited, it does nothing. */
  #arm(key, ms, fn) {
    this.#disarm(key);
    const t = this.db.detach(() => setTimeout(() => {
      this.#op(async () => {
        if (this.timers.get(key) !== t) return;
        this.timers.delete(key);
        await fn();
      }).catch((e) => this.log.error("match timer failed", { key, error: e }));
    }, ms));
    t.unref?.();
    this.timers.set(key, t);
  }
  #disarm(key) {
    const t = this.timers.get(key);
    if (t) { clearTimeout(t); this.timers.delete(key); }
  }

  /* ------------------------------------------------------------ ratings */

  async rating(userId, game) {
    const r = await this.db.get("SELECT rating FROM ratings WHERE user_id = ? AND game = ?", userId, game);
    return r ? r.rating : START_RATING;
  }

  ratingsFor(userId) {
    return this.db.all("SELECT game, rating, wins, losses, draws, best FROM ratings WHERE user_id = ? ORDER BY game", userId);
  }

  async leaderboard(game, limit = 20) {
    const rows = await this.db.all(
      `SELECT r.rating, r.wins, r.losses, r.draws, u.id AS user_id, u.display_name, u.address
         FROM ratings r JOIN users u ON u.id = r.user_id
        WHERE r.game = ? AND (r.wins + r.losses + r.draws) > 0
        ORDER BY r.rating DESC, r.wins DESC, u.id LIMIT ?`, game, limit);
    return rows.map((r, i) => ({ rank: i + 1, player: this.users.publicView({ id: r.user_id, display_name: r.display_name, address: r.address }), rating: r.rating, wins: r.wins, losses: r.losses, draws: r.draws }));
  }

  /* ------------------------------------------------------------ admission */

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

  /* account-level gates shared by hosting and joining */
  async #assertMayPlay(userId) {
    const user = await this.users.require(userId);
    if (user.banned) throw forbidden("ACCOUNT_BANNED", "This account is suspended.");
    if (user.queue_ban_until > this.now()) throw new AppError("QUEUE_BANNED", "You skipped too many matches. Try again shortly.", 403, { until: user.queue_ban_until });
    if (this.busy.has(userId)) {
      const b = this.busy.get(userId);
      throw conflict("ALREADY_ACTIVE", b.kind === "lobby" ? (b.role === "guest" ? "Leave the lobby you joined first." : "Close your open lobby first.") : "Finish or leave your current lobby or match first.");
    }
    return user;
  }

  /* DB half of cancelling a ticket (lobby host or guest): state change + refund in one transaction */
  #cancelTicketRow(row, state) {
    return this.db.tx(async () => {
      const c = (await this.db.run("UPDATE tickets SET state = ?, closed_at = ? WHERE id = ? AND state = 'queued'", state, this.now(), row.id)).changes;
      if (!c) return;
      const stake = big(row.stake);
      if (stake > 0n) await this.ledger.transfer(ACCT.ticket(row.id), ACCT.user(row.user_id), stake, { kind: "stake-release", ref: row.id, uniq: `ticket-release:${row.id}` });
    });
  }

  /* ------------------------------------------------------------ invite-only lobbies */

  async #newLobbyCode() {
    for (let i = 0; i < 20; i++) {
      let c = "";
      for (let j = 0; j < LOBBY_CODE_LEN; j++) c += LOBBY_ALPHABET[crypto.randomInt(LOBBY_ALPHABET.length)];
      if (!(await this.db.get("SELECT 1 AS x FROM tickets WHERE lobby_code = ?", c))) return c;
    }
    throw new Error("could not allocate a lobby code");
  }

  async #lobbyRow(code) {
    const c = typeof code === "string" ? code.trim().toUpperCase() : "";
    if (c.length !== LOBBY_CODE_LEN || ![...c].every((ch) => LOBBY_ALPHABET.includes(ch))) return null;
    return (await this.db.get("SELECT * FROM tickets WHERE lobby_code = ?", c)) || null;
  }

  #ticketRow(id) { return this.db.get("SELECT * FROM tickets WHERE id = ?", id); }

  /* most players a lobby for this game can hold: the server limit, or less for a game made for fewer (chess: 2) */
  #maxFor(gameId) {
    const g = this.catalog.get(gameId);
    return Math.min(this.cfg.match.lobbyMaxPlayers, (g && g.maxPlayers) || Infinity);
  }

  /* in-memory form of a ticket row */
  #ticketOf(r) {
    return { id: r.id, userId: r.user_id, game: r.game, stake: big(r.stake), code: r.code, lobbyCode: r.lobby_code, rating: r.rating, at: r.created_at };
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
  async #lobbyView(row, viewerId = null, members = null) {
    members ??= await this.#lobbyMembers(row);
    const g = this.catalog.get(row.game);
    const host = members.find((m) => m.ticket_id === row.id) || (await this.users.byId(row.user_id));
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
      minPlayers: LOBBY_MIN_PLAYERS, maxPlayers: this.#maxFor(row.game), playerCount: count,
      ...(mine ? { role: mine.user_id === row.user_id ? "host" : "guest" } : {}),
      players: members.map((m) => ({
        name: m.display_name, host: m.ticket_id === row.id,
        ...(mine ? { you: m.user_id === viewerId, avatar: shortAddress(m.address) } : {}),
      })),
    };
  }

  /* tell every member, each with their own view */
  async #notifyLobby(row, type, members = null) {
    members ??= await this.#lobbyMembers(row);
    for (const m of members) this.hub.notify(m.user_id, { type, lobby: await this.#lobbyView(row, m.user_id, members) });
  }

  /* forget a lobby ticket (host or guest) in memory; the player is free again */
  #dropLobbyTicket(hostId, userId, ticketId) {
    this.tickets.delete(ticketId);
    this.#disarm(`expire:${ticketId}`);
    const b = this.busy.get(userId);
    if (b && b.kind === "lobby" && b.id === hostId) this.busy.delete(userId);
  }

  createLobby(userId, { game, stake } = {}) {
    return this.#op(async () => {
      const { stakeWei } = this.#parseGameStake(game, stake);
      await this.#assertMayPlay(userId);
      await this.responsible.assertCanStake(userId, stakeWei, 0n);
      const rating = await this.rating(userId, game);
      const code = await this.#newLobbyCode();
      const ticket = await this.db.tx(async () => {
        const at = this.now();
        const id = Number((await this.db.run("INSERT INTO tickets (user_id, game, stake, code, lobby_code, rating, state, created_at) VALUES (?, ?, ?, ?, ?, ?, 'queued', ?) RETURNING id",
          userId, game, toStr(stakeWei), code, code, rating, at)).lastInsertRowid);
        if (stakeWei > 0n) await this.ledger.transfer(ACCT.user(userId), ACCT.ticket(id), stakeWei, { kind: "stake-hold", ref: id, uniq: `ticket-hold:${id}` });
        return { id, userId, game, stake: stakeWei, code, lobbyCode: code, rating, at };
      });
      /* in the ticket map (stakeAtRisk): the only way into this lobby is its code */
      this.tickets.set(ticket.id, ticket);
      this.busy.set(userId, { kind: "lobby", id: ticket.id, ticketId: ticket.id, role: "host" });
      this.#arm(`expire:${ticket.id}`, this.cfg.match.lobbyTtlMs, () => this.#closeLobbyTicket(ticket.id, "expired"));
      const lobby = await this.#lobbyView(await this.#ticketRow(ticket.id), userId);
      this.hub.notify(userId, { type: "lobby.created", lobby });
      this.hub.notify(userId, { type: "wallet.updated", reason: "stake-held" });
      this.log.info("lobby created", { ticketId: ticket.id, game, stake: toStr(stakeWei) });
      return lobby;
    });
  }

  /* public view, for anyone with the link */
  async getLobby(code) {
    const row = await this.#lobbyRow(code);
    if (!row) throw new AppError("LOBBY_NOT_FOUND", "This invite link is not valid.", 404);
    return this.#lobbyView(row);
  }

  /* Host closes: with a code, that lobby (must be theirs); without, their open lobby. Everyone inside is refunded. */
  closeLobby(userId, code) {
    return this.#op(async () => {
      let row;
      if (code == null || code === "") {
        const b = this.busy.get(userId);
        row = b && b.kind === "lobby" ? await this.#ticketRow(b.id) : null;
        if (!row) throw new AppError("LOBBY_NOT_FOUND", "You have no open lobby.", 404);
      } else {
        row = await this.#lobbyRow(code);
        if (!row) throw new AppError("LOBBY_NOT_FOUND", "This invite link is not valid.", 404);
      }
      if (row.user_id !== userId) throw forbidden("LOBBY_NOT_HOST", "Only the host can close this lobby.");
      if (row.state === "matched") throw conflict("LOBBY_CLOSED", "This lobby has already started.");
      if (row.state === "queued") await this.#closeLobbyTicket(row.id, "cancelled");
      return this.#lobbyView(await this.#ticketRow(row.id), userId);
    });
  }

  /* Cancel or expire an open lobby: the host's ticket and every waiting guest's ticket change state and are refunded in
     ONE transaction, compare-and-set on the host ticket's state. Then every member hears lobby.closed + wallet.updated. */
  async #closeLobbyTicket(ticketId, state) {
    const row = await this.#ticketRow(ticketId);
    if (!row || row.state !== "queued" || row.lobby_code == null) return;
    const guests = await this.db.all("SELECT * FROM tickets WHERE lobby_ticket_id = ? AND state = 'queued' ORDER BY id", ticketId);
    const members = await this.#lobbyMembers(row); // read before the state change
    await this.db.tx(async () => { for (const t of [row, ...guests]) await this.#cancelTicketRow(t, state); });
    for (const t of [row, ...guests]) this.#dropLobbyTicket(ticketId, t.user_id, t.id);
    const closed = await this.#ticketRow(ticketId);
    for (const m of members) {
      this.hub.notify(m.user_id, { type: "lobby.closed", lobby: await this.#lobbyView(closed, m.user_id, members) });
      this.hub.notify(m.user_id, { type: "wallet.updated", reason: "stake-released" });
    }
    this.log.info("lobby closed", { ticketId, reason: state, players: members.length });
  }

  /* Guest joins. The stake goes into escrow and the guest onto the roster, nothing more: the match starts when the host
     says so, or at once if this join fills the lobby. The whole join holds the process-wide lock, so two joins can never
     interleave: the lobby cannot be overfilled, and a lobby closed or started a moment earlier is seen as such before any
     of this player's money moves. Returns { lobby } or, when this join filled it, { lobby, match }. */
  joinLobby(userId, code) {
    return this.#op(async () => {
      const row = await this.#lobbyRow(code);
      if (!row) throw new AppError("LOBBY_NOT_FOUND", "This invite link is not valid.", 404);
      if (row.user_id === userId) throw conflict("LOBBY_OWN", "This is your own lobby. Send the invite link to a friend.");
      const max = this.#maxFor(row.game);
      const members = await this.#lobbyMembers(row);
      if ((row.state === "queued" || row.state === "matched") && members.some((m) => m.user_id === userId)) throw conflict("LOBBY_ALREADY_IN", "You are already in this lobby.");
      if (row.state === "matched" && members.length >= max) throw conflict("LOBBY_FULL", "This lobby is full.", { maxPlayers: max });
      if (row.state !== "queued" || !this.tickets.has(row.id)) throw conflict("LOBBY_CLOSED", "This lobby is no longer open.");
      if (members.length >= max) throw conflict("LOBBY_FULL", "This lobby is full.", { maxPlayers: max });
      const { stakeWei } = this.#parseGameStake(row.game, row.stake);
      await this.#assertMayPlay(userId);
      await this.responsible.assertCanStake(userId, stakeWei, 0n);

      const rating = await this.rating(userId, row.game);
      /* the hold and the ticket insert share one transaction: if it throws, nothing was charged */
      const guest = await this.db.tx(async () => {
        const id = Number((await this.db.run("INSERT INTO tickets (user_id, game, stake, code, lobby_ticket_id, rating, state, created_at) VALUES (?, ?, ?, ?, ?, ?, 'queued', ?) RETURNING id",
          userId, row.game, toStr(stakeWei), row.lobby_code, row.id, rating, this.now())).lastInsertRowid);
        if (stakeWei > 0n) await this.ledger.transfer(ACCT.user(userId), ACCT.ticket(id), stakeWei, { kind: "stake-hold", ref: id, uniq: `ticket-hold:${id}` });
        return { id, userId, game: row.game, stake: stakeWei, code: row.lobby_code, lobbyCode: null, rating, at: this.now() };
      });
      this.tickets.set(guest.id, guest);
      this.busy.set(userId, { kind: "lobby", id: row.id, ticketId: guest.id, role: "guest" });
      this.hub.notify(userId, { type: "wallet.updated", reason: "stake-held" });
      const roster = await this.#lobbyMembers(row);
      await this.#notifyLobby(row, "lobby.updated", roster);
      this.log.info("lobby joined", { ticketId: row.id, guestTicketId: guest.id, players: roster.length });

      if (roster.length >= max) {
        try { await this.#startLobby(row); }
        catch (e) { this.log.error("lobby auto-start failed; the host can still start it", { ticketId: row.id, error: e }); } // everything rolled back
      }
      const now = await this.#ticketRow(row.id);
      return {
        lobby: await this.#lobbyView(now, userId),
        ...(now.state === "matched" ? { match: await this.matchView(now.match_id, userId) } : {}),
      };
    });
  }

  /* A guest leaves before the start: the stake comes back, the others see the new roster. The leaver gets lobby.closed
     (and the HTTP answer) with a public view of the lobby marked closed/"left" — for them it is over; it stays open for the rest. */
  leaveLobby(userId, code) {
    return this.#op(async () => {
      const row = await this.#lobbyRow(code);
      if (!row) throw new AppError("LOBBY_NOT_FOUND", "This invite link is not valid.", 404);
      if (row.user_id === userId) throw conflict("LOBBY_HOST_LEAVE", "Cancel the lobby instead.");
      if (row.state !== "queued" || !this.tickets.has(row.id)) throw conflict("LOBBY_CLOSED", "This lobby is no longer open.");
      const g = await this.db.get("SELECT * FROM tickets WHERE lobby_ticket_id = ? AND user_id = ? AND state = 'queued'", row.id, userId);
      if (!g) throw conflict("LOBBY_NOT_IN", "You are not in this lobby.");
      await this.#cancelTicketRow(g, "left");
      this.#dropLobbyTicket(row.id, userId, g.id);
      const roster = await this.#lobbyMembers(row);
      const lobby = { ...(await this.#lobbyView(row, null, roster)), state: "closed", closedReason: "left" };
      this.hub.notify(userId, { type: "lobby.closed", lobby });
      this.hub.notify(userId, { type: "wallet.updated", reason: "stake-released" });
      await this.#notifyLobby(row, "lobby.updated", roster);
      this.log.info("lobby left", { ticketId: row.id, guestTicketId: g.id, players: roster.length });
      return lobby;
    });
  }

  /* The host starts the match with whoever is in. Returns the host's view of the match. */
  startLobby(userId, code) {
    return this.#op(async () => {
      const row = await this.#lobbyRow(code);
      if (!row) throw new AppError("LOBBY_NOT_FOUND", "This invite link is not valid.", 404);
      if (row.user_id !== userId) throw forbidden("LOBBY_NOT_HOST", "Only the host can start this lobby.");
      await this.responsible.assertAdult(userId, big(row.stake)); // staked lobbies need the 18+ attestation here too
      if (row.state !== "queued" || !this.tickets.has(row.id)) throw conflict("LOBBY_CLOSED", row.state === "matched" ? "This lobby has already started." : "This lobby is no longer open.");
      const count = (await this.#lobbyMembers(row)).length;
      if (count < LOBBY_MIN_PLAYERS) throw conflict("LOBBY_NOT_ENOUGH_PLAYERS", "Wait for at least one more player before starting.", { minPlayers: LOBBY_MIN_PLAYERS, playerCount: count });
      return this.matchView(await this.#startLobby(row), userId);
    });
  }

  /* every member's ticket → one match, host in seat 0, guests in join order. Returns the match id. */
  async #startLobby(row) {
    const rows = [row, ...(await this.db.all("SELECT * FROM tickets WHERE lobby_ticket_id = ? AND state = 'queued' ORDER BY id", row.id))];
    return this.#createMatch(rows.map((r) => this.tickets.get(r.id) || this.#ticketOf(r)));
  }

  /* ------------------------------------------------------------ match creation */

  /* tickets in seat order; all must be queued and share game and stake. The stakes move into the match escrow. */
  async #createMatch(tickets) {
    const stake = tickets[0].stake;
    const pot = stake * BigInt(tickets.length);
    const { fee } = splitPot(pot, this.cfg.economy.feeBps);
    const readyDeadline = this.now() + this.cfg.match.acceptMs;
    const mid = await this.db.tx(async () => {
      const id = Number((await this.db.run("INSERT INTO matches (game, stake, pot, fee, state, code, created_at, ready_deadline) VALUES (?, ?, ?, ?, 'found', ?, ?, ?) RETURNING id",
        tickets[0].game, toStr(stake), toStr(pot), toStr(fee), tickets[0].code, this.now(), readyDeadline)).lastInsertRowid);
      for (const [seat, t] of tickets.entries()) {
        await this.db.run("INSERT INTO match_players (match_id, seat, user_id, ticket_id, rating_before) VALUES (?, ?, ?, ?, ?)", id, seat, t.userId, t.id, t.rating);
        const c = (await this.db.run("UPDATE tickets SET state = 'matched', closed_at = ?, match_id = ? WHERE id = ? AND state = 'queued'", this.now(), id, t.id)).changes;
        if (!c) throw new Error(`ticket ${t.id} was not queued`);
        if (stake > 0n) await this.ledger.transfer(ACCT.ticket(t.id), ACCT.match(id), stake, { kind: "stake-lock", ref: id, uniq: `ticket-lock:${t.id}` });
      }
      return id;
    });
    for (const t of tickets) {
      this.tickets.delete(t.id);
      this.#disarm(`expire:${t.id}`);
      this.busy.set(t.userId, { kind: "match", id: mid });
    }
    this.#arm(`ready:${mid}`, this.cfg.match.acceptMs, () => this.#readyTimeout(mid));
    this.log.info("match found", { matchId: mid, game: tickets[0].game, stake: toStr(stake), players: tickets.map((t) => t.userId) });
    for (const t of tickets) {
      this.hub.notify(t.userId, { type: "match.found", match: await this.matchView(mid, t.userId) });
    }
    return mid;
  }

  /* ------------------------------------------------------------ ready → start */

  ready(userId, matchId, connId = null) {
    return this.#op(async () => {
      const m = await this.#matchFor(userId, matchId);
      const seat = await this.#seat(m, userId);
      if (m.state === "found") {
        if (this.now() > m.ready_deadline) throw conflict("READY_EXPIRED", "The time to accept this match has passed.");
        await this.db.run("UPDATE match_players SET ready_at = COALESCE(ready_at, ?) WHERE match_id = ? AND seat = ?", this.now(), m.id, seat);
        this.readyConn.set(`${m.id}:${seat}`, connId);
        const ps = await this.#players(m.id);
        this.#tellOthers(ps, seat, { type: "match.opponent_ready", matchId: m.id, seat });
        if (ps.every((p) => p.ready_at != null)) await this.#start(m.id);
        return { matchId: m.id, state: (await this.db.get("SELECT state FROM matches WHERE id = ?", m.id)).state };
      }
      if (m.state === "playing" && this.tables.has(m.id)) {
        // a table game has no secret seed: any tab may (re)join and gets the table as it is now
        const t = this.tables.get(m.id);
        if (connId != null) {
          this.hub.notify(userId, this.#startMessage(m, false), { conn: connId });
          this.hub.notify(userId, this.#tableMessage(m.id, t, seat), { conn: connId });
        }
        return { matchId: m.id, state: "playing", delivered: true };
      }
      if (m.state === "playing") {
        // a player whose seed never reached a socket may ask once more, as long as the game is still running
        const p = (await this.#players(m.id))[seat];
        if (p.forfeited) throw conflict("FORFEITED", "You forfeited this match.");
        if (p.seed_sent) throw conflict("SEED_ALREADY_SENT", "The challenge was already delivered to you and cannot be sent again.");
        if (this.now() > m.submit_deadline) throw conflict("MATCH_OVER", "This match is over.");
        const delivered = await this.#deliverSeed(m, userId, seat, connId);
        return { matchId: m.id, state: "playing", delivered };
      }
      throw conflict("MATCH_OVER", "This match is over.");
    });
  }

  #startMessage(m, withSeed) {
    const table = !!(this.catalog.get(m.game) || {}).table;
    return { type: "match.start", matchId: m.id, game: m.game, startAt: m.start_at, submitDeadline: m.submit_deadline, serverNow: this.now(), seed: withSeed && !table ? m.seed : null, ...(table ? { table: true } : {}) };
  }

  async #start(matchId) {
    const g = this.catalog.get((await this.db.get("SELECT game FROM matches WHERE id = ?", matchId)).game);
    if (g.table) return this.#startTable(matchId, g);
    const seed = crypto.randomInt(100000, 1_000_000_000);
    const startAt = this.now() + this.cfg.match.countdownMs;
    const window = Math.round(g.maxMs * this.cfg.match.durationScale * this.cfg.match.durationFactor);
    const deadline = startAt + window + this.cfg.match.graceMs;
    const started = (await this.db.run("UPDATE matches SET state = 'playing', seed = ?, start_at = ?, submit_deadline = ? WHERE id = ? AND state = 'found'", seed, startAt, deadline, matchId)).changes;
    if (!started) return;
    this.#disarm(`ready:${matchId}`);
    this.#arm(`deadline:${matchId}`, deadline - this.now(), () => this.#deadline(matchId));
    const m = await this.db.get("SELECT * FROM matches WHERE id = ?", matchId);
    this.log.info("match started", { matchId, game: m.game, startAt, deadline });
    for (const p of await this.#players(matchId)) {
      const preferred = this.readyConn.get(`${matchId}:${p.seat}`);
      this.readyConn.delete(`${matchId}:${p.seat}`);
      await this.#deliverSeed(m, p.user_id, p.seat, preferred);
    }
  }

  /* The seed goes to exactly ONE socket per player — the one that said ready, or else any open one — and is never
     re-sent once delivered. This stops a second tab from previewing a puzzle and a reload from replaying it.
     Every other socket of the same player hears that the match started, without the seed. */
  async #deliverSeed(m, userId, seat, preferred) {
    const conns = this.hub.connections(userId);
    const conn = conns.includes(preferred) ? preferred : conns[0];
    if (conn == null) return false; // nobody connected: seed_sent stays 0, the player may ask again via ready()
    if (!this.hub.notify(userId, this.#startMessage(m, true), { conn })) return false;
    await this.db.run("UPDATE match_players SET seed_sent = 1 WHERE match_id = ? AND seat = ?", m.id, seat);
    if (conns.length > 1) this.hub.notify(userId, this.#startMessage(m, false), { except: conn });
    return true;
  }

  /* ------------------------------------------------------------ table games (src/tables) */

  /* everyone is ready: the server sets up the table (colours, the first deal) and plays it out from here */
  async #startTable(matchId, g) {
    const ps = await this.#players(matchId);
    const startAt = this.now() + this.cfg.match.countdownMs;
    const engine = g.table.engine;
    const state = engine.create({ n: ps.length, now: startAt, randInt: crypto.randomInt, opts: (this.cfg.tables || {})[g.table.optsKey] || {} });
    state.savedAt = this.now();
    const deadline = startAt + g.maxMs + this.cfg.match.graceMs;
    const started = (await this.db.run("UPDATE matches SET state = 'playing', start_at = ?, submit_deadline = ?, table_state = ? WHERE id = ? AND state = 'found'",
      startAt, deadline, JSON.stringify(state), matchId)).changes;
    if (!started) return;
    this.#disarm(`ready:${matchId}`);
    const t = { g, engine, state, seats: ps.map((p) => p.user_id), startAt, left: new Set() }; // left: seats that forfeited
    this.tables.set(matchId, t);
    this.#arm(`deadline:${matchId}`, deadline - this.now(), () => this.#deadline(matchId));
    this.#armTable(matchId, t);
    const m = await this.db.get("SELECT * FROM matches WHERE id = ?", matchId);
    this.log.info("table started", { matchId, game: m.game, players: ps.length, startAt });
    for (const p of ps) {
      this.readyConn.delete(`${matchId}:${p.seat}`);
      this.hub.notify(p.user_id, this.#startMessage(m, false));
      this.hub.notify(p.user_id, this.#tableMessage(matchId, t, p.seat));
    }
  }

  #tableMessage(matchId, t, seat) {
    return { type: "match.table", matchId, serverNow: this.now(), table: t.engine.view(t.state, seat, this.now()) };
  }

  /* the table's own clock: the next timeout or the next hand */
  #armTable(matchId, t) {
    const at = t.engine.deadline(t.state);
    if (at == null) return this.#disarm(`table:${matchId}`);
    this.#arm(`table:${matchId}`, Math.max(0, at - this.now()) + 5, async () => {
      const cur = this.tables.get(matchId);
      if (!cur) return;
      cur.engine.onTimer(cur.state, this.now());
      await this.#tableChanged(matchId, cur);
    });
  }

  /* after every change: store the state, then either settle (the game is over) or tell every seat and re-arm the clock */
  async #tableChanged(matchId, t) {
    t.state.savedAt = this.now();
    await this.db.run("UPDATE matches SET table_state = ? WHERE id = ? AND state = 'playing'", JSON.stringify(t.state), matchId);
    const r = t.engine.result(t.state);
    if (r) return this.#finishTable(matchId, t, r);
    this.#armTable(matchId, t);
    for (const [seat, userId] of t.seats.entries()) this.hub.notify(userId, this.#tableMessage(matchId, t, seat));
  }

  /* the game is decided: its result becomes each player's score, and the usual settlement moves the money */
  async #finishTable(matchId, t, r) {
    this.tables.delete(matchId);
    this.#disarm(`table:${matchId}`);
    const now = this.now();
    for (const p of await this.#players(matchId)) {
      if (!p.forfeited) await this.db.run("UPDATE match_players SET score = ?, submitted_at = ? WHERE match_id = ? AND seat = ?", r.scores[p.seat], now, matchId, p.seat);
    }
    await this.#settle(matchId, r.reason);
  }

  /* a move, a bet, a draw offer… The engine checks it against the rules; nothing else is trusted from the client. */
  act(userId, matchId, action) {
    return this.#op(async () => {
      const id = Number(matchId);
      const t = Number.isSafeInteger(id) ? this.tables.get(id) : null;
      if (!t) {
        await this.#matchFor(userId, matchId); // not yours → 404, yours but over → 409
        throw conflict("MATCH_NOT_PLAYING", "This match is not being played.");
      }
      const seat = t.seats.indexOf(userId);
      if (seat < 0) throw notFound("No such match.");
      if (this.now() < t.startAt) throw conflict("TOO_EARLY", "The match has not started yet.");
      if (!action || typeof action !== "object" || typeof action.type !== "string") throw bad("BAD_ACTION", "Say what you want to do.");
      if (t.left.has(seat)) throw conflict("FORFEITED", "You left this match.");
      t.engine.act(t.state, seat, action, this.now());
      await this.#tableChanged(id, t);
      return { matchId: id, ok: true };
    });
  }

  /* ------------------------------------------------------------ playing */

  /* live score for the other players' race bars. Display only; never used for settlement, so no lock. */
  async progress(userId, matchId, score) {
    if (this.tables.has(Number(matchId))) return;
    const m = await this.#matchFor(userId, matchId);
    if (m.state !== "playing" || this.now() < m.start_at || !Number.isFinite(score)) return;
    const seat = await this.#seat(m, userId);
    const key = `${m.id}:${seat}`;
    const last = this.progressAt.get(key) || 0;
    if (this.now() - last < PROGRESS_MIN_GAP_MS) return;
    this.progressAt.set(key, this.now());
    const ps = await this.#players(m.id);
    if (ps[seat].forfeited) return;
    this.#tellOthers(ps, seat, { type: "match.opponent_progress", matchId: m.id, seat, score });
  }

  submit(userId, matchId, { score, detail } = {}) {
    return this.#op(async () => {
      const m = await this.#matchFor(userId, matchId);
      if (m.state !== "playing") throw conflict("MATCH_NOT_PLAYING", "This match is not being played.");
      if (this.tables.has(m.id)) throw conflict("TABLE_GAME", "This game is played move by move; there is no score to send.");
      const seat = await this.#seat(m, userId);
      const now = this.now();
      if (now < m.start_at - 250) throw conflict("TOO_EARLY", "The match has not started yet.");
      if (now > m.submit_deadline) throw conflict("TOO_LATE", "The submission deadline has passed.");
      if (typeof score !== "number" || !Number.isFinite(score) || Math.abs(score) > this.cfg.match.maxScore) throw bad("BAD_SCORE", "score must be a finite number.");
      const text = detail == null ? null : String(detail).slice(0, MAX_DETAIL);

      const own = (await this.#players(m.id))[seat];
      if (own.forfeited) throw conflict("FORFEITED", "You forfeited this match.");
      if (own.score != null) throw conflict("ALREADY_SUBMITTED", "You already submitted a result for this match.");
      await this.db.run("UPDATE match_players SET score = ?, detail = ?, submitted_at = ? WHERE match_id = ? AND seat = ? AND score IS NULL", score, text, now, m.id, seat);
      this.#tellOthers(await this.#players(m.id), seat, { type: "match.opponent_finished", matchId: m.id, seat });
      await this.#settleIfDone(m.id);
      return { matchId: m.id, accepted: true };
    });
  }

  forfeit(userId, matchId) {
    return this.#op(async () => {
      const m = await this.#matchFor(userId, matchId);
      const seat = await this.#seat(m, userId);
      if (m.state === "found") {
        // declining a match you were paired into wastes the other players' time: counts like a no-show, and voids the match for all
        await this.#voidFound(m.id, "declined", [seat]);
        return { matchId: m.id, state: "void" };
      }
      if (m.state !== "playing") throw conflict("MATCH_OVER", "This match is over.");
      if ((await this.#players(m.id))[seat].forfeited) return { matchId: m.id, state: "playing" }; // already out; the match goes on without them
      await this.db.run("UPDATE match_players SET forfeited = 1 WHERE match_id = ? AND seat = ?", m.id, seat);
      const t = this.tables.get(m.id);
      if (t) {
        // a table game: the player leaves the table (chess: resigns; poker: folds and is out), the rest play on
        t.left.add(seat);
        t.engine.forfeit(t.state, seat, this.now());
        await this.#tableChanged(m.id, t);
      } else await this.#settleIfDone(m.id);
      const state = (await this.db.get("SELECT state FROM matches WHERE id = ?", m.id)).state;
      // the match goes on: tell the others who dropped out (when it ended instead, they get match.result)
      if (state === "playing") this.#tellOthers(await this.#players(m.id), seat, { type: "match.opponent_forfeited", matchId: m.id, seat });
      return { matchId: m.id, state };
    });
  }

  /* Settle the moment nothing can change any more: forfeits left at most one player standing, or every player still
     standing has submitted. Otherwise the deadline timer settles it. */
  async #settleIfDone(matchId) {
    const ps = await this.#players(matchId);
    const standing = ps.filter((p) => !p.forfeited);
    if ((standing.length < ps.length && standing.length <= 1) || standing.every((p) => p.score != null)) await this.#settle(matchId);
  }

  /* one event to every player except the one it is about */
  #tellOthers(ps, exceptSeat, msg) {
    for (const p of ps) if (p.seat !== exceptSeat) this.hub.notify(p.user_id, msg);
  }

  async #deadline(matchId) {
    const t = this.tables.get(matchId);
    if (t) { // the hard cap on a table game: it is decided as it stands
      t.engine.finishNow(t.state);
      return this.#tableChanged(matchId, t);
    }
    return this.#settle(matchId);
  }

  async #readyTimeout(matchId) {
    const late = (await this.#players(matchId)).filter((p) => p.ready_at == null).map((p) => p.seat);
    await this.#voidFound(matchId, "no_show", late);
  }

  /* found → void: refund everyone, strike whoever did not show up */
  async #voidFound(matchId, reason, strikeSeats) {
    const done = await this.db.tx(async () => {
      const c = (await this.db.run("UPDATE matches SET state = 'void', outcome = 'void', reason = ?, settled_at = ? WHERE id = ? AND state = 'found'", reason, this.now(), matchId)).changes;
      if (!c) return false;
      await this.#refund(matchId);
      const ps = await this.#players(matchId);
      for (const p of ps) await this.db.run("UPDATE match_players SET rating_after = rating_before WHERE match_id = ? AND seat = ?", matchId, p.seat);
      for (const seat of strikeSeats) await this.#strike(ps[seat].user_id);
      return true;
    });
    if (!done) return;
    this.#disarm(`ready:${matchId}`);
    await this.#finish(matchId);
    this.log.info("match voided before start", { matchId, reason });
  }

  async #strike(userId) {
    const u = await this.users.byId(userId);
    const m = this.cfg.match;
    const strikes = (this.now() - u.last_strike_at > m.strikeDecayMs ? 0 : u.strikes) + 1;
    if (strikes >= m.strikesBeforeBan) {
      await this.db.run("UPDATE users SET strikes = 0, last_strike_at = ?, queue_ban_until = ? WHERE id = ?", this.now(), this.now() + m.banMs, userId);
    } else {
      await this.db.run("UPDATE users SET strikes = ?, last_strike_at = ? WHERE id = ?", strikes, this.now(), userId);
    }
  }

  /* ------------------------------------------------------------ settlement */

  /* everybody's stake back out of the match escrow */
  async #refund(matchId) {
    const m = await this.db.get("SELECT * FROM matches WHERE id = ?", matchId);
    const stake = big(m.stake);
    if (stake === 0n) return;
    const ps = await this.#players(matchId);
    await this.ledger.post({
      kind: "match-refund", ref: matchId, uniq: `match-refund:${matchId}`,
      entries: [[ACCT.match(matchId), -(stake * BigInt(ps.length))], ...ps.map((p) => [ACCT.user(p.user_id), stake])],
    });
  }

  /* Decide the result (standings.js), move the money, rate the players: one transaction, compare-and-set on the state.
     Money: a win pays the winners an equal share each of pot − fee (integer division); the fee and the wei that did not
     divide go to the house, so the entries always sum to zero. A draw or a void match refunds every stake, no fee. */
  async #settle(matchId, tableReason = null) {
    const settled = await this.db.tx(async () => {
      const m = await this.db.get("SELECT * FROM matches WHERE id = ? FOR UPDATE", matchId);
      if (!m || m.state !== "playing") return false; // somebody else already settled it
      const ps = await this.#players(matchId);
      const stake = big(m.stake), pot = big(m.pot);
      const decided = decide(ps);
      const { outcome, winners } = decided;
      // a table game says why it ended (checkmate, last player with chips…); a forfeit that leaves one player stays "forfeit"
      const why = tableReason && decided.why !== "forfeit" && outcome !== "void" ? tableReason : decided.why;
      const isTable = !!(this.catalog.get(m.game) || {}).table;
      const won = new Set(winners);

      // ---- money
      const share = outcome === "win" ? splitPot(pot, this.cfg.economy.feeBps).payout / BigInt(winners.length) : 0n;
      const houseTake = outcome === "win" ? pot - share * BigInt(winners.length) : 0n; // fee + remainder
      if (outcome !== "win") await this.#refund(matchId);
      else if (stake > 0n) {
        const entries = [[ACCT.match(matchId), -pot], ...winners.map((seat) => [ACCT.user(ps[seat].user_id), share])];
        if (houseTake > 0n) entries.push([ACCT.house, houseTake]);
        await this.ledger.post({ kind: "match-settle", ref: matchId, uniq: `match-settle:${matchId}`, entries });
      }

      // ---- ratings (a void match changes nobody's rating)
      const before = ps.map((p) => p.rating_before);
      let after = before;
      if (outcome !== "void") {
        const d = pairwiseDeltas(before, standings(ps, why));
        after = before.map((r, i) => r + d[i]);
        for (const [seat, p] of ps.entries()) {
          const result = outcome === "draw" ? "draws" : won.has(seat) ? "wins" : "losses";
          await this.db.run("INSERT INTO ratings (user_id, game, rating, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT (user_id, game) DO NOTHING", p.user_id, m.game, START_RATING, this.now());
          await this.db.run(`UPDATE ratings SET rating = ?, ${result} = ${result} + 1,
                               best = CASE WHEN CAST(? AS DOUBLE PRECISION) IS NULL THEN best
                                           WHEN best IS NULL OR CAST(? AS DOUBLE PRECISION) > best THEN CAST(? AS DOUBLE PRECISION) ELSE best END,
                               updated_at = ?
                             WHERE user_id = ? AND game = ?`, after[seat], ...Array(3).fill(isTable ? null : p.score), this.now(), p.user_id, m.game);
        }
      }

      // ---- per-player result + daily net for the loss limit
      for (const [seat, p] of ps.entries()) {
        const got = outcome === "win" ? (won.has(seat) ? share : 0n) : stake; // draw/void: own stake back
        await this.db.run("UPDATE match_players SET rating_after = ?, payout = ? WHERE match_id = ? AND seat = ?", after[seat], toStr(stake > 0n ? got : 0n), matchId, seat);
        if (stake > 0n && outcome !== "void") await this.responsible.recordNet(p.user_id, got - stake);
      }

      const state = outcome === "void" ? "void" : "settled";
      await this.db.run("UPDATE matches SET state = ?, outcome = ?, reason = ?, fee = ?, winner_seat = ?, settled_at = ? WHERE id = ?",
        state, outcome, why, toStr(houseTake), winners.length ? winners[0] : null, this.now(), matchId);
      return true;
    });
    if (!settled) return;
    this.#disarm(`deadline:${matchId}`);
    await this.#finish(matchId);
    const m = await this.db.get("SELECT * FROM matches WHERE id = ?", matchId);
    this.log.info("match settled", { matchId, outcome: m.outcome, reason: m.reason, winnerSeat: m.winner_seat });
    this.#scheduleFlagCheck(matchId);
  }

  /* after a match reaches a final state: free the players and tell them */
  async #finish(matchId) {
    for (const p of await this.#players(matchId)) {
      const b = this.busy.get(p.user_id);
      if (b && b.kind === "match" && b.id === matchId) this.busy.delete(p.user_id);
      this.readyConn.delete(`${matchId}:${p.seat}`);
      this.progressAt.delete(`${matchId}:${p.seat}`);
      const v = await this.matchView(matchId, p.user_id, { table: true });
      this.hub.notify(p.user_id, { type: v.state === "void" ? "match.void" : "match.result", match: v });
      this.hub.notify(p.user_id, { type: "wallet.updated", reason: "match-settled", matchId });
    }
  }

  /* advisory: flag a score that is far beyond the strongest bot on the same seed. Off the hot path, outside the lock. */
  #scheduleFlagCheck(matchId) {
    const p = this.db.detach(() => new Promise((resolve) => setImmediate(async () => {
      try {
        const m = await this.db.get("SELECT * FROM matches WHERE id = ?", matchId);
        const g = m && this.catalog.get(m.game);
        if (!g || m.seed == null) return;
        for (const p of await this.#players(matchId)) {
          if (p.score == null) continue;
          const why = this.catalog.plausibility(g, m.seed, p.score);
          if (why) {
            await this.db.run("UPDATE match_players SET flag = ? WHERE match_id = ? AND seat = ?", why, matchId, p.seat);
            this.log.warn("implausible score flagged for review", { matchId, userId: p.user_id, reason: why });
          }
        }
      } catch (e) { this.log.error("flag check failed", { matchId, error: e }); }
      finally { resolve(); }
    })));
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

  /* ------------------------------------------------------------ reads */

  #players(matchId) {
    return this.db.all(
      `SELECT mp.*, u.display_name, u.address FROM match_players mp JOIN users u ON u.id = mp.user_id
        WHERE mp.match_id = ? ORDER BY mp.seat`, matchId);
  }

  async #matchFor(userId, matchId) {
    const id = Number(matchId);
    const m = Number.isSafeInteger(id) && id > 0 ? await this.db.get("SELECT * FROM matches WHERE id = ?", id) : null;
    if (!m || !(await this.db.get("SELECT 1 AS x FROM match_players WHERE match_id = ? AND user_id = ?", id, userId))) throw notFound("No such match.");
    return m;
  }
  async #seat(m, userId) {
    return (await this.db.get("SELECT seat FROM match_players WHERE match_id = ? AND user_id = ?", m.id, userId)).seat;
  }

  /* One match as seen by one of its players. `opponent` is kept for 1v1 clients (the first other player by seat);
     `players` lists everybody by seat. Scores of the others, ratingAfter, payout and place are revealed once the match is over. */
  async matchView(matchId, viewerId, { table = false } = {}) {
    const m = await this.db.get("SELECT * FROM matches WHERE id = ?", matchId);
    const ps = await this.#players(matchId);
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
      game: { id: m.game, name: g ? g.name : m.game, scoreLabel: g ? g.scoreLabel : "score", maxSeconds: g ? Math.round(g.maxMs / 1000) : null, kind: g ? g.kind : "race" },
      ...(table && g && g.table ? { table: this.#tableView(m, me.seat) } : {}),
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

  /* a table game as one seat sees it: live from memory while it is played, from the stored state afterwards (null before) */
  #tableView(m, seat) {
    const live = this.tables.get(m.id);
    if (live) return live.engine.view(live.state, seat, this.now());
    if (!m.table_state) return null;
    const g = this.catalog.get(m.game);
    return g.table.engine.view(JSON.parse(m.table_state), seat, this.now());
  }

  /* what a (re)connecting client needs to pick up where it left off. Never contains a seed. */
  async sync(userId) {
    const b = this.busy.get(userId);
    if (!b) return { active: null };
    if (b.kind === "lobby") {
      const row = await this.#ticketRow(b.id);
      return { active: row ? { kind: "lobby", lobby: await this.#lobbyView(row, userId) } : null };
    }
    return { active: { kind: "match", match: await this.matchView(b.id, userId, { table: true }) } };
  }

  active(userId) { return this.busy.get(userId) || null; }

  /* the stake this player currently has in escrow (their ticket in an open lobby, or an unfinished match) */
  async stakeAtRisk(userId) {
    const b = this.busy.get(userId);
    if (!b) return 0n;
    if (b.kind === "lobby") { const t = this.tickets.get(b.ticketId ?? b.id); return t ? t.stake : 0n; }
    const m = await this.db.get("SELECT stake FROM matches WHERE id = ?", b.id);
    return m ? big(m.stake) : 0n;
  }

  async history(userId, { limit = 20, before = null } = {}) {
    const rows = await this.db.all(
      `SELECT m.id FROM matches m JOIN match_players mp ON mp.match_id = m.id
        WHERE mp.user_id = ? AND m.state IN ('settled','void') ${before ? "AND m.id < ?" : ""}
        ORDER BY m.id DESC LIMIT ?`, ...(before ? [userId, before, limit] : [userId, limit]));
    const out = [];
    for (const r of rows) out.push(await this.matchView(r.id, userId));
    return out;
  }

  async get(userId, matchId) {
    const m = await this.#matchFor(userId, matchId);
    return this.matchView(m.id, userId, { table: true });
  }
}
