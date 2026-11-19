/* The table-game engines on their own (src/tables): the card shuffle and hand evaluator, hold'em betting, pots and
   privacy, and server-refereed chess. Whole matches through the server are in table-matches.test.js. */
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { DECK, shuffledDeck, bestHand, eval5, compareValues } from "../src/tables/cards.js";
import * as poker from "../src/tables/poker.js";
import * as chess from "../src/tables/chess.js";

/* ------------------------------------------------------------------ cards */

test("the shuffle uses every card once and spreads each card evenly over the positions", () => {
  const N = 20000;
  const counts = Array(52).fill(0); // where the ace of spades lands
  const firsts = new Map();
  for (let i = 0; i < N; i++) {
    const d = shuffledDeck();
    if (i < 200) assert.equal(new Set(d).size, 52);
    counts[d.indexOf("As")]++;
    firsts.set(d[0], (firsts.get(d[0]) || 0) + 1);
  }
  // chi-square over 52 positions (51 degrees of freedom): p < 0.001 above about 87.0
  const exp = N / 52;
  const chi = counts.reduce((a, c) => a + (c - exp) ** 2 / exp, 0);
  assert.ok(chi < 95, `ace-of-spades position chi-square ${chi.toFixed(1)}`);
  assert.equal(firsts.size, 52, "every card has come first");
  // two decks in a row are (astronomically) never the same
  assert.notEqual(shuffledDeck().join(""), shuffledDeck().join(""));
});

test("the shuffle is a Fisher–Yates driven by the random source it is given", () => {
  let calls = [];
  const d = shuffledDeck((n) => { calls.push(n); return 0; });
  assert.deepEqual(calls, Array.from({ length: 51 }, (_, i) => 52 - i)); // randInt(52), randInt(51) … randInt(2)
  assert.equal(new Set(d).size, 52);
});

test("hand evaluator: categories and tie-breaks", () => {
  const v = (s) => bestHand(s.split(" ")).value;
  const name = (s) => bestHand(s.split(" ")).name;
  assert.equal(name("As Ks Qs Js Ts 2d 3c"), "Royal flush");
  assert.equal(name("5d 4d 3d 2d Ad Kc Kh"), "Straight flush, Five high");
  assert.equal(name("9c 9d 9h 9s 2c 3d 4h"), "Four of a kind, Nines");
  assert.equal(name("Kc Kd Kh 7s 7c 2d 3h"), "Full house, Kings over Sevens");
  assert.equal(name("2h 7h 9h Jh Kh As Ad"), "Flush, King high");
  assert.equal(name("Ac 2d 3h 4s 5c 9d Kh"), "Straight, Five high");
  assert.equal(name("6c 6d 6h Ks 2c 9d 4h"), "Three of a kind, Sixes");
  assert.equal(name("Jc Jd 4h 4s Ac 9d 2h"), "Two pair, Jacks and Fours");
  assert.equal(name("Qc Qd 4h 7s Ac 9d 2h"), "Pair of Queens");
  assert.equal(name("Ac Jd 4h 7s 3c 9d 2h"), "Ace high");
  // ordering
  assert.ok(compareValues(v("As Ks Qs Js Ts 2d 3c"), v("9c 9d 9h 9s 2c 3d 4h")) > 0);
  assert.ok(compareValues(v("6c 7d 8h 9s Tc 2d 2h"), v("Ac 2d 3h 4s 5c 9d Kh")) > 0, "a ten-high straight beats the wheel");
  assert.ok(compareValues(v("Ac Ad Kh 7s 3c 9d 2h"), v("Ac Ad Qh 7s 3c 9d 2h")) > 0, "kicker decides");
  assert.equal(compareValues(v("Ac Ad Kh Qs Jc 3d 2h"), v("Ac Ad Kh Qs Jc 4d 2h")), 0, "only the best five count");
  assert.ok(compareValues(eval5(["Kc", "Kd", "Kh", "2s", "2c"]), eval5(["Qc", "Qd", "Qh", "As", "Ac"])) > 0);
  assert.equal(DECK.length, 52);
});

/* ------------------------------------------------------------------ poker */

const FAST = { actionMs: 1000, awayActionMs: 100, showdownPauseMs: 10, foldPauseMs: 10, levelMs: 60_000 };
const chips = (s) => s.players.reduce((a, p) => a + p.stack, 0) + (s.hand && s.hand.street !== "done" ? s.hand.contrib.reduce((a, c) => a + c, 0) : 0);

