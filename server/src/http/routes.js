/* REST API, version 1. Amounts are always decimal strings of wei. Timestamps are epoch milliseconds. */
import { bad, notFound } from "../util/errors.js";
import { parseWei, toStr } from "../util/amounts.js";
import { checksum } from "../util/address.js";
import { ACCT } from "../ledger.js";

const intParam = (v, d, min, max) => {
  if (v == null || v === "") return d;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw bad("BAD_PARAM", `Expected an integer between ${min} and ${max}.`);
  return n;
};

export function registerRoutes(r, app) {
  const { cfg, auth, users, responsible, wallet, matches, catalog, ledger } = app;

  /* the caller's own profile; used by /me and by the WebSocket after sign-in */
  const meView = (u) => {
    return {
      id: u.id, address: checksum(u.address), displayName: u.display_name, createdAt: u.created_at,
      balances: { ...wallet.balances(u.id), inPlay: toStr(matches.stakeAtRisk(u.id)) },
      responsible: responsible.view(u.id),
      queueBanUntil: u.queue_ban_until > Date.now() ? u.queue_ban_until : null,
      ratings: matches.ratingsFor(u.id),
      ...matches.sync(u.id),
    };
  };
  app.meView = meView;

  /* ---------------------------------------------------------------- public */

  r.get("/v1/health", {}, () => ({
    ok: true, time: Date.now(), wallet: wallet.status(), games: catalog.list().length,
  }));

  r.get("/v1/config", {}, () => ({
    chain: wallet.chainInfo(),
    feeBps: cfg.economy.feeBps,
    stake: { min: toStr(cfg.economy.minStake), max: toStr(cfg.economy.maxStake), tiers: cfg.economy.stakeTiers.map(toStr) },
    withdrawal: { min: toStr(cfg.economy.minWithdrawal), max: toStr(cfg.economy.maxWithdrawal), dailyCap: toStr(cfg.economy.dailyWithdrawalCap) },
    match: { acceptMs: cfg.match.acceptMs, countdownMs: cfg.match.countdownMs, queueTimeoutMs: cfg.match.queueTimeoutMs, lobbyTtlMs: cfg.match.lobbyTtlMs, lobbyMaxPlayers: cfg.match.lobbyMaxPlayers, publicQueue: cfg.match.publicQueue },
    websocket: "/v1/ws",
    notice: "Test network only. Funds have no real-world value.",
    ...(cfg.devFaucet ? { devFaucet: true } : {}),
  }));

  r.get("/v1/games", {}, () => ({ games: catalog.list() }));

  r.get("/v1/leaderboard", {}, ({ query }) => {
    const g = catalog.get(query.game);
    if (!g) throw bad("UNKNOWN_GAME", "Pass ?game=<id>.");
    return { game: g.id, players: matches.leaderboard(g.id, intParam(query.limit, 20, 1, 100)) };
  });

  /* live activity for the lobby: anonymous aggregates only, see MatchService.lobby(); `online` = distinct signed-in players with an open socket */
  r.get("/v1/lobby", {}, () => matches.lobby(app.gateway ? app.gateway.onlineCount() : 0));

  /* ---------------------------------------------------------------- auth */

  r.post("/v1/auth/nonce", { limit: "auth" }, ({ body }) => {
    const n = auth.issueNonce(body.address);
    return { nonce: n.nonce, message: n.message, expiresAt: n.expiresAt };
  });

  r.post("/v1/auth/login", { limit: "auth" }, ({ body, ip }) => {
    const s = auth.login({ address: body.address, nonce: body.nonce, signature: body.signature, ip });
    return { token: s.token, expiresAt: s.expiresAt, created: s.created, me: meView(s.user) };
  });

  r.post("/v1/auth/logout", { auth: true }, ({ token }) => { auth.logout(token); return { ok: true }; });

  /* ---------------------------------------------------------------- profile + responsible play */

  r.get("/v1/me", { auth: true }, ({ user }) => meView(user));

  r.patch("/v1/me", { auth: true }, ({ user, body }) => ({ displayName: users.setDisplayName(user.id, body.displayName) }));

  r.put("/v1/me/loss-limit", { auth: true }, ({ user, body }) => {
    const value = body.amount === null ? null : parseWei(body.amount, "amount");
    const out = responsible.setLossLimit(user.id, value);
    return { ...out, responsible: responsible.view(user.id) };
  });

  /* ---------------------------------------------------------------- wallet */

  r.get("/v1/wallet", { auth: true }, ({ user }) => {
    wallet.require();
    return {
      chain: wallet.chainInfo(),
      depositAddress: checksum(wallet.depositAddress(user.id)),
      withdrawTo: checksum(user.address),
      balances: wallet.balances(user.id),
      limits: { min: toStr(cfg.economy.minWithdrawal), max: toStr(cfg.economy.maxWithdrawal), dailyCap: toStr(cfg.economy.dailyWithdrawalCap) },
      note: "Send test funds from a normal wallet (not a smart-contract wallet). Deposits are credited after the confirmations shown above.",
    };
  });

  r.get("/v1/wallet/history", { auth: true }, ({ user, query }) => ({
    entries: ledger.statement(ACCT.user(user.id), { limit: intParam(query.limit, 50, 1, 200), before: query.before ? intParam(query.before, null, 1, Number.MAX_SAFE_INTEGER) : null }),
  }));

  r.get("/v1/wallet/deposits", { auth: true }, ({ user }) => {
    wallet.require();
    const explorer = wallet.chain.meta.explorer;
    return {
      deposits: app.db.all("SELECT tx_hash, amount, block_number, credited_at FROM deposits WHERE user_id = ? ORDER BY credited_at DESC LIMIT 50", user.id)
        .map((d) => ({ txHash: d.tx_hash, amount: d.amount, blockNumber: d.block_number, creditedAt: d.credited_at, explorerUrl: explorer ? `${explorer}/tx/${d.tx_hash}` : null })),
    };
  });

  r.get("/v1/wallet/withdrawals", { auth: true }, ({ user }) => {
    wallet.require();
    return { withdrawals: wallet.withdrawals.list(user.id) };
  });

  r.post("/v1/wallet/withdraw", { auth: true }, ({ user, body, req }) => {
    wallet.require();
    const amount = parseWei(body.amount, "amount");
    const out = wallet.withdrawals.request({ userId: user.id, to: user.address, amount, idemKey: req.headers["idempotency-key"] || null });
    return { status: out.replay ? 200 : 201, body: out };
  });

  /* ---------------------------------------------------------------- play */

  r.get("/v1/matches", { auth: true }, ({ user, query }) => ({
    matches: matches.history(user.id, { limit: intParam(query.limit, 20, 1, 100), before: query.before ? intParam(query.before, null, 1, Number.MAX_SAFE_INTEGER) : null }),
  }));

  r.get("/v1/matches/:id", { auth: true }, ({ user, params }) => matches.get(user.id, params.id));

  r.post("/v1/queue", { auth: true }, ({ user, body }) => ({ status: 201, body: matches.join(user.id, body) }));
  r.delete("/v1/queue", { auth: true }, ({ user }) => matches.leave(user.id));

  /* invite-only lobbies (up to cfg.match.lobbyMaxPlayers). GET is public (rate-limited per IP by the API limiter) and returns the
     public view only; every authenticated call answers with the caller's own member view.
       join   → { lobby } (or { lobby, match } when this join filled the lobby and it auto-started)
       leave  → { lobby }  guests only, stake refunded
       start  → { match }  host only, needs at least 2 players
       DELETE → { lobby }  host only, refunds every member */
  r.post("/v1/lobbies", { auth: true }, ({ user, body }) => ({ status: 201, body: { lobby: matches.createLobby(user.id, body) } }));
  r.get("/v1/lobbies/:code", {}, ({ params }) => ({ lobby: matches.getLobby(params.code) }));
  r.post("/v1/lobbies/:code/join", { auth: true }, ({ user, params }) => matches.joinLobby(user.id, params.code));
  r.post("/v1/lobbies/:code/leave", { auth: true }, ({ user, params }) => ({ lobby: matches.leaveLobby(user.id, params.code) }));
  r.post("/v1/lobbies/:code/start", { auth: true }, ({ user, params }) => ({ match: matches.startLobby(user.id, params.code) }));
  r.delete("/v1/lobbies/:code", { auth: true }, ({ user, params }) => ({ lobby: matches.closeLobby(user.id, params.code) }));

  r.post("/v1/matches/:id/ready", { auth: true }, ({ user, params }) => matches.ready(user.id, params.id, null));
  r.post("/v1/matches/:id/submit", { auth: true }, ({ user, params, body }) => matches.submit(user.id, params.id, body));
  r.post("/v1/matches/:id/forfeit", { auth: true }, ({ user, params }) => matches.forfeit(user.id, params.id));

  /* ---------------------------------------------------------------- operator */

  r.get("/v1/admin/audit", { auth: "admin" }, () => ledger.audit());
  r.get("/v1/admin/solvency", { auth: "admin" }, async () => wallet.solvency());
  r.get("/v1/admin/flags", { auth: "admin" }, () => ({ flagged: matches.flagged(100) }));
  r.get("/v1/admin/users/:id", { auth: "admin" }, ({ params }) => {
    const u = users.byId(Number(params.id));
    if (!u) throw notFound("Unknown player.");
    return { id: u.id, address: checksum(u.address), name: u.display_name, banned: !!u.banned, strikes: u.strikes, balances: wallet.balances(u.id) };
  });
}
