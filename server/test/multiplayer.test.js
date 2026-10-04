/* Matches with 3 to 10 players (invite lobbies): seats, events, settlement (winner, split, draw, forfeit, timeout, void),
   pairwise Elo, and the ledger after every one of them. Expected amounts and ratings are written out by hand. */
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { startApp, mETH, sleep } from "./helpers/app.js";
import { ACCT } from "../src/ledger.js";

const apps = [];
const boot = async (over) => { const h = await startApp(over); apps.push(h); return h; };
after(async () => { for (const h of apps) await h.close().catch(() => {}); });

const STAKE = mETH; // 1_000_000_000_000_000
const START = 100n * mETH;
const GAME = "reaction";
const nm = (i) => `Player ${i}`;
const crew = async (h, n, opts = {}) => { const g = []; for (let i = 0; i < n; i++) g.push(await h.player({ name: nm(i), ...opts })); return g; };
const audit = (h) => assert.deepEqual(h.app.ledger.audit().problems, []);
/* nothing is created or lost: what the players hold plus the house is what they started with, and no escrow is left */
const conserved = (h, ps, each = START) => {
  assert.equal(ps.reduce((a, p) => a + p.bal(), 0n) + h.house(), each * BigInt(ps.length));
  const left = h.app.db.all("SELECT id, balance FROM accounts WHERE id LIKE 'escrow:%' AND balance != '0'");
  assert.deepEqual(left, [], "no money left in any escrow");
  audit(h);
};
const results = (ps, type = "match.result") => Promise.all(ps.map((p) => p.client.waitFor(type, null, 6000)));
const rating = (h, p) => h.app.db.get("SELECT rating, wins, losses, draws FROM ratings WHERE user_id = ? AND game = ?", p.id, GAME);
const record = (h, p) => { const r = rating(h, p); return r && [r.rating, r.wins, r.losses, r.draws]; };
const net = (h, p) => h.app.db.get("SELECT net FROM player_day WHERE user_id = ?", p.id)?.net ?? null;
const submitAll = (h, id, ps, scores) => Promise.all(ps.map((p, i) => (scores[i] == null ? null : p.client.submit(id, scores[i]))));
const seedRating = (h, p, r) => h.app.db.run("INSERT INTO ratings (user_id, game, rating, updated_at) VALUES (?, ?, ?, ?)", p.id, GAME, r, Date.now());

/* ------------------------------------------------------------------ settlement */

