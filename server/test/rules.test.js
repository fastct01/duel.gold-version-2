/* Pure rules: pairing, Elo, game catalog. No network, no database. */
import test from "node:test";
import assert from "node:assert/strict";
import { bucketKey, windowFor, findPartner } from "../src/matches/queue.js";
import { expected, delta, K } from "../src/matches/elo.js";
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

/* ------------------------------------------------------------------ catalog */

test("game durations are read from the human-readable strings", () => {
  const cases = { "30 s": 30, "90 s": 90, "2 min": 120, "3 min (mix 45 s)": 180, "up to 6 min": 360, "1–4 min": 240, "95 s (mix 40 s)": 95, "": 300, "soon": 300, "1.5 min": 90 };
  for (const [text, secs] of Object.entries(cases)) assert.equal(parseDurationSeconds(text), secs, JSON.stringify(text));
});

test("the catalog loads the real game packs: race games are PvP-ready, versus games are not", () => {
  const cfg = loadConfig({ NODE_ENV: "test" });
  const cat = loadCatalog({ gamesDir: cfg.gamesDir, log: createLogger("silent") });
  const all = cat.list();
  assert.equal(all.length, 22);
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
