/* Pure rules: pairing, Elo, game catalog. No network, no database. */
import test from "node:test";
import assert from "node:assert/strict";
import { bucketKey, windowFor, findPartner } from "../src/matches/queue.js";
import { expected, delta, K, pairwiseDeltas } from "../src/matches/elo.js";
import { decide, standings, placesOf } from "../src/matches/standings.js";
import { loadCatalog, parseDurationSeconds } from "../src/games/catalog.js";
import { createLogger } from "../src/util/log.js";
import { loadConfig } from "../src/config.js";

const CFG = { ratingBase: 60, ratingGrowthPerSec: 15, ratingMax: 600 };
const t = (id, userId, rating, at = 0, extra = {}) => ({ id, userId, rating, at, game: "aim", stake: "5", code: null, ...extra });

/* ------------------------------------------------------------------ pairing */

test("windowFor: starts at the base, grows per whole second waited, and stops at the cap", () => {
  const x = t(1, 1, 1200, 1000);
  assert.equal(windowFor(x, 1000, CFG), 60);
  assert.equal(windowFor(x, 1999, CFG), 60, "partial seconds do not count");
  assert.equal(windowFor(x, 2000, CFG), 75);
  assert.equal(windowFor(x, 11000, CFG), 210);
  assert.equal(windowFor(x, 1000 + 3_600_000, CFG), 600);
  assert.equal(windowFor(x, 0, CFG), 60, "clock skew never makes the window negative");
});

test("findPartner: never the same player, even if they somehow hold two tickets", () => {
  const a = t(1, 7, 1200), a2 = t(2, 7, 1200);
  assert.equal(findPartner(a, [a, a2], 0, CFG), null);
  const other = t(3, 8, 1200);
  assert.equal(findPartner(a, [a, a2, other], 0, CFG), other);
});

test("findPartner: picks the closest rating, breaking ties by the longest wait", () => {
  const me = t(1, 1, 1200, 5000);
  const far = t(2, 2, 1250, 0), near = t(3, 3, 1210, 4000), nearOlder = t(4, 4, 1190, 1000);
  assert.equal(findPartner(me, [me, far, near], 5000, CFG), near);
  assert.equal(findPartner(me, [me, near, nearOlder], 5000, CFG), nearOlder, "10 apart both; the older ticket wins");
});

test("findPartner: respects the window, and the wider of the two windows applies", () => {
  const me = t(1, 1, 1200, 10000), stranger = t(2, 2, 1400, 10000);
  assert.equal(findPartner(me, [me, stranger], 10000, CFG), null, "200 apart, both windows are 60");
  const waited = t(3, 3, 1400, 0); // has waited 10 s → window 210
  assert.equal(findPartner(me, [me, waited], 10000, CFG), waited, "the long-waiting player's window covers it");
});

test("findPartner: a private code ignores rating entirely", () => {
  const me = t(1, 1, 800, 0, { code: "ABCD" }), friend = t(2, 2, 2400, 0, { code: "ABCD" });
  assert.equal(findPartner(me, [me, friend], 0, CFG), friend);
});

test("bucketKey separates game, stake and private code", () => {
  const keys = new Set([bucketKey(t(1, 1, 1, 0)), bucketKey(t(1, 1, 1, 0, { game: "darts" })), bucketKey(t(1, 1, 1, 0, { stake: "6" })), bucketKey(t(1, 1, 1, 0, { code: "X" }))]);
  assert.equal(keys.size, 4);
  assert.equal(bucketKey(t(1, 1, 1, 0)), bucketKey(t(9, 9, 999, 99)), "rating, user and time do not matter");
});

/* ------------------------------------------------------------------ Elo */

test("Elo matches the front-end constants: K = 24, equal ratings move 12", () => {
  assert.equal(K, 24);
  assert.equal(expected(1200, 1200), 0.5);
  assert.equal(delta(1200, 1200, 1), 12);
  assert.equal(delta(1200, 1200, 0), -12);
  assert.equal(delta(1200, 1200, 0.5), 0);
  assert.equal(delta(1200, 1600, 1), 22, "beating a much stronger player pays more");
  assert.equal(delta(1600, 1200, 1), 2, "beating a much weaker player pays little");
  assert.ok(Math.abs(expected(1000, 1400) + expected(1400, 1000) - 1) < 1e-12);
});

test("Elo deltas stay within ±K for any pair, and a win never loses points", () => {
  for (let a = 600; a <= 2400; a += 150) for (let b = 600; b <= 2400; b += 150) {
    for (const s of [0, 0.5, 1]) assert.ok(Math.abs(delta(a, b, s)) <= K);
    assert.ok(delta(a, b, 1) >= 0 && delta(a, b, 0) <= 0);
  }
});

/* ------------------------------------------------------------------ N-player results */

const row = (seat, score = null, forfeited = 0) => ({ seat, score, forfeited });
const rows = (...specs) => specs.map((x, i) => (Array.isArray(x) ? row(i, x[0], x[1]) : row(i, x)));
const NONE = -Infinity;