test("3 players: the highest score takes the whole payout, ratings follow pairwise Elo, every seat's numbers are right", async () => {
  const h = await boot();
  const g = await crew(h, 3);
  const m = await h.lobbyMatch(g);
  assert.equal(m.match.pot, "3000000000000000");
  assert.equal(m.match.winnerPayout, "2700000000000000");
  assert.equal(h.app.ledger.balance(ACCT.match(m.id)), 3n * STAKE);
  await h.beginAll(g, m.id);

  // who hears what: every player gets the seat of each other player, nobody gets their own
  for (const [k, p] of g.entries()) {
    const readySeats = p.client.peek("match.opponent_ready").map((e) => e.seat).sort();
    assert.deepEqual(readySeats, [0, 1, 2].filter((s) => s !== k), `player ${k} was told about every other player's ready`);
    assert.ok(p.client.peek("match.opponent_ready").every((e) => e.matchId === m.id));
  }
  await sleep(250); // progress is rate limited per player
  g[1].client.progress(m.id, 321);
  for (const k of [0, 2]) {
    const ev = await g[k].client.waitFor("match.opponent_progress");
    assert.deepEqual({ matchId: ev.matchId, seat: ev.seat, score: ev.score }, { matchId: m.id, seat: 1, score: 321 });
  }
  await sleep(50);
  assert.equal(g[1].client.peek("match.opponent_progress").length, 0, "no echo to the sender");

  await g[0].client.submit(m.id, 900);
  for (const k of [1, 2]) assert.deepEqual((({ type, ...e }) => e)(await g[k].client.waitFor("match.opponent_finished")), { matchId: m.id, seat: 0 });
  assert.equal(g[0].client.peek("match.opponent_finished").length, 0);

  // mid-match view: others' scores stay hidden, your own is visible, nothing final leaks
  const mid = await g[1].client.api("GET", `/v1/matches/${m.id}`);
  assert.equal(mid.state, "playing");
  assert.equal(mid.result, null);
  assert.deepEqual(mid.players.map((p) => [p.seat, p.you, p.finished, p.score, p.place, p.payout, p.ratingAfter]),
    [[0, false, true, null, null, null, null], [1, true, false, null, null, null, null], [2, false, false, null, null, null, null]]);
  assert.equal(mid.you.place, undefined);

  await g[1].client.submit(m.id, 500);
  await g[2].client.submit(m.id, 100);
  const [r0, r1, r2] = await results(g);

  assert.deepEqual([r0.match.result, r1.match.result, r2.match.result], ["win", "loss", "loss"]);
  assert.equal(r0.match.reason, "scores");
  assert.equal(r0.match.fee, "300000000000000");
  assert.equal(r0.match.winnerPayout, "2700000000000000");
  assert.equal(r2.match.playerCount, 3);
  assert.deepEqual(r2.match.players.map((p) => [p.seat, p.name, p.you, p.score, p.place, p.payout]), [
    [0, nm(0), false, 900, 1, "2700000000000000"],
    [1, nm(1), false, 500, 2, "0"],
    [2, nm(2), true, 100, 3, "0"],
  ]);
  assert.deepEqual(r2.match.players.map((p) => p.address), g.map((p) => `${p.address.slice(0, 6)}…${p.address.slice(-4)}`));
  assert.deepEqual([r0.match.you.place, r1.match.you.place, r2.match.you.place], [1, 2, 3]);
  // back-compat: `opponent` is the first OTHER player by seat
  assert.equal(r0.match.opponent.name, nm(1));
  assert.equal(r1.match.opponent.name, nm(0));
  assert.equal(r2.match.opponent.name, nm(0));
  assert.equal(r0.match.opponent.score, 500);
  // 1200 each: seat 0 beats both (+12 +12)/2 = +12, seat 1 loses one and wins one = 0, seat 2 loses both = -12
  assert.deepEqual(r0.match.players.map((p) => [p.ratingBefore, p.ratingAfter]), [[1200, 1212], [1200, 1200], [1200, 1188]]);
  assert.deepEqual([r0.match.you.ratingAfter, r1.match.you.ratingAfter, r2.match.you.ratingAfter], [1212, 1200, 1188]);
  assert.deepEqual(g.map((p) => record(h, p)), [[1212, 1, 0, 0], [1200, 0, 1, 0], [1188, 0, 1, 0]]);

  assert.equal(g[0].bal(), START - STAKE + 2_700_000_000_000_000n);
  assert.equal(g[1].bal(), START - STAKE);
  assert.equal(g[2].bal(), START - STAKE);
  assert.equal(h.house(), 300_000_000_000_000n);
  // the loss limit's daily net sees every seat
  assert.deepEqual(g.map((p) => net(h, p)), ["1700000000000000", "-1000000000000000", "-1000000000000000"]);
  assert.deepEqual(g.map((p) => h.app.responsible.lossToday(p.id)), [0n, STAKE, STAKE]);
  for (const p of g) assert.equal((await p.client.api("GET", "/v1/me")).active, null, "everyone is free again");
  const row = h.app.db.get("SELECT outcome, winner_seat, state FROM matches WHERE id = ?", m.id);
  assert.deepEqual({ ...row }, { outcome: "win", winner_seat: 0, state: "settled" });
  conserved(h, g);
});

