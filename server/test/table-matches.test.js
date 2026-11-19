/* Chess and poker played through the real server: lobby → ready → the server plays the table → settlement. Covers stakes and
   payouts, what each player is allowed to see over the wire, timeouts, resigning, draws, reconnecting and restarts. */
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { DuelClient } from "../client/duel-client.js";
import { startApp, mETH, testDb, freshSchema, closeTestDbs } from "./helpers/app.js";

const apps = [];
const TABLES = {
  chess: { baseMs: 60_000, incMs: 0 },
  poker: { startStack: 200, levelMs: 60_000, actionMs: 5_000, awayActionMs: 50, showdownPauseMs: 20, foldPauseMs: 20 },
};
const boot = async (over = {}) => { const h = await startApp({ tables: TABLES, ...over }); apps.push(h); return h; };
after(async () => { for (const h of apps) await h.close().catch(() => {}); await closeTestDbs(); });

const STAKE = mETH;
const audit = async (h) => assert.deepEqual((await h.app.ledger.audit()).problems, []);
const escrow = async (h) => (await h.app.db.all("SELECT balance FROM accounts WHERE id LIKE 'escrow:%'")).reduce((a, r) => a + BigInt(r.balance), 0n);

/* lobby → everyone ready → started. Returns { id, tables: first match.table event per player } */
async function startTable(h, group, game, stake = STAKE) {
  for (const p of group) if (!p.tables) { p.tables = new Map(); p.client.on("match.table", (e) => p.tables.set(e.matchId, e.table)); }
  const { id, code } = await h.lobbyMatch(group, { game, stake });
  for (const p of group) await p.client.ready(id);
  const starts = await Promise.all(group.map((p) => p.client.waitFor("match.start", (e) => e.matchId === id)));
  for (const s of starts) { assert.equal(s.table, true); assert.equal(s.seed, null, "a table game has no seed"); }
  const tables = await Promise.all(group.map((p) => p.client.waitFor("match.table", (e) => e.matchId === id)));
  const wait = starts[0].startAt - group[0].client.serverNow();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait + 15));
  return { id, code, tables: tables.map((e) => e.table) };
}

/* the latest table this player has heard about for the match */
const latest = (p, id) => p.tables.get(id);
const mv = (p, id, uci) => p.client.act(id, { type: "move", from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });

test("chess: a 2-seat lobby starts when the guest joins; the server checks moves; checkmate pays the winner", async () => {
  const h = await boot();
  const [a, b] = [await h.player({ name: "Ann" }), await h.player({ name: "Bob" })];
  const { id, code, tables } = await startTable(h, [a, b], "chess");
  const lobby = await a.client.getLobby(code);
  assert.equal(lobby.maxPlayers, 2);
  assert.equal(lobby.state, "matched", "the guest's join filled the 2 seats and started it");
  await assert.rejects((await h.player()).client.joinLobby(code), { code: "LOBBY_FULL" });

  const white = tables[0].color === "w" ? a : b, black = white === a ? b : a;
  const tw = tables[white === a ? 0 : 1], tb = tables[white === a ? 1 : 0];
  assert.equal(tw.legal.length, 20);
  assert.deepEqual(tb.legal, [], "black is not to move");
  assert.equal(tb.color, "b");

  await assert.rejects(mv(black, id, "e7e5"), { code: "ILLEGAL_MOVE" });
  await assert.rejects(mv(white, id, "e2e5"), { code: "ILLEGAL_MOVE" });
  await assert.rejects(white.client.submit(id, 1), { code: "TABLE_GAME" });
  await assert.rejects(white.client.act(id, null), { code: "BAD_ACTION" });

  await mv(white, id, "f2f3");
  const seen = await black.client.waitFor("match.table", (e) => e.matchId === id && e.table.plies === 1);
  assert.equal(seen.table.legal.length, 20);
  assert.deepEqual(seen.table.lastMove, { from: "f2", to: "f3" });
  await mv(black, id, "e7e5");
  await mv(white, id, "g2g4");
  await mv(black, id, "d8h4");

  const [rw, rb] = await Promise.all([white.client.waitFor("match.result"), black.client.waitFor("match.result")]);
  assert.equal(rb.match.result, "win");
  assert.equal(rw.match.result, "loss");
  assert.equal(rb.match.reason, "checkmate");
  assert.equal(rb.match.game.kind, "table");
  assert.deepEqual(rb.match.table.result, { winner: rb.match.you.seat, reason: "checkmate" }, "the final board comes with the result");
  assert.deepEqual(rb.match.table.san, ["f3", "e5", "g4", "Qh4#"]);
  const pot = STAKE * 2n, fee = pot / 10n;
  assert.equal(await black.bal(), 100n * mETH + STAKE - fee);
  assert.equal(await white.bal(), 100n * mETH - STAKE);
  assert.equal(await h.house(), fee);
  assert.equal(await escrow(h), 0n);
  const r = await h.app.db.get("SELECT rating, wins, best FROM ratings WHERE user_id = ? AND game = 'chess'", black.id);
  assert.ok(r.rating > 1200);
  assert.equal(r.wins, 1);
  assert.equal(r.best, null, "a table game has no 'best score'");
  await assert.rejects(mv(white, id, "a2a3"), { code: "MATCH_NOT_PLAYING" });
  await audit(h);
});