/* a random but legal action for the player to act */
function randomAction(s, rnd) {
  const L = poker.legal(s, s.hand.toAct);
  const r = rnd();
  if (L.raise && r < 0.25) return { type: "raise", to: L.raise.min + Math.floor(rnd() * (L.raise.max - L.raise.min + 1)) };
  if (L.raise && r < 0.3) return { type: "allin" };
  if (r < 0.45 && L.fold) return { type: "fold" };
  return L.check ? { type: "check" } : { type: "call" };
}

test("hold'em fuzz: thousands of random hands keep every chip, never go negative, and always finish", () => {
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  for (let game = 0; game < 120; game++) {
    const n = 2 + (game % 8);
    let now = 1_000_000;
    const s = poker.create({ n, now, opts: { ...FAST, startStack: 400 } });
    const total = n * 400;
    for (let step = 0; step < 20000 && !s.result; step++) {
      now += 50;
      if (s.hand.street === "done") { now = s.nextHandAt; poker.onTimer(s, now); }
      else if (rnd() < 0.03) { now = s.hand.actionDeadline; poker.onTimer(s, now); } // a timeout now and then
      else poker.act(s, s.hand.toAct, randomAction(s, rnd), now);
      assert.equal(chips(s), total, `game ${game} step ${step}: chips conserved`);
      for (const p of s.players) assert.ok(p.stack >= 0);
      if (s.hand && s.hand.street !== "done" && !s.result) {
        assert.ok(s.hand.toAct != null, "someone is to act during a hand");
        assert.ok(!s.players[s.hand.toAct].out && !s.hand.folded[s.hand.toAct] && !s.hand.allIn[s.hand.toAct]);
      }
    }
    assert.ok(s.result, `game ${game} (${n} players) finished`);
    const r = poker.result(s);
    const winners = r.scores.filter((x) => x >= 1_000_000);
    assert.equal(winners.length, 1, "exactly one player has every chip");
    assert.equal(s.players.find((p) => !p.out).stack, total);
    assert.deepEqual([...r.scores].filter((x) => x < 1_000_000).sort((a, b) => a - b), Array.from({ length: n - 1 }, (_, i) => i + 1), "places 1..n-1 for the players who went out");
  }
});

test("hold'em: the deck is committed before the deal and revealed after; hole cards come from that deck", () => {
  let now = 0;
  const s = poker.create({ n: 3, now, opts: FAST });
  const commit = s.hand.commit;
  const holes = s.hand.holes.map((h) => h.slice());
  const v0 = poker.view(s, 0, now);
  assert.equal(v0.commit, commit);
  const wire = JSON.stringify(v0);
  assert.ok(!wire.includes(s.hand.salt), "the salt is secret until the hand ends");
  for (const c of [...holes[1], ...holes[2]]) assert.ok(!new RegExp(`"${c}"`).test(wire), "nobody sees another player's cards");
  assert.deepEqual(v0.players[0].cards, holes[0]);
  assert.equal(v0.players[1].cards, null);
  // everyone folds to the big blind
  poker.act(s, s.hand.toAct, { type: "fold" }, ++now);
  poker.act(s, s.hand.toAct, { type: "fold" }, ++now);
  const last = s.last;
  assert.equal(last.reveal.commit, commit);
  assert.equal(crypto.createHash("sha256").update(last.reveal.deck.replace(/ /g, "") + ":" + last.reveal.salt).digest("hex"), commit);
  const deck = last.reveal.deck.split(" ");
  assert.equal(new Set(deck).size, 52);
  // dealt one at a time from the top, starting left of the button
  const order = [1, 2, 0].map((k) => (s.button + k) % 3);
  order.forEach((seat, k) => assert.deepEqual(holes[seat], [deck[k], deck[k + 3]]));
  assert.equal(poker.view(s, 1, now).players[0].cards, null, "a hand won without a showdown shows no cards");
});