test("4 players, a 2-way tie at the top: the winners split the payout and the odd wei goes to the house", async () => {
  const h = await boot();
  const stake = 10_000_000_000_001n; // 1e13 + 1
  const g = await crew(h, 4);
  const m = await h.lobbyMatch(g, { stake });
  // pot 40_000_000_000_004; payout floor(90%) = 36_000_000_000_003; fee 4_000_000_000_001
  assert.equal(m.match.pot, "40000000000004");
  assert.equal(m.match.winnerPayout, "36000000000003");
  await h.beginAll(g, m.id);
  await submitAll(h, m.id, g, [700, 700, 300, 100]);
  const rs = await results(g);
  assert.deepEqual(rs.map((r) => r.match.result), ["win", "win", "loss", "loss"]);
  // each winner: floor(36_000_000_000_003 / 2) = 18_000_000_000_001, one wei left over for the house
  assert.deepEqual(rs[3].match.players.map((p) => p.payout), ["18000000000001", "18000000000001", "0", "0"]);
  assert.deepEqual(rs[3].match.players.map((p) => p.place), [1, 1, 3, 4], "ties share a place");
  assert.equal(rs[0].match.fee, "4000000000002", "fee + the wei that did not divide");
  assert.equal(rs[0].match.winnerPayout, "36000000000003");
  assert.equal(g[0].bal(), START - stake + 18_000_000_000_001n);
  assert.equal(g[1].bal(), START - stake + 18_000_000_000_001n);
  assert.equal(g[2].bal(), START - stake);
  assert.equal(g[3].bal(), START - stake);
  assert.equal(h.house(), 4_000_000_000_002n);
  // pairwise: the two winners draw each other (0) and beat both others (+12 each) → (0+12+12)/3 = +8; 2 beats 3
  assert.deepEqual(g.map((p) => record(h, p)), [[1208, 1, 0, 0], [1208, 1, 0, 0], [1196, 0, 1, 0], [1188, 0, 1, 0]]);
  assert.deepEqual(g.map((p) => net(h, p)), ["8000000000000", "8000000000000", "-10000000000001", "-10000000000001"]);
  assert.equal(h.app.db.get("SELECT winner_seat FROM matches WHERE id = ?", m.id).winner_seat, 0);
  conserved(h, g);
});

test("a 3-way split leaves a remainder too, and the ledger entries always sum to zero", async () => {
  const h = await boot();
  const stake = 10_000_000_000_002n; // pot 40_000_000_000_008, payout …007, each …002 ×3 = …006, 1 wei over
  const g = await crew(h, 4);
  const m = await h.lobbyMatch(g, { stake });
  await h.beginAll(g, m.id);
  await submitAll(h, m.id, g, [50, 50, 50, null]); // seat 3 never submits
  const rs = await results(g);
  assert.equal(rs[0].match.reason, "timeout");
  assert.deepEqual(rs[3].match.players.map((p) => p.payout), ["12000000000002", "12000000000002", "12000000000002", "0"]);
  assert.equal(h.house(), 4_000_000_000_002n, "fee 4_000_000_000_001 + 1 leftover wei");
  assert.deepEqual(rs.map((r) => r.match.result), ["win", "win", "win", "loss"]);
  const tx = h.app.db.get("SELECT id FROM ledger_tx WHERE kind = 'match-settle' AND ref = ?", String(m.id));
  const sum = h.app.db.all("SELECT amount FROM ledger_entries WHERE tx_id = ?", tx.id).reduce((a, e) => a + BigInt(e.amount), 0n);
  assert.equal(sum, 0n);
  assert.equal(h.app.db.get("SELECT COUNT(*) AS n FROM ledger_entries WHERE tx_id = ?", tx.id).n, 5, "escrow, 3 winners, house");
  conserved(h, g);
});