test("pairwiseDeltas for two players is exactly the old 1v1 formula, for every rating pair and result", () => {
  for (let a = 700; a <= 2100; a += 53) for (let b = 700; b <= 2100; b += 61) {
    for (const [ka, kb, s] of [[2, 1, 1], [1, 2, 0], [5, 5, 0.5], [3, NONE, 1], [NONE, NONE, 0.5], [NONE, 4, 0]]) {
      const d = delta(a, b, s) || 0; // what the 1v1 code did: A gets d, B gets -d (only the sign of a zero differs)
      assert.deepEqual(pairwiseDeltas([a, b], [ka, kb]), [d, -d || 0], `${a} v ${b} result ${s}`);
    }
  }
  assert.deepEqual(pairwiseDeltas([1200, 1200], [4200, 3900]), [12, -12]);
  assert.deepEqual(pairwiseDeltas([1200, 1200], [1, 1]), [0, 0]);
  assert.ok(pairwiseDeltas([1200, 1200], [1, 1]).every((x) => !Object.is(x, -0)), "never -0");
});

test("pairwiseDeltas for N players: each pair is rated with delta(), the sum is divided by N-1 and rounded half away from zero", () => {
  // equal ratings, finish 1 > 2 > 3: +12 +12 | -12 +12 | -12 -12 → [12, 0, -12]
  assert.deepEqual(pairwiseDeltas([1200, 1200, 1200], [9, 5, 1]), [12, 0, -12]);
  // a tie at the top: the pair draws (0), both beat the third
  assert.deepEqual(pairwiseDeltas([1200, 1200, 1200], [7, 7, 1]), [6, 6, -12]);
  // a forfeit/no score (−∞) loses to anybody with a score; two of them draw each other
  assert.deepEqual(pairwiseDeltas([1200, 1200, 1200, 1200], [9, 5, NONE, NONE]), [12, 4, -8, -8]);
  // not symmetric by hand-waving: do the pairs explicitly with delta()
  const r = [1350, 1180, 1015, 1500, 1210], k = [3, NONE, 8, 8, 2];
  const want = r.map((ri, i) => {
    let t = 0;
    r.forEach((rj, j) => { if (j !== i) t += delta(ri, rj, k[i] > k[j] ? 1 : k[i] === k[j] ? 0.5 : 0); });
    const v = t / (r.length - 1);
    return Math.sign(v) * Math.round(Math.abs(v)) || 0;
  });
  assert.deepEqual(pairwiseDeltas(r, k), want);
  // a half: (-15 + 6)/2 = -4.5 → -5 and (-6 - 9)/2 = -7.5 → -8
  assert.deepEqual(pairwiseDeltas([1300, 1200, 1100], [5, 7, 3]), [-5, 12, -8]);
  // nobody can win or lose more than K points in a match
  for (let n = 2; n <= 10; n++) {
    const ratings = Array.from({ length: n }, (_, i) => 900 + i * 97), keys = Array.from({ length: n }, (_, i) => (i % 3 === 0 ? NONE : i));
    for (const d of pairwiseDeltas(ratings, keys)) assert.ok(Math.abs(d) <= K);
  }
});

test("decide(): winners, ties, draws, forfeits and voids", () => {
  const d = (...a) => decide(rows(...a));
  assert.deepEqual(d(5, 3), { outcome: "win", why: "scores", winners: [0] });
  assert.deepEqual(d(3, 5, 4), { outcome: "win", why: "scores", winners: [1] });
  assert.deepEqual(d(5, 5, 1), { outcome: "win", why: "scores", winners: [0, 1] }, "a tie at the top shares the win");
  assert.deepEqual(d(1, 9, 9, 9), { outcome: "win", why: "scores", winners: [1, 2, 3] });
  assert.deepEqual(d(7, 7), { outcome: "draw", why: "scores", winners: [] });
  assert.deepEqual(d(2, 2, 2, 2), { outcome: "draw", why: "scores", winners: [] });
  assert.deepEqual(d(0, 0, 0), { outcome: "draw", why: "scores", winners: [] }, "a zero is a score");
  // deadline: players without a score lose
  assert.deepEqual(d(4, null), { outcome: "win", why: "timeout", winners: [0] });
  assert.deepEqual(d(null, null, 3), { outcome: "win", why: "timeout", winners: [2] });
  assert.deepEqual(d(6, 6, null), { outcome: "win", why: "timeout", winners: [0, 1] }, "not everybody tied, so not a draw");
  assert.deepEqual(d(null, null), { outcome: "void", why: "no_result", winners: [] });
  assert.deepEqual(d(null, null, null, null), { outcome: "void", why: "no_result", winners: [] });
  // forfeits
  assert.deepEqual(d(null, [null, 1]), { outcome: "win", why: "forfeit", winners: [0] }, "the one standing wins without a score");
  assert.deepEqual(d([9, 1], 2), { outcome: "win", why: "forfeit", winners: [1] }, "a forfeiter's score does not count");
  assert.deepEqual(d(null, [null, 1], [null, 1]), { outcome: "win", why: "forfeit", winners: [0] });
  assert.deepEqual(d(5, [9, 1], 3), { outcome: "win", why: "scores", winners: [0] }, "the rest all submitted: ranked among themselves");
  assert.deepEqual(d(5, [null, 1], null), { outcome: "win", why: "timeout", winners: [0] });
  assert.deepEqual(d(5, [5, 1], 5), { outcome: "win", why: "scores", winners: [0, 2] }, "all tied but somebody forfeited: not a draw");
  assert.deepEqual(d(null, [null, 1], null), { outcome: "void", why: "no_result", winners: [] }, "forfeit + nobody else scored");
  assert.deepEqual(d([9, 1], null, null), { outcome: "void", why: "no_result", winners: [] });
});