test("hold'em: blinds and order (heads-up: the button posts the small blind and acts first before the flop)", () => {
  const s = poker.create({ n: 2, now: 0, opts: FAST, randInt: (k) => (k === 2 ? 0 : 0) });
  assert.equal(s.button, 0);
  assert.equal(s.hand.sbSeat, 0);
  assert.equal(s.hand.bbSeat, 1);
  assert.equal(s.hand.toAct, 0, "small blind (button) first preflop");
  assert.deepEqual([s.players[0].stack, s.players[1].stack], [1490, 1480]);
  poker.act(s, 0, { type: "call" }, 1);
  assert.equal(s.hand.toAct, 1, "the big blind gets the option");
  assert.throws(() => poker.act(s, 0, { type: "check" }, 2), { code: "ILLEGAL_ACTION" });
  poker.act(s, 1, { type: "check" }, 2);
  assert.equal(s.hand.street, "flop");
  assert.equal(s.hand.board.length, 3);
  assert.equal(s.hand.toAct, 1, "after the flop the big blind acts first heads-up");
  // a bet below the big blind is refused; the minimum raise is the last raise size
  assert.throws(() => poker.act(s, 1, { type: "raise", to: 10 }, 3), { code: "ILLEGAL_ACTION" });
  poker.act(s, 1, { type: "raise", to: 60 }, 3);
  assert.throws(() => poker.act(s, 0, { type: "raise", to: 100 }, 4), /smallest raise is to 120/);
  poker.act(s, 0, { type: "raise", to: 120 }, 4);
  poker.act(s, 1, { type: "fold" }, 5);
  assert.equal(s.hand.street, "done");
  assert.deepEqual([s.players[0].stack, s.players[1].stack], [1580, 1420], "the uncalled 60 went back; the pot was 40 + 60 + 60");
});

test("hold'em: side pots — a short all-in can only win what it covered", () => {
  const pots = poker.buildPots([100, 300, 300, 50], [false, false, false, true]);
  assert.deepEqual(pots, [{ amount: 350, eligible: [0, 1, 2] }, { amount: 400, eligible: [1, 2] }]);
  const pots2 = poker.buildPots([500, 200, 500], [false, false, false]);
  assert.deepEqual(pots2, [{ amount: 600, eligible: [0, 1, 2] }, { amount: 600, eligible: [0, 2] }]);
});

test("hold'em: a timeout checks when free, folds otherwise; two in a row mark a player away", () => {
  let now = 0;
  const s = poker.create({ n: 2, now, opts: FAST, randInt: () => 0 });
  const p = s.hand.toAct;
  poker.onTimer(s, s.hand.actionDeadline);
  assert.equal(s.hand.street, "done", "facing the big blind, a timeout folds");
  assert.equal(s.players[p].timeouts, 1);
  poker.onTimer(s, s.nextHandAt);
  now = s.hand.actionDeadline;
  if (s.hand.toAct === p) poker.onTimer(s, now);
  else { poker.act(s, s.hand.toAct, { type: "call" }, now); poker.onTimer(s, s.hand.actionDeadline); }
  assert.equal(s.players[p].timeouts, 2);
  assert.equal(s.players[p].away, true);
});

test("hold'em: forfeiting leaves the table; heads-up the other player wins at once", () => {
  const s = poker.create({ n: 3, now: 0, opts: FAST });
  poker.forfeit(s, s.hand.toAct, 1);
  assert.equal(s.result, null, "two players are left");
  assert.ok(s.hand.toAct != null);
  const left = s.players.filter((p) => !p.out);
  assert.equal(left.length, 2);
  poker.forfeit(s, left[0].seat, 2);
  assert.ok(s.result);
  const r = poker.result(s);
  assert.equal(r.scores.indexOf(Math.max(...r.scores)), left[1].seat);
});

test("hold'em: the time cap calls off the hand in play and ranks by chips", () => {
  const s = poker.create({ n: 2, now: 0, opts: FAST, randInt: () => 0 });
  poker.act(s, 0, { type: "raise", to: 100 }, 1);
  poker.finishNow(s);
  assert.deepEqual(s.players.map((p) => p.stack), [1500, 1500]);
  assert.deepEqual(poker.result(s), { scores: [1_001_500, 1_001_500], reason: "chips" });
});

/* ------------------------------------------------------------------ chess */

const move = (s, seat, uci, now) => chess.act(s, seat, { type: "move", from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] }, now);