test("everyone submits the same score, nobody forfeited: a draw, full refund, no fee", async () => {
  for (const n of [3, 4]) {
    const h = await boot();
    const g = await crew(h, n);
    const m = await h.lobbyMatch(g);
    await h.beginAll(g, m.id);
    await submitAll(h, m.id, g, g.map(() => 250));
    const rs = await results(g);
    for (const [k, r] of rs.entries()) {
      assert.equal(r.match.result, "draw");
      assert.equal(r.match.reason, "scores");
      assert.equal(r.match.you.payout, String(STAKE));
      assert.equal(r.match.you.place, 1);
      assert.equal(r.match.you.ratingAfter, 1200, "equal ratings, equal result: nobody moves");
      assert.ok(r.match.players.every((p) => p.place === 1 && p.payout === String(STAKE) && p.score === 250));
      assert.equal(g[k].bal(), START);
    }
    assert.equal(h.house(), 0n);
    assert.equal(rs[0].match.fee, "0");
    assert.deepEqual(g.map((p) => record(h, p)), g.map(() => [1200, 0, 0, 1]), "a draw is counted for everyone");
    assert.deepEqual(g.map((p) => net(h, p)), g.map(() => null));
    assert.equal(h.app.db.get("SELECT winner_seat FROM matches WHERE id = ?", m.id).winner_seat, null);
    conserved(h, g);
  }
});

test("a draw between players of different strength still moves ratings (pairwise draw)", async () => {
  const h = await boot();
  const g = await crew(h, 3);
  [1400, 1200, 1000].forEach((r, i) => seedRating(h, g[i], r));
  const m = await h.lobbyMatch(g, { stake: 0n });
  await h.beginAll(g, m.id);
  await submitAll(h, m.id, g, [5, 5, 5]);
  await results(g);
  // draw pairs: (1400,1200) E=.7597 → round(24*(.5-.7597)) = -6; (1400,1000) E=.9091 → -10; (1200,1000) E=.7597 → -6
  // seat 0: (-6 -10)/2 = -8; seat 1: (+6 -6)/2 = 0; seat 2: (+10 +6)/2 = +8
  assert.deepEqual(g.map((p) => record(h, p)), [[1392, 0, 0, 1], [1200, 0, 0, 1], [1008, 0, 0, 1]]);
});

test("pairwise Elo with different ratings: N=3 follows the pair-by-pair rule, rounded half away from zero", async () => {
  const h = await boot();
  const g = await crew(h, 3);
  [1300, 1200, 1100].forEach((r, i) => seedRating(h, g[i], r));
  const m = await h.lobbyMatch(g, { stake: 0n });
  assert.deepEqual(m.match.players.map((p) => p.ratingBefore), [1300, 1200, 1100]);
  await h.beginAll(g, m.id);
  await submitAll(h, m.id, g, [5, 7, 3]); // finish order: seat 1, seat 0, seat 2
  const [r0] = await results(g);
  // pair deltas (K=24, expected score 1/(1+10^((b-a)/400))):
  //   seat0 v seat1: 1300 loses to 1200: round(24*(0-.6401)) = -15      seat0 v seat2: 1300 beats 1100: round(24*(1-.7597)) = +6
  //   seat1 v seat2: 1200 beats 1100:    round(24*(1-.6401)) = +9
  // seat0: (-15+6)/2 = -4.5 → -5   seat1: (+15+9)/2 = +12   seat2: (-6-9)/2 = -7.5 → -8
  assert.deepEqual(r0.match.players.map((p) => p.ratingAfter), [1295, 1212, 1092]);
  assert.deepEqual(r0.match.players.map((p) => p.place), [2, 1, 3]);
  assert.deepEqual(g.map((p) => record(h, p)), [[1295, 0, 1, 0], [1212, 1, 0, 0], [1092, 0, 1, 0]]);
  assert.equal(h.app.db.get("SELECT winner_seat FROM matches WHERE id = ?", m.id).winner_seat, 1);
  audit(h);
});

/* ------------------------------------------------------------------ forfeits */

