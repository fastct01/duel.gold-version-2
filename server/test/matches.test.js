/* Player-vs-player matches over real WebSockets: outcomes, money, ratings. */
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { startApp, mETH, ETH, sleep } from "./helpers/app.js";
import { ACCT } from "../src/ledger.js";

const apps = [];
const boot = async (over) => { const h = await startApp(over); apps.push(h); return h; };
after(async () => { for (const h of apps) await h.close(); });

/* Expected amounts are written out by hand on purpose: deriving them with the code under test would make the
   assertions pass no matter what that code did. */
const STAKE = 1_000_000_000_000_000n; // 0.001 ETH in wei
const POT = 2_000_000_000_000_000n;
const PAYOUT = 1_800_000_000_000_000n; // pot − 10%
const FEE = 200_000_000_000_000n;

const audit = (h) => { const a = h.app.ledger.audit(); assert.deepEqual(a.problems, []); return a; };

/* ------------------------------------------------------------------ money + outcome */

test("1v1 staked match: higher score wins pot minus 10%, loser loses the stake, ratings move ±12", async () => {
  const h = await boot();
  const alice = await h.player({ name: "Alice" }), bob = await h.player({ name: "Bob" });
  const before = { a: alice.bal(), b: bob.bal() };

  const m = await h.pair(alice, bob);
  assert.equal(m.a.state, "found");
  assert.equal(m.a.stake, String(STAKE));
  assert.equal(m.a.pot, String(POT));
  assert.equal(m.a.winnerPayout, String(PAYOUT));
  assert.equal(m.a.opponent.name, "Bob");
  assert.equal(m.b.opponent.name, "Alice");
  assert.equal(alice.bal(), before.a - STAKE, "stake leaves the spendable balance the moment a match is found");
  assert.equal(h.app.ledger.balance(ACCT.match(m.id)), POT, "both stakes sit in the match escrow");

  const { a: sa, b: sb } = await h.begin(alice, bob, m.id);
  assert.equal(sa.seed, sb.seed, "both players get the identical seed");
  assert.ok(Number.isInteger(sa.seed) && sa.seed >= 100000);
  assert.equal(sa.game, "reaction");

  await alice.client.submit(m.id, 4200, "<b>4200</b>");
  await bob.client.submit(m.id, 3900);
  const [ra, rb] = await Promise.all([alice.client.waitFor("match.result"), bob.client.waitFor("match.result")]);

  assert.equal(ra.match.result, "win");
  assert.equal(rb.match.result, "loss");
  assert.equal(ra.match.you.score, 4200);
  assert.equal(ra.match.opponent.score, 3900, "the opponent's score is revealed once the match is over");
  assert.equal(ra.match.seed, sa.seed, "the seed is revealed afterwards so the match can be audited");
  assert.equal(ra.match.you.payout, String(PAYOUT));
  assert.equal(rb.match.you.payout, "0");
  assert.equal(ra.match.you.ratingAfter - ra.match.you.ratingBefore, 12);
  assert.equal(rb.match.you.ratingAfter - rb.match.you.ratingBefore, -12);

  assert.equal(alice.bal(), before.a - STAKE + PAYOUT);
  assert.equal(bob.bal(), before.b - STAKE);
  assert.equal(h.house(), FEE);
  assert.equal(h.app.ledger.balance(ACCT.match(m.id)), 0n, "escrow is empty after settlement");
  assert.equal(PAYOUT + FEE, POT);
  audit(h);

  const board = await alice.client.api("GET", "/v1/leaderboard?game=reaction");
  assert.deepEqual(board.players.map((p) => [p.player.name, p.rating, p.wins, p.losses]), [["Alice", 1212, 1, 0], ["Bob", 1188, 0, 1]]);
});

test("a draw refunds both stakes with no fee and no rating change", async () => {
  const h = await boot();
  const a = await h.player(), b = await h.player();
  const before = [a.bal(), b.bal()];
  const m = await h.pair(a, b);
  await h.begin(a, b, m.id);
  await a.client.submit(m.id, 1000);
  await b.client.submit(m.id, 1000);
  const [ra] = await Promise.all([a.client.waitFor("match.result"), b.client.waitFor("match.result")]);
  assert.equal(ra.match.result, "draw");
  assert.equal(ra.match.you.ratingAfter, ra.match.you.ratingBefore);
  assert.deepEqual([a.bal(), b.bal()], before);
  assert.equal(h.house(), 0n);
  audit(h);
});

test("only one player submits: they win when the deadline passes", async () => {
  const h = await boot();
  const a = await h.player(), b = await h.player();
  const before = [a.bal(), b.bal()];
  const m = await h.pair(a, b);
  await h.begin(a, b, m.id);
  await a.client.submit(m.id, 500);
  const [ra, rb] = await Promise.all([a.client.waitFor("match.result", null, 5000), b.client.waitFor("match.result", null, 5000)]);
  assert.equal(ra.match.result, "win");
  assert.equal(ra.match.reason, "timeout");
  assert.equal(rb.match.result, "loss");
  assert.equal(a.bal(), before[0] - STAKE + PAYOUT);
  assert.equal(b.bal(), before[1] - STAKE);
  audit(h);
});