test("chess: resigning (forfeit) gives the game to the opponent", async () => {
  const h = await boot();
  const [a, b] = [await h.player(), await h.player()];
  const { id } = await startTable(h, [a, b], "chess");
  const out = await a.client.forfeit(id);
  assert.equal(out.state, "settled");
  const r = await b.client.waitFor("match.result");
  assert.equal(r.match.result, "win");
  assert.equal(r.match.reason, "forfeit");
  assert.equal(await b.bal(), 100n * mETH + STAKE - (STAKE * 2n) / 10n);
  await audit(h);
});

test("chess: a draw by agreement returns both stakes, no fee", async () => {
  const h = await boot();
  const [a, b] = [await h.player(), await h.player()];
  const { id } = await startTable(h, [a, b], "chess");
  await a.client.act(id, { type: "draw-offer" });
  const offer = await b.client.waitFor("match.table", (e) => e.matchId === id && e.table.drawOffer != null);
  assert.equal(offer.table.drawOffer, offer.table.you === 0 ? 1 : 0);
  await b.client.act(id, { type: "draw-accept" });
  const r = await a.client.waitFor("match.result");
  assert.equal(r.match.result, "draw");
  assert.equal(r.match.reason, "agreement");
  assert.equal(await a.bal(), 100n * mETH);
  assert.equal(await b.bal(), 100n * mETH);
  assert.equal(await h.house(), 0n);
  await audit(h);
});

test("chess: the server's clock flags a player who does not move", async () => {
  const h = await boot({ tables: { ...TABLES, chess: { baseMs: 400, incMs: 0 } } });
  const [a, b] = [await h.player(), await h.player()];
  const { id, tables } = await startTable(h, [a, b], "chess");
  const whiteIsA = tables[0].color === "w";
  const r = await (whiteIsA ? b : a).client.waitFor("match.result", null, 5000);
  assert.equal(r.match.result, "win", "black wins: white never moved");
  assert.equal(r.match.reason, "timeout");
  await audit(h);
});