test("3 players, one forfeits: the match goes on, the others are told, and it settles when the rest have submitted", async () => {
  const h = await boot();
  const g = await crew(h, 3);
  const m = await h.lobbyMatch(g);
  await h.beginAll(g, m.id);

  const out = await g[1].client.forfeit(m.id);
  assert.deepEqual(out, { matchId: m.id, state: "playing" });
  for (const k of [0, 2]) {
    const ev = await g[k].client.waitFor("match.opponent_forfeited");
    assert.deepEqual({ matchId: ev.matchId, seat: ev.seat }, { matchId: m.id, seat: 1 });
  }
  assert.equal(g[1].client.peek("match.opponent_forfeited").length, 0);
  assert.equal(g[0].client.peek("match.result").length, 0, "not over yet");
  const mid = await g[0].client.api("GET", `/v1/matches/${m.id}`);
  assert.equal(mid.state, "playing");
  assert.deepEqual(mid.players.map((p) => p.forfeited), [false, true, false]);

  // forfeiting again is harmless and silent; the forfeiter cannot submit; they stay in the match until it ends
  assert.deepEqual(await g[1].client.forfeit(m.id), { matchId: m.id, state: "playing" });
  await assert.rejects(g[1].client.submit(m.id, 9999), { code: "FORFEITED" });
  await assert.rejects(g[1].client.joinQueue({ game: GAME, stake: "0" }), { code: "ALREADY_ACTIVE" });
  await sleep(40);
  assert.equal(g[0].client.peek("match.opponent_forfeited").length, 0, "the second forfeit was not announced again");

  await g[0].client.submit(m.id, 900);
  assert.equal(g[0].client.peek("match.result").length, 0, "one of the two still playing has not finished");
  await g[2].client.submit(m.id, 500);
  const rs = await results(g);
  assert.deepEqual(rs.map((r) => r.match.result), ["win", "loss", "loss"]);
  assert.equal(rs[0].match.reason, "scores");
  assert.deepEqual(rs[1].match.players.map((p) => [p.forfeited, p.place, p.payout]), [[false, 1, "2700000000000000"], [true, 3, "0"], [false, 2, "0"]]);
  // the forfeiter counts as having nothing: loses to both, who split 900 > 500 → [+12, -12 forfeit, 0]
  assert.deepEqual(g.map((p) => record(h, p)), [[1212, 1, 0, 0], [1188, 0, 1, 0], [1200, 0, 1, 0]]);
  assert.equal(g[0].bal(), START - STAKE + 2_700_000_000_000_000n);
  assert.equal(g[1].bal(), START - STAKE);
  assert.equal(g[2].bal(), START - STAKE);
  for (const p of g) assert.equal((await p.client.api("GET", "/v1/me")).active, null);
  conserved(h, g);
});

test("a forfeiter with the best score still loses; the best of the others wins", async () => {
  const h = await boot();
  const g = await crew(h, 3);
  const m = await h.lobbyMatch(g);
  await h.beginAll(g, m.id);
  await g[0].client.submit(m.id, 5000);
  await g[0].client.forfeit(m.id); // submitted, then quit
  await g[1].client.submit(m.id, 100);
  await g[2].client.submit(m.id, 200);
  const rs = await results(g);
  assert.deepEqual(rs.map((r) => r.match.result), ["loss", "loss", "win"]);
  assert.equal(g[2].bal(), START - STAKE + 2_700_000_000_000_000n);
  conserved(h, g);
});

test("when forfeits leave one player standing they win at once, without a score", async () => {
  const h = await boot();
  const g = await crew(h, 3);
  const m = await h.lobbyMatch(g);
  await h.beginAll(g, m.id);
  await g[1].client.forfeit(m.id);
  await g[0].client.waitFor("match.opponent_forfeited");
  assert.deepEqual(await g[2].client.forfeit(m.id), { matchId: m.id, state: "settled" });
  const rs = await results(g);
  assert.deepEqual(rs.map((r) => r.match.result), ["win", "loss", "loss"]);
  assert.equal(rs[0].match.reason, "forfeit");
  assert.deepEqual(rs[0].match.players.map((p) => p.place), [1, 2, 2], "the two forfeiters share second place");
  // standing player beats both (+12 +12)/2, the two forfeiters draw each other: (-12 + 0)/2 = -6
  assert.deepEqual(g.map((p) => record(h, p)), [[1212, 1, 0, 0], [1194, 0, 1, 0], [1194, 0, 1, 0]]);
  assert.equal(g[0].bal(), START - STAKE + 2_700_000_000_000_000n);
  assert.equal(h.house(), 300_000_000_000_000n);
  conserved(h, g);
});