test("nobody submits: the match is void and everyone is refunded", async () => {
  const h = await boot();
  const a = await h.player(), b = await h.player();
  const before = [a.bal(), b.bal()];
  const m = await h.pair(a, b);
  await h.begin(a, b, m.id);
  const [va, vb] = await Promise.all([a.client.waitFor("match.void", null, 5000), b.client.waitFor("match.void", null, 5000)]);
  assert.equal(va.match.reason, "no_result");
  assert.equal(vb.match.result, "void");
  assert.deepEqual([a.bal(), b.bal()], before);
  assert.equal(h.house(), 0n);
  assert.equal((await a.client.api("GET", "/v1/me")).ratings.length, 0, "a void match rates nobody");
  audit(h);
});

test("forfeit during play loses immediately; the opponent is paid without finishing", async () => {
  const h = await boot();
  const a = await h.player(), b = await h.player();
  const before = [a.bal(), b.bal()];
  const m = await h.pair(a, b);
  await h.begin(a, b, m.id);
  await b.client.forfeit(m.id);
  const [ra, rb] = await Promise.all([a.client.waitFor("match.result"), b.client.waitFor("match.result")]);
  assert.equal(ra.match.result, "win");
  assert.equal(ra.match.reason, "forfeit");
  assert.equal(rb.match.result, "loss");
  assert.equal(a.bal(), before[0] - STAKE + PAYOUT);
  assert.equal(b.bal(), before[1] - STAKE);
  audit(h);
});

test("free play (stake 0) moves no money but still rates players", async () => {
  const h = await boot();
  const a = await h.player({ fund: 0n, adult: false }), b = await h.player({ fund: 0n, adult: false });
  const m = await h.pair(a, b, { stake: 0n });
  assert.equal(m.a.stake, "0");
  await h.begin(a, b, m.id);
  await a.client.submit(m.id, 10);
  await b.client.submit(m.id, 20);
  const [ra, rb] = await Promise.all([a.client.waitFor("match.result"), b.client.waitFor("match.result")]);
  assert.equal(rb.match.result, "win");
  assert.equal(ra.match.you.ratingAfter, 1188);
  assert.equal(h.app.db.get("SELECT COUNT(*) AS n FROM ledger_tx WHERE kind LIKE 'match%' OR kind LIKE 'stake%'").n, 0, "no ledger activity at all");
  assert.equal(a.bal() + b.bal(), 0n);
});

test("players can go again straight after a match and payouts add up", async () => {
  const h = await boot();
  const a = await h.player(), b = await h.player();
  const start = a.bal() + b.bal();
  for (let round = 0; round < 3; round++) {
    const m = await h.pair(a, b);
    await h.begin(a, b, m.id);
    await (round % 2 ? b : a).client.submit(m.id, 900);
    await (round % 2 ? a : b).client.submit(m.id, 100);
    await Promise.all([a.client.waitFor("match.result"), b.client.waitFor("match.result")]);
  }
  assert.equal(a.bal() + b.bal() + h.house(), start, "money is conserved: players + fees = what they started with");
  assert.equal(h.house(), FEE * 3n);
  audit(h);
});

test("the pot arithmetic is exact for odd stakes", async () => {
  const h = await boot();
  const a = await h.player(), b = await h.player();
  const odd = 1234567890123457n; // wei, odd
  const before = a.bal() + b.bal();
  const m = await h.pair(a, b, { stake: odd });
  await h.begin(a, b, m.id);
  await a.client.submit(m.id, 2);
  await b.client.submit(m.id, 1);
  await Promise.all([a.client.waitFor("match.result"), b.client.waitFor("match.result")]);
  const payout = (odd * 2n * 9n) / 10n; // the product rule: floor(2 × stake × 0.9)
  const fee = odd * 2n - payout; // the fee takes the rounding remainder
  assert.equal(payout, 2222222202222222n, "floor, not round (exact value 2222222202222222.6, computed independently)");
  assert.equal(h.house(), fee);
  assert.equal(a.bal() - (before / 2n - odd), payout);
  assert.equal(a.bal() + b.bal() + h.house(), before);
  audit(h);
});

test("match history and detail are visible to the players only", async () => {
  const h = await boot();
  const a = await h.player(), b = await h.player(), c = await h.player();
  const m = await h.pair(a, b);
  await h.begin(a, b, m.id);
  await a.client.submit(m.id, 5);
  await b.client.submit(m.id, 4);
  await Promise.all([a.client.waitFor("match.result"), b.client.waitFor("match.result")]);
  const hist = await a.client.api("GET", "/v1/matches");
  assert.equal(hist.matches.length, 1);
  assert.equal(hist.matches[0].id, m.id);
  assert.equal(hist.matches[0].result, "win");
  const one = await b.client.api("GET", `/v1/matches/${m.id}`);
  assert.equal(one.result, "loss");
  await assert.rejects(c.client.api("GET", `/v1/matches/${m.id}`), { code: "NOT_FOUND", status: 404 });
  assert.equal((await c.client.api("GET", "/v1/matches")).matches.length, 0);
});