test("chess: a reload (sync) and a second tab get the table as it stands", async () => {
  const h = await boot();
  const [a, b] = [await h.player(), await h.player()];
  const { id, tables } = await startTable(h, [a, b], "chess");
  const white = tables[0].color === "w" ? a : b;
  await mv(white, id, "e2e4");
  const me = await white.client.api("GET", "/v1/me");
  assert.equal(me.active.kind, "match");
  assert.equal(me.active.match.table.plies, 1);
  assert.deepEqual(me.active.match.table.lastMove, { from: "e2", to: "e4" });
  // a second tab says ready during play: it gets match.start + the table, nothing is refused
  const tab = new DuelClient({ baseUrl: h.url, address: white.wallet.address, sign: (m) => white.wallet.signMessage(m) });
  await tab.login(); await tab.connect();
  const out = await tab.ready(id);
  assert.equal(out.state, "playing");
  const t = await tab.waitFor("match.table", (e) => e.matchId === id);
  assert.equal(t.table.plies, 1);
  tab.close();
});

test("chess: a game in progress survives a server restart, clocks paused while it was down", async () => {
  const shared = freshSchema();
  const h1 = await startApp({ tables: TABLES, db: testDb(shared, { keep: true }) });
  const [a, b] = [await h1.player(), await h1.player()];
  const { id, tables } = await startTable(h1, [a, b], "chess");
  const whiteIsA = tables[0].color === "w";
  const [wW, bW] = whiteIsA ? [a.wallet, b.wallet] : [b.wallet, a.wallet];
  const [wId, bId] = whiteIsA ? [a.id, b.id] : [b.id, a.id];
  await mv(whiteIsA ? a : b, id, "f2f3");
  const before = latest(whiteIsA ? b : a, id).clocks;
  await h1.close();
  await new Promise((r) => setTimeout(r, 300));

  const h2 = await startApp({ tables: TABLES, db: testDb(shared) });
  apps.push(h2);
  const login = async (w) => { const c = new DuelClient({ baseUrl: h2.url, address: w.address, sign: (m) => w.signMessage(m) }); await c.login(); await c.connect(); return c; };
  const [cw, cb] = [await login(wW), await login(bW)];
  const view = (await cb.api("GET", `/v1/matches/${id}`)).table;
  assert.equal(view.plies, 1);
  const lost = before[view.turn] - view.clocks[view.turn];
  assert.ok(lost < 250, `black's clock barely moved across the restart (${lost} ms)`);
  await cb.act(id, { type: "move", from: "e7", to: "e5" });
  await cw.act(id, { type: "move", from: "g2", to: "g4" });
  await cb.act(id, { type: "move", from: "d8", to: "h4" });
  const r = await cb.waitFor("match.result");
  assert.equal(r.match.result, "win");
  assert.equal(await h2.app.ledger.balance(`user:${bId}`), 100n * mETH + STAKE - (STAKE * 2n) / 10n);
  assert.equal(await h2.app.ledger.balance(`user:${wId}`), 100n * mETH - STAKE);
  assert.deepEqual((await h2.app.ledger.audit()).problems, []);
  cw.close(); cb.close();
});