test("a forfeit after everybody else has submitted settles immediately", async () => {
  const h = await boot();
  const g = await crew(h, 3);
  const m = await h.lobbyMatch(g);
  await h.beginAll(g, m.id);
  await g[0].client.submit(m.id, 900);
  await g[2].client.submit(m.id, 500);
  await sleep(40);
  assert.equal(g[0].client.peek("match.result").length, 0, "seat 1 might still submit");
  await g[1].client.forfeit(m.id);
  const rs = await results(g);
  assert.deepEqual(rs.map((r) => r.match.result), ["win", "loss", "loss"]);
  assert.equal(g[0].client.peek("match.opponent_forfeited").length, 0, "the match ended, so the result is the news");
  conserved(h, g);
});

test("a forfeit in a 2-player lobby match ends it straight away, as in a 1v1", async () => {
  const h = await boot();
  const g = await crew(h, 2);
  const m = await h.lobbyMatch(g);
  await h.beginAll(g, m.id);
  assert.deepEqual(await g[1].client.forfeit(m.id), { matchId: m.id, state: "settled" });
  const [a, b] = await results(g);
  assert.deepEqual([a.match.result, b.match.result, a.match.reason], ["win", "loss", "forfeit"]);
  assert.equal(g[0].client.peek("match.opponent_forfeited").length, 0);
  assert.equal(g[0].bal(), START - STAKE + 1_800_000_000_000_000n);
  assert.deepEqual(g.map((p) => record(h, p)), [[1212, 1, 0, 0], [1188, 0, 1, 0]]);
  conserved(h, g);
});

/* ------------------------------------------------------------------ deadline */

test("4 players, two never submit: they lose at the deadline and the others are ranked on their scores", async () => {
  const h = await boot();
  const g = await crew(h, 4);
  const m = await h.lobbyMatch(g);
  await h.beginAll(g, m.id);
  await g[0].client.submit(m.id, 900);
  await g[1].client.submit(m.id, 500);
  const rs = await results(g);
  assert.equal(rs[0].match.reason, "timeout");
  assert.deepEqual(rs.map((r) => r.match.result), ["win", "loss", "loss", "loss"]);
  assert.deepEqual(rs[2].match.players.map((p) => [p.finished, p.score, p.place, p.payout]), [
    [true, 900, 1, "3600000000000000"], [true, 500, 2, "0"], [false, null, 3, "0"], [false, null, 3, "0"]]);
  // seat 0 beats all three: 36/3 = +12; seat 1: -12 +12 +12 = +4; seats 2 and 3: -12 -12 +0 (they draw each other) = -8
  assert.deepEqual(g.map((p) => record(h, p)), [[1212, 1, 0, 0], [1204, 0, 1, 0], [1192, 0, 1, 0], [1192, 0, 1, 0]]);
  assert.equal(g[0].bal(), START - STAKE + 3_600_000_000_000_000n);
  assert.equal(h.house(), 400_000_000_000_000n);
  conserved(h, g);
});

test("3 players, only one submits: that player wins the deadline", async () => {
  const h = await boot();
  const g = await crew(h, 3);
  const m = await h.lobbyMatch(g);
  await h.beginAll(g, m.id);
  await g[1].client.submit(m.id, 1);
  const rs = await results(g);
  assert.deepEqual(rs.map((r) => r.match.result), ["loss", "win", "loss"]);
  assert.equal(g[1].bal(), START - STAKE + 2_700_000_000_000_000n);
  assert.deepEqual(g.map((p) => record(h, p)), [[1194, 0, 1, 0], [1212, 1, 0, 0], [1194, 0, 1, 0]]);
  conserved(h, g);
});