test("chess: legal moves only, on your turn; checkmate ends it", () => {
  const s = chess.create({ n: 2, now: 0, randInt: () => 0 }); // seat 0 is white
  const W = 0, B = 1;
  assert.throws(() => move(s, B, "e7e5", 1), { code: "ILLEGAL_MOVE" }, "not black's turn");
  assert.throws(() => move(s, W, "e2e5", 1), { code: "ILLEGAL_MOVE" }, "not a legal move");
  assert.equal(chess.view(s, W, 1).legal.length, 20);
  assert.deepEqual(chess.view(s, B, 1).legal, [], "the side not to move gets no move list");
  move(s, W, "f2f3", 1000); move(s, B, "e7e5", 2000); move(s, W, "g2g4", 3000); move(s, B, "d8h4", 4000);
  assert.deepEqual(s.result, { winner: B, reason: "checkmate" });
  assert.deepEqual(chess.result(s).scores, [0, 1]);
  assert.equal(chess.view(s, W, 5000).check, "e1");
  assert.throws(() => move(s, W, "a2a3", 5000), { code: "ILLEGAL_MOVE" });
  assert.deepEqual(s.san, ["f3", "e5", "g4", "Qh4#"]);
});

test("chess: clocks run only for the side to move, add the increment, and flag at zero", () => {
  const s = chess.create({ n: 2, now: 0, randInt: () => 1, opts: { baseMs: 10_000, incMs: 1_000 } }); // seat 1 is white
  move(s, 1, "e2e4", 4_000);
  assert.deepEqual(chess.clocks(s, 4_000), [10_000, 7_000]);
  assert.deepEqual(chess.clocks(s, 6_000), [8_000, 7_000]);
  assert.equal(chess.deadline(s), 14_000);
  chess.onTimer(s, 13_999);
  assert.equal(s.result, null);
  chess.onTimer(s, 14_000);
  assert.deepEqual(s.result, { winner: 1, reason: "timeout" });
});

test("chess: a move that arrives after the flag loses on time", () => {
  const s = chess.create({ n: 2, now: 0, randInt: () => 0, opts: { baseMs: 1_000, incMs: 0 } });
  move(s, 0, "e2e4", 100);
  move(s, 1, "e7e5", 200); // black still has everything: white flagging now loses
  chess.act(s, 0, { type: "move", from: "d2", to: "d4" }, 5_000);
  assert.deepEqual(s.result, { winner: 1, reason: "timeout" }, "a move that arrives too late loses on time");
});

test("chess: draw by agreement, and a move declines a pending offer", () => {
  const s = chess.create({ n: 2, now: 0, randInt: () => 0 });
  chess.act(s, 0, { type: "draw-offer" }, 1);
  assert.equal(chess.view(s, 1, 1).drawOffer, 0);
  assert.throws(() => chess.act(s, 0, { type: "draw-accept" }, 2), { code: "ILLEGAL_MOVE" }, "you cannot accept your own offer");
  move(s, 0, "e2e4", 3);
  assert.equal(s.drawOffer, 0, "your own offer stands after your move");
  move(s, 1, "e7e5", 4);
  assert.equal(s.drawOffer, null, "the opponent moved instead of accepting");
  chess.act(s, 1, { type: "draw-offer" }, 5);
  chess.act(s, 0, { type: "draw-accept" }, 6);
  assert.deepEqual(s.result, { winner: null, reason: "agreement" });
  assert.deepEqual(chess.result(s).scores, [0.5, 0.5]);
});

test("chess: promotion, and the state survives a JSON round trip (a server restart)", () => {
  const s = chess.create({ n: 2, now: 0, randInt: () => 0, opts: { baseMs: 600_000 } });
  const line = ["a2a4", "b7b5", "a4b5", "a7a6", "b5a6", "c8b7", "a6b7", "g8f6"];
  line.forEach((m, i) => move(s, i % 2, m, 10 * (i + 1)));
  assert.ok(chess.view(s, 0, 100).legal.includes("b7a8q"));
  move(s, 0, "b7a8n", 100);
  assert.equal(s.san[s.san.length - 1], "bxa8=N");
  const restored = JSON.parse(JSON.stringify(s));
  chess.shift(restored, 5_000);
  assert.equal(chess.view(restored, 1, 5_200).fen, chess.view(s, 1, 200).fen);
  move(restored, 1, "e7e6", 5_300);
  assert.equal(restored.moves.length, 10);
});

test("chess: threefold repetition is a draw", () => {
  const s = chess.create({ n: 2, now: 0, randInt: () => 0 });
  const loop = ["g1f3", "g8f6", "f3g1", "f6g8"];
  let t = 0;
  for (let k = 0; k < 2; k++) loop.forEach((m, i) => move(s, i % 2, m, (t += 10)));
  assert.deepEqual(s.result, { winner: null, reason: "repetition" });
});