test("standings() and placesOf(): ties share a place, forfeits and no-shows share the last one", () => {
  assert.deepEqual(placesOf(standings(rows(900, 500, 100), "scores")), [1, 2, 3]);
  assert.deepEqual(placesOf(standings(rows(7, 7, 3, 1), "scores")), [1, 1, 3, 4]);
  assert.deepEqual(placesOf(standings(rows(5, null, null), "timeout")), [1, 2, 2]);
  assert.deepEqual(placesOf(standings(rows(5, [9, 1], 3), "scores")), [1, 3, 2]);
  assert.deepEqual(placesOf(standings(rows(null, [null, 1], [null, 1]), "forfeit")), [1, 2, 2], "the survivor wins with no score");
  assert.deepEqual(placesOf(standings(rows(null, [7, 1]), "forfeit")), [1, 2]);
  assert.deepEqual(placesOf(standings(rows(3, 3, 3), "scores")), [1, 1, 1]);
  // matches settled before multi-player lobbies existed carry the same rows and read the same
  assert.deepEqual(placesOf(standings(rows(4200, 3900), "scores")), [1, 2]);
  assert.deepEqual(placesOf(standings(rows(500, null), "timeout")), [1, 2]);
  assert.deepEqual(placesOf(standings(rows([null, 1], null), "forfeit")), [2, 1]);
});

/* ------------------------------------------------------------------ catalog */

test("game durations are read from the human-readable strings", () => {
  const cases = { "30 s": 30, "90 s": 90, "2 min": 120, "3 min (mix 45 s)": 180, "up to 6 min": 360, "1–4 min": 240, "95 s (mix 40 s)": 95, "": 300, "soon": 300, "1.5 min": 90 };
  for (const [text, secs] of Object.entries(cases)) assert.equal(parseDurationSeconds(text), secs, JSON.stringify(text));
});

test("the catalog loads the real game packs: race games are PvP-ready, versus games are not", () => {
  const cfg = loadConfig({ NODE_ENV: "test" });
  const cat = loadCatalog({ gamesDir: cfg.gamesDir, log: createLogger("silent") });
  const all = cat.list();
  assert.equal(all.length, 23);
  assert.equal(all.filter((g) => g.pvp).length, 14);
  for (const g of all) assert.equal(g.pvp, g.kind === "race", g.id);
  assert.ok(all.every((g) => g.maxSeconds >= 30 && g.maxSeconds <= 600), "every game has a sane time limit");
  assert.equal(cat.get("chess").pvp, false);
  assert.equal(cat.get("nope"), null);
});

test("bots give a deterministic ceiling per seed, and only absurd scores look implausible", () => {
  const cfg = loadConfig({ NODE_ENV: "test" });
  const cat = loadCatalog({ gamesDir: cfg.gamesDir, log: createLogger("silent") });
  const g = cat.get("aim");
  const top = cat.botCeiling(g, 4242);
  assert.ok(top > 0);
  assert.equal(cat.botCeiling(g, 4242), top, "cached and deterministic");
  assert.equal(cat.plausibility(g, 4242, top), null, "matching the strongest bot is fine");
  assert.equal(cat.plausibility(g, 4242, top * 2), null, "twice as good is unusual but allowed");
  assert.equal(cat.plausibility(g, 4242, 0), null);
  assert.equal(cat.plausibility(g, 4242, -5), null);
  assert.match(cat.plausibility(g, 4242, top * 10), /3× the strongest bot/);
});

/* ------------------------------------------------------------------ logging */

test("the logger keeps nested errors readable and redacts URLs (RPC URLs carry API keys)", async () => {
  const { createLogger } = await import("../src/util/log.js");
  const lines = [];
  const log = createLogger("info", (l) => lines.push(JSON.parse(l)));
  log.error("boom", { key: "k", error: new Error("server response 500 (info={ \"requestUrl\": \"https://rpc.example/v2/SECRET\" })") });
  log.error("plain", new Error("connect to http://user:pw@host:8545/path failed"));
  const all = JSON.stringify(lines);
  assert.ok(!all.includes("SECRET") && !all.includes("pw@"), all);
  assert.match(lines[0].error.message, /server response 500/, "the nested error is still informative");
  assert.equal(lines[0].key, "k");
  assert.match(lines[1].err.message, /connect to \[url\] failed/);
});