test("4 players, nobody submits: the match is void, everybody is refunded, nobody is rated", async () => {
  const h = await boot();
  const g = await crew(h, 4);
  const m = await h.lobbyMatch(g);
  await h.beginAll(g, m.id);
  const vs = await results(g, "match.void");
  for (const v of vs) { assert.equal(v.match.result, "void"); assert.equal(v.match.reason, "no_result"); assert.equal(v.match.state, "void"); }
  assert.deepEqual(vs[0].match.players.map((p) => [p.place, p.ratingAfter]), g.map(() => [null, 1200]));
  g.forEach((p) => assert.equal(p.bal(), START));
  assert.equal(h.app.db.get("SELECT COUNT(*) AS n FROM ratings").n, 0);
  assert.equal(h.app.db.get("SELECT COUNT(*) AS n FROM player_day").n, 0);
  conserved(h, g);
});

test("one forfeits and the others never submit: nobody has a result, so it is void and refunded", async () => {
  const h = await boot();
  const g = await crew(h, 3);
  const m = await h.lobbyMatch(g);
  await h.beginAll(g, m.id);
  await g[0].client.forfeit(m.id);
  const vs = await results(g, "match.void");
  assert.equal(vs[1].match.reason, "no_result");
  g.forEach((p) => assert.equal(p.bal(), START));
  assert.equal(h.app.db.get("SELECT COUNT(*) AS n FROM ratings").n, 0);
  conserved(h, g);
});

/* ------------------------------------------------------------------ shapes, edge cases */

test("a full 10-player match plays out; auto-started lobby, one winner among ten", async () => {
  const h = await boot();
  const g = await crew(h, 10);
  const m = await h.lobbyMatch(g); // the 10th join starts it
  assert.equal(m.match.playerCount, 10);
  await h.beginAll(g, m.id);
  await submitAll(h, m.id, g, g.map((_, i) => 100 + i * 10)); // seat 9 is best
  const rs = await results(g);
  assert.deepEqual(rs.map((r) => r.match.result), [...Array(9).fill("loss"), "win"]);
  assert.deepEqual(rs[0].match.players.map((p) => p.place), [10, 9, 8, 7, 6, 5, 4, 3, 2, 1]);
  assert.equal(g[9].bal(), START - STAKE + 9_000_000_000_000_000n); // pot 10 mETH, 90%
  assert.equal(h.house(), 1_000_000_000_000_000n);
  // seat 9 wins all nine pairs: 9 x 12 / 9 = +12; seat 0 loses all nine: -12; the middle moves by the rank gap
  const ratings = rs[0].match.players.map((p) => p.ratingAfter);
  assert.equal(ratings[9], 1212);
  assert.equal(ratings[0], 1188);
  assert.deepEqual(ratings, [...ratings].sort((a, b) => a - b), "ratings are ordered like the finish");
  assert.equal(h.app.db.get("SELECT SUM(wins) AS w, SUM(losses) AS l FROM ratings").w, 1);
  assert.equal(h.app.db.get("SELECT SUM(wins) AS w, SUM(losses) AS l FROM ratings").l, 9);
  conserved(h, g);
});

test("free (stake 0) lobbies of 3 move no money but still rate everyone", async () => {
  const h = await boot();
  const g = await crew(h, 3, { fund: 0n });
  const m = await h.lobbyMatch(g, { stake: 0n });
  assert.equal(m.match.stake, "0");
  await h.beginAll(g, m.id);
  await submitAll(h, m.id, g, [1, 2, 3]);
  const rs = await results(g);
  assert.deepEqual(rs.map((r) => r.match.result), ["loss", "loss", "win"]);
  assert.deepEqual(rs[0].match.players.map((p) => p.payout), ["0", "0", "0"]);
  assert.deepEqual(g.map((p) => record(h, p)), [[1188, 0, 1, 0], [1200, 0, 1, 0], [1212, 1, 0, 0]]);
  assert.equal(h.app.db.get("SELECT COUNT(*) AS n FROM ledger_tx WHERE kind LIKE 'match%' OR kind LIKE 'stake%'").n, 0);
  audit(h);
});