test("poker: three players; each sees only their own cards; the last player with chips takes the pot", async () => {
  const h = await boot();
  const group = [await h.player(), await h.player(), await h.player()];
  const { id, code, tables } = await startTable(h, group, "poker");
  assert.equal((await group[0].client.getLobby(code)).maxPlayers, 9);
  // privacy: my two cards, nobody else's, and no deck or salt anywhere
  const mine = tables.map((t) => t.players[t.you].cards);
  tables.forEach((t, i) => {
    assert.equal(mine[i].length, 2);
    for (const p of t.players) if (p.seat !== t.you) assert.equal(p.cards, null);
    const wire = JSON.stringify(t);
    for (const [j, cards] of mine.entries()) if (j !== i) for (const c of cards) assert.ok(!wire.includes(`"${c}"`), "another player's card leaked");
    assert.ok(!/"deck"|"salt"/.test(wire.replace(/"reveal":\{[^}]*\}/, "")));
    assert.match(t.commit, /^[0-9a-f]{64}$/);
  });
  // everyone shoves every turn until one player has all the chips
  const bySeat = new Map(tables.map((t, i) => [t.you, group[i]]));
  const deadline = Date.now() + 20_000;
  let res = null;
  while (!res && Date.now() < deadline) {
    const t = latest(group[0], id);
    if (t.toAct != null && t.street !== "done") {
      const p = bySeat.get(t.toAct);
      const L = latest(p, id).legal;
      if (L) await p.client.act(id, L.raise ? { type: "allin" } : L.check ? { type: "check" } : { type: "call" }).catch((e) => { if (!["ILLEGAL_ACTION", "MATCH_NOT_PLAYING"].includes(e.code)) throw e; });
    }
    await new Promise((r) => setTimeout(r, 15));
    res = group[0].client.peek("match.result").find((e) => e.match.id === id) || null;
  }
  assert.ok(res, "the game finished");
  const results = await Promise.all(group.map((p) => p.client.waitFor("match.result")));
  const winners = results.filter((r) => r.match.result === "win");
  assert.equal(winners.length, 1);
  assert.equal(winners[0].match.reason, "last_standing");
  assert.deepEqual(results.map((r) => r.match.you.place).sort(), [1, 2, 3]);
  const w = group[results.indexOf(winners[0])];
  const pot = STAKE * 3n, fee = pot / 10n;
  assert.equal(await w.bal(), 100n * mETH - STAKE + pot - fee);
  for (const p of group) if (p !== w) assert.equal(await p.bal(), 100n * mETH - STAKE);
  assert.equal(await escrow(h), 0n);
  await audit(h);
});

test("poker: a player who stops acting is folded by the clock, and one who leaves is out; the rest play on", async () => {
  const h = await boot({ tables: { ...TABLES, poker: { ...TABLES.poker, actionMs: 150 } } });
  const group = [await h.player(), await h.player(), await h.player()];
  const { id, tables } = await startTable(h, group, "poker");
  const first = tables[0].toAct;
  const idle = group[tables.findIndex((t) => t.you === first)];
  // nobody acts: the clock acts for the player to move
  const ev = await idle.client.waitFor("match.table", (e) => e.matchId === id && e.table.players[first].action && /time/.test(e.table.players[first].action), 3000);
  assert.ok(ev);
  // one player leaves: they are out at once, the match goes on for the other two
  const leaver = group.find((p) => p !== idle);
  const out = await leaver.client.forfeit(id);
  assert.equal(out.state, "playing");
  const seen = await idle.client.waitFor("match.opponent_forfeited", (e) => e.matchId === id);
  assert.ok(seen);
  const t = await idle.client.waitFor("match.table", (e) => e.matchId === id && e.table.players.some((p) => p.out));
  assert.equal(t.table.players.filter((p) => p.out).length, 1);
  await assert.rejects(leaver.client.act(id, { type: "fold" }), { code: "FORFEITED" });
  // the two left play it out by the clock alone (folding/checking), or one leaves too
  await group.find((p) => p !== idle && p !== leaver).client.forfeit(id);
  const r = await idle.client.waitFor("match.result", null, 5000);
  assert.equal(r.match.result, "win");
  assert.equal(await idle.bal(), 100n * mETH - STAKE + STAKE * 3n - (STAKE * 3n) / 10n);
  await audit(h);
});

test("poker: free tables work, and the games list shows both table games for 2-player and group play", async () => {
  const h = await boot();
  const list = (await (await fetch(`${h.url}/v1/games`)).json()).games;
  const chess = list.find((g) => g.id === "chess"), poker = list.find((g) => g.id === "poker");
  assert.deepEqual([chess.kind, chess.pvp, chess.maxPlayers, chess.pack], ["table", true, 2, ""]);
  assert.deepEqual([poker.kind, poker.pvp, poker.minPlayers, poker.maxPlayers], ["table", true, 2, 9]);
  const [a, b] = [await h.player(), await h.player()];
  const { id } = await startTable(h, [a, b], "poker", 0n);
  await a.client.forfeit(id);
  const r = await b.client.waitFor("match.result");
  assert.equal(r.match.result, "win");
  assert.equal(await b.bal(), 100n * mETH);
});