test("a 2-player lobby match is exactly a 1v1: same money, same ±12, `opponent` and `players` agree", async () => {
  const h = await boot();
  const g = await crew(h, 2);
  const m = await h.lobbyMatch(g);
  assert.equal(m.match.pot, "2000000000000000");
  assert.equal(m.match.winnerPayout, "1800000000000000");
  await h.beginAll(g, m.id);
  await g[0].client.submit(m.id, 4200);
  await g[1].client.submit(m.id, 3900);
  const [a, b] = await results(g);
  assert.deepEqual([a.match.result, b.match.result], ["win", "loss"]);
  assert.deepEqual([a.match.you.ratingAfter, b.match.you.ratingAfter], [1212, 1188]);
  assert.deepEqual([a.match.you.payout, b.match.you.payout], ["1800000000000000", "0"]);
  assert.equal(a.match.fee, "200000000000000");
  assert.equal(a.match.opponent.score, 3900);
  assert.equal(a.match.opponent.name, a.match.players[1].name);
  assert.equal(b.match.opponent.name, b.match.players[0].name);
  assert.equal(h.house(), 200_000_000_000_000n);
  conserved(h, g);
});

test("the public queue still pairs exactly two players and reports them in `players`", async () => {
  const h = await boot();
  const [a, b, c] = await crew(h, 3);
  const m = await h.pair(a, b);
  assert.equal(m.a.playerCount, 2);
  assert.deepEqual(m.a.players.map((p) => [p.seat, p.name, p.you]), [[0, nm(0), true], [1, nm(1), false]]);
  assert.deepEqual(m.b.players.map((p) => [p.seat, p.you]), [[0, false], [1, true]]);
  assert.equal(m.a.private, false);
  await h.begin(a, b, m.id);
  await a.client.submit(m.id, 2);
  await b.client.submit(m.id, 1);
  await Promise.all([a.client.waitFor("match.result"), b.client.waitFor("match.result")]);
  assert.equal(c.bal(), START);
  conserved(h, [a, b, c]);
});

test("match history and detail include every player, and only members can read them", async () => {
  const h = await boot();
  const g = await crew(h, 3);
  const outsider = await h.player();
  const m = await h.lobbyMatch(g);
  await h.beginAll(g, m.id);
  await submitAll(h, m.id, g, [3, 2, 1]);
  await results(g);
  const hist = await g[2].client.api("GET", "/v1/matches");
  assert.equal(hist.matches.length, 1);
  assert.equal(hist.matches[0].result, "loss");
  assert.equal(hist.matches[0].players.length, 3);
  assert.equal(hist.matches[0].you.place, 3);
  const one = await g[1].client.api("GET", `/v1/matches/${m.id}`);
  assert.deepEqual(one.players.map((p) => p.place), [1, 2, 3]);
  await assert.rejects(outsider.client.api("GET", `/v1/matches/${m.id}`), { code: "NOT_FOUND", status: 404 });
  assert.ok(!JSON.stringify(one).includes(g[0].address.slice(2, 12)), "no full address in anything a player sees");
  audit(h);
});

test("players can go again right after a lobby match, in a new lobby with different people", async () => {
  const h = await boot();
  const g = await crew(h, 4);
  const m1 = await h.lobbyMatch(g.slice(0, 3));
  await h.beginAll(g.slice(0, 3), m1.id);
  await submitAll(h, m1.id, g.slice(0, 3), [1, 2, 3]);
  await results(g.slice(0, 3));
  // winner (seat 2) hosts the next one, with the loser of round one and the newcomer
  const m2 = await h.lobbyMatch([g[2], g[0], g[3]]);
  assert.notEqual(m2.id, m1.id);
  await h.beginAll([g[2], g[0], g[3]], m2.id);
  await submitAll(h, m2.id, [g[2], g[0], g[3]], [1, 2, 3]);
  await results([g[2], g[0], g[3]]);
  conserved(h, g);
});
