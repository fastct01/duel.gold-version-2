/* Queueing, admission rules, no-shows, seed delivery, races and crash recovery. */
import test, { after } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { startApp, mETH, ETH, sleep } from "./helpers/app.js";
import { DuelClient } from "../client/duel-client.js";
import { ACCT } from "../src/ledger.js";

const apps = [];
const boot = async (over) => { const h = await startApp(over); apps.push(h); return h; };
after(async () => { for (const h of apps) await h.close().catch(() => {}); });

const STAKE = mETH;
const noMatch = (p, ms = 300) => sleep(ms).then(() => assert.equal(p.client.peek("match.found").length, 0, "should not have been matched"));
const setRating = (h, p, game, rating) => h.app.db.run("INSERT INTO ratings (user_id, game, rating, updated_at) VALUES (?, ?, ?, 0) ON CONFLICT(user_id, game) DO UPDATE SET rating = excluded.rating", p.id, game, rating);
const audit = (h) => assert.deepEqual(h.app.ledger.audit().problems, []);

/* ------------------------------------------------------------------ who meets whom */

test("only players with the same game and stake are paired", async () => {
  const h = await boot();
  const [a, b, c, d] = [await h.player(), await h.player(), await h.player(), await h.player()];
  await a.client.joinQueue({ game: "reaction", stake: String(STAKE) });
  await b.client.joinQueue({ game: "reaction", stake: String(STAKE * 2n) }); // different stake
  await c.client.joinQueue({ game: "aim", stake: String(STAKE) }); // different game
  await sleep(250);
  for (const p of [a, b, c]) assert.equal(p.client.peek("match.found").length, 0);
  await d.client.joinQueue({ game: "reaction", stake: String(STAKE) });
  const [fa, fd] = await Promise.all([a.client.waitFor("match.found"), d.client.waitFor("match.found")]);
  assert.equal(fa.match.id, fd.match.id);
  assert.equal(b.client.peek("match.found").length + c.client.peek("match.found").length, 0);
});

test("the rating window starts narrow and widens with waiting, up to a cap", async () => {
  const h = await boot({ match: { ratingBase: 50, ratingGrowthPerSec: 200, ratingMax: 500, queueTimeoutMs: 8000 } });
  const [a, b, far] = [await h.player(), await h.player(), await h.player()];
  setRating(h, a, "reaction", 1200); setRating(h, b, "reaction", 1500); setRating(h, far, "reaction", 2400);
  await a.client.joinQueue({ game: "reaction", stake: String(STAKE) });
  await b.client.joinQueue({ game: "reaction", stake: String(STAKE) });
  await noMatch(a, 400); // 300 apart, window is only 50
  const found = await a.client.waitFor("match.found", null, 5000); // window reaches ≥ 300 after ~2 s
  assert.equal(found.match.opponent.ratingBefore, 1500);
  await b.client.waitFor("match.found");
  await a.client.forfeit(found.match.id); await sleep(50);

  await far.client.joinQueue({ game: "reaction", stake: String(STAKE) });
  const x = await h.player(); setRating(h, x, "reaction", 1200);
  await x.client.joinQueue({ game: "reaction", stake: String(STAKE) });
  await sleep(2600); // window is capped at 500; 2400 vs 1200 is never fair
  assert.equal(far.client.peek("match.found").length, 0);
});

test("a private code pairs two friends of any rating, and never a stranger", async () => {
  const h = await boot();
  const [a, b, stranger] = [await h.player(), await h.player(), await h.player()];
  setRating(h, a, "aim", 900); setRating(h, b, "aim", 2100);
  await stranger.client.joinQueue({ game: "aim", stake: String(STAKE) }); // open queue, no code
  await a.client.joinQueue({ game: "aim", stake: String(STAKE), code: "friday7" });
  await noMatch(a);
  await noMatch(stranger, 0);
  await b.client.joinQueue({ game: "aim", stake: String(STAKE), code: "FRIDAY7" }); // codes are case-insensitive
  const [fa, fb] = await Promise.all([a.client.waitFor("match.found"), b.client.waitFor("match.found")]);
  assert.equal(fa.match.id, fb.match.id);
  assert.equal(fa.match.private, true);
  assert.equal(stranger.client.peek("match.found").length, 0);
});

test("one player cannot match themselves, and cannot be in two queues or matches", async () => {
  const h = await boot();
  const a = await h.player();
  const second = new DuelClient({ baseUrl: h.url, address: a.wallet.address, sign: (m) => a.wallet.signMessage(m) });
  second.token = a.client.token;
  await second.connect();
  await a.client.joinQueue({ game: "aim", stake: String(STAKE) });
  await assert.rejects(second.joinQueue({ game: "aim", stake: String(STAKE) }), { code: "ALREADY_ACTIVE" });
  await assert.rejects(a.client.joinQueue({ game: "reaction", stake: "0" }), { code: "ALREADY_ACTIVE" });
  await noMatch(a);
  assert.equal(a.bal(), 100n * mETH - STAKE, "only one stake is held");
  second.close();
});

test("leaving refunds the stake; the queue times out and refunds; a dropped connection cancels the ticket", async () => {
  const h = await boot({ match: { queueTimeoutMs: 400, disconnectQueueMs: 150 } });
  const a = await h.player();
  const full = a.bal();

  await a.client.joinQueue({ game: "aim", stake: String(STAKE) });
  assert.equal(a.bal(), full - STAKE);
  await a.client.leaveQueue();
  assert.equal(a.bal(), full);
  await assert.rejects(a.client.leaveQueue(), { code: "NOT_QUEUED" });

  await a.client.joinQueue({ game: "aim", stake: String(STAKE) });
  await a.client.waitFor("queue.expired", null, 3000);
  assert.equal(a.bal(), full, "expiry refunds");

  const b = await h.player();
  const fullB = b.bal();
  await b.client.joinQueue({ game: "aim", stake: String(STAKE) });
  b.client.close();
  await sleep(500);
  assert.equal(b.bal(), fullB, "a queued player who disconnects is not left holding a ghost ticket");
  assert.equal(h.app.db.get("SELECT state FROM tickets WHERE user_id = ? ORDER BY id DESC", b.id).state, "cancelled");
  audit(h);
});

/* ------------------------------------------------------------------ admission */

test("staking is refused unless it is allowed: age, cool-off, loss limit, funds, range, game, code", async () => {
  const h = await boot();
  const join = (p, o) => p.client.joinQueue({ game: "aim", stake: String(STAKE), ...o });

  const minor = await h.player({ adult: false });
  await assert.rejects(join(minor), { code: "AGE_NOT_CONFIRMED" });
  await minor.client.joinQueue({ game: "aim", stake: "0" }); // free play is fine
  await minor.client.leaveQueue();

  const cool = await h.player();
  await cool.client.api("POST", "/v1/me/cool-off", { hours: 24 });
  await assert.rejects(join(cool), { code: "COOL_OFF" });
  await cool.client.joinQueue({ game: "aim", stake: "0" });
  await cool.client.leaveQueue();

  const poor = await h.player({ fund: STAKE - 1n });
  await assert.rejects(join(poor), { code: "INSUFFICIENT_FUNDS" });
  assert.equal(poor.bal(), STAKE - 1n, "a refused join holds nothing");
  assert.equal(h.app.db.get("SELECT COUNT(*) AS n FROM tickets WHERE user_id = ?", poor.id).n, 0);

  const p = await h.player();
  await assert.rejects(join(p, { stake: "1" }), { code: "BAD_STAKE" });
  await assert.rejects(join(p, { stake: String(ETH) }), { code: "BAD_STAKE" });
  await assert.rejects(join(p, { stake: "1.5" }), { code: "BAD_AMOUNT" });
  await assert.rejects(join(p, { stake: "-5" }), { code: "BAD_AMOUNT" });
  await assert.rejects(join(p, { stake: "abc" }), { code: "BAD_AMOUNT" });
  await assert.rejects(join(p, { game: "nope" }), { code: "UNKNOWN_GAME" });
  await assert.rejects(join(p, { game: "chess" }), { code: "GAME_NOT_PVP" });
  await assert.rejects(join(p, { code: "no" }), { code: "BAD_CODE" });
  await assert.rejects(join(p, { code: "bad code!" }), { code: "BAD_CODE" });
  assert.equal(p.bal(), 100n * mETH);
});

test("the daily loss limit stops staking once losses use it up", async () => {
  const h = await boot();
  const a = await h.player(), b = await h.player();
  await a.client.api("PUT", "/v1/me/loss-limit", { amount: String(STAKE * 3n / 2n) }); // 1.5 stakes
  const lose = async () => {
    const m = await h.pair(a, b);
    await h.begin(a, b, m.id);
    await a.client.submit(m.id, 1);
    await b.client.submit(m.id, 2);
    await Promise.all([a.client.waitFor("match.result"), b.client.waitFor("match.result")]);
  };
  await lose(); // net −1 stake; 0.5 stake of room left
  const me = await a.client.api("GET", "/v1/me");
  assert.equal(me.responsible.lossToday, String(STAKE));
  assert.equal(me.responsible.lossRoom, String(STAKE / 2n));
  await assert.rejects(a.client.joinQueue({ game: "reaction", stake: String(STAKE) }), { code: "LOSS_LIMIT", extra: { room: String(STAKE / 2n) } });
  await a.client.joinQueue({ game: "reaction", stake: String(STAKE / 2n) }); // exactly the room left is fine
  await a.client.leaveQueue();
  await a.client.joinQueue({ game: "reaction", stake: "0" });
  await a.client.leaveQueue();
  const raise = await a.client.api("PUT", "/v1/me/loss-limit", { amount: String(ETH) });
  assert.equal(raise.applied, false, "raising a limit is delayed");
  await assert.rejects(a.client.joinQueue({ game: "reaction", stake: String(STAKE) }), { code: "LOSS_LIMIT" });
});

/* ------------------------------------------------------------------ no-shows and declines */

test("no-show: the match is voided, both refunded, and only the absent player gets a strike; three strikes = queue ban", async () => {
  const h = await boot({ match: { acceptMs: 250 } });
  const a = await h.player(), b = await h.player();
  const full = [a.bal(), b.bal()];
  for (let i = 0; i < 3; i++) {
    const m = await h.pair(a, b);
    await a.client.ready(m.id); // a shows up, b does not
    const [va, vb] = await Promise.all([a.client.waitFor("match.void", null, 3000), b.client.waitFor("match.void", null, 3000)]);
    assert.equal(va.match.reason, "no_show");
    assert.deepEqual([a.bal(), b.bal()], full, "everyone is refunded");
    assert.equal(h.app.users.byId(a.id).strikes, 0);
  }
  const bRow = h.app.users.byId(b.id);
  assert.equal(bRow.strikes, 0, "the third strike resets the counter and applies the ban");
  assert.ok(bRow.queue_ban_until > Date.now());
  await assert.rejects(b.client.joinQueue({ game: "reaction", stake: "0" }), { code: "QUEUE_BANNED" });
  await a.client.joinQueue({ game: "reaction", stake: "0" }); // a is unaffected
  audit(h);
});

test("declining a match you were paired into voids it, refunds both, and costs a strike", async () => {
  const h = await boot();
  const a = await h.player(), b = await h.player();
  const full = [a.bal(), b.bal()];
  const m = await h.pair(a, b);
  await b.client.forfeit(m.id);
  const [va] = await Promise.all([a.client.waitFor("match.void"), b.client.waitFor("match.void")]);
  assert.equal(va.match.reason, "declined");
  assert.deepEqual([a.bal(), b.bal()], full);
  assert.equal(h.app.users.byId(b.id).strikes, 1);
  assert.equal(h.app.users.byId(a.id).strikes, 0);
  audit(h);
});

/* ------------------------------------------------------------------ seed delivery and fair play */

test("the seed goes to exactly one socket per player and is never sent twice", async () => {
  const h = await boot();
  const a = await h.player(), b = await h.player();
  const a2 = new DuelClient({ baseUrl: h.url, address: a.wallet.address, sign: (m) => a.wallet.signMessage(m) });
  a2.token = a.client.token;
  await a2.connect();

  const m = await h.pair(a, b);
  await a.client.ready(m.id);
  await b.client.ready(m.id);
  const [seeded, mine] = await Promise.all([a.client.waitFor("match.start"), a2.waitFor("match.start")]);
  assert.ok(Number.isInteger(seeded.seed), "the socket that said ready gets the seed");
  assert.equal(mine.seed, null, "the player's other tab hears about the start but not the seed");
  assert.equal(seeded.startAt, mine.startAt);
  await b.client.waitFor("match.start");

  await assert.rejects(a.client.ready(m.id), { code: "SEED_ALREADY_SENT" });
  await assert.rejects(a2.ready(m.id), { code: "SEED_ALREADY_SENT" });

  // a reload / reconnect learns the state but not the seed
  a.client.close(); a2.close();
  const fresh = new DuelClient({ baseUrl: h.url, address: a.wallet.address, sign: (msg) => a.wallet.signMessage(msg) });
  fresh.token = a.client.token;
  await fresh.connect();
  const sync = await fresh.waitFor("sync");
  assert.equal(sync.me.active.kind, "match");
  assert.equal(sync.me.active.match.state, "playing");
  assert.equal(sync.me.active.match.you.seedDelivered, true);
  assert.equal(sync.me.active.match.seed, undefined, "no seed in a sync");
  assert.equal(JSON.stringify(sync).includes(String(seeded.seed)), false);
  await assert.rejects(fresh.ready(m.id), { code: "SEED_ALREADY_SENT" });
  // the running match's seed is also hidden from the REST view until it is over
  const rest = await fresh.api("GET", `/v1/matches/${m.id}`);
  assert.equal(rest.seed, undefined);
  fresh.close();
});

test("a player whose seed never arrived (nobody was connected at the start) can ask for it once", async () => {
  const h = await boot();
  const a = await h.player(), b = await h.player();
  const m = await h.pair(a, b);
  await a.client.ready(m.id);
  a.client.close(); // drops after ready, before the match starts
  await sleep(50);
  await b.client.ready(m.id);
  await b.client.waitFor("match.start");
  assert.equal(h.app.db.get("SELECT seed_sent FROM match_players WHERE match_id = ? AND user_id = ?", m.id, a.id).seed_sent, 0);

  const back = new DuelClient({ baseUrl: h.url, address: a.wallet.address, sign: (msg) => a.wallet.signMessage(msg) });
  back.token = a.client.token;
  await back.connect();
  const res = await back.ready(m.id);
  assert.equal(res.delivered, true);
  const start = await back.waitFor("match.start");
  assert.ok(Number.isInteger(start.seed));
  await assert.rejects(back.ready(m.id), { code: "SEED_ALREADY_SENT" });
  back.close();
});

test("live progress is relayed to the opponent only, and throttled", async () => {
  const h = await boot();
  const a = await h.player(), b = await h.player();
  const m = await h.pair(a, b);
  await h.begin(a, b, m.id);
  for (let i = 1; i <= 20; i++) a.client.progress(m.id, i * 10);
  await sleep(150);
  const got = b.client.peek("match.opponent_progress");
  assert.ok(got.length >= 1 && got.length < 20, `throttled (${got.length} of 20 relayed)`);
  assert.equal(a.client.peek("match.opponent_progress").length, 0, "you do not get your own progress back");
  await a.client.submit(m.id, 5);
  assert.ok((await b.client.waitFor("match.opponent_finished")).matchId === m.id);
  await b.client.submit(m.id, 1);
});

test("submissions are validated: timing, type, size, duplicates, and strangers", async () => {
  const h = await boot({ match: { countdownMs: 300 } });
  const a = await h.player(), b = await h.player(), c = await h.player();
  const m = await h.pair(a, b);
  await assert.rejects(a.client.submit(m.id, 5), { code: "MATCH_NOT_PLAYING" }, "before the match starts");
  await a.client.ready(m.id); await b.client.ready(m.id);
  await a.client.waitFor("match.start");
  await assert.rejects(a.client.submit(m.id, 5), { code: "TOO_EARLY" }, "before the countdown ends");
  await sleep(340);
  for (const bad of [NaN, Infinity, "12", null, undefined, 1e12, -1e12, {}, [1]]) {
    await assert.rejects(a.client.submit(m.id, bad), { code: "BAD_SCORE" }, String(bad));
  }
  await assert.rejects(c.client.submit(m.id, 5), { code: "NOT_FOUND" }, "a stranger cannot submit");
  await assert.rejects(c.client.forfeit(m.id), { code: "NOT_FOUND" });
  await assert.rejects(a.client.submit(999999, 5), { code: "NOT_FOUND" });
  await a.client.submit(m.id, 5, "x".repeat(10000)); // under the 16 KB frame limit, over the 2000-character detail cap
  assert.equal(h.app.db.get("SELECT length(detail) AS n FROM match_players WHERE match_id = ? AND user_id = ?", m.id, a.id).n, 2000, "detail is capped");
  await assert.rejects(a.client.submit(m.id, 9), { code: "ALREADY_SUBMITTED" });
  await b.client.submit(m.id, 1);

  // a frame over the transport limit closes the connection instead of being processed
  const big = await h.player();
  const closed = new Promise((resolve) => big.client.on("close", resolve));
  big.client.send("ping", { pad: "x".repeat(20000) });
  assert.equal((await closed).code, 1009);
});

test("racing a submit, a forfeit and the deadline settles the match exactly once", async () => {
  const h = await boot({ match: { durationScale: 0.001, graceMs: 60 } });
  const a = await h.player(), b = await h.player();
  const start = a.bal() + b.bal();
  const m = await h.pair(a, b);
  await h.begin(a, b, m.id);
  await Promise.allSettled([a.client.submit(m.id, 10), b.client.submit(m.id, 20), b.client.forfeit(m.id), a.client.forfeit(m.id)]);
  await sleep(300);
  const settles = h.app.db.get("SELECT COUNT(*) AS n FROM ledger_tx WHERE uniq IN (?, ?)", `match-settle:${m.id}`, `match-refund:${m.id}`).n;
  assert.equal(settles, 1, "one settlement, however the events interleaved");
  assert.equal(h.app.ledger.balance(ACCT.match(m.id)), 0n);
  assert.equal(a.bal() + b.bal() + h.house(), start, "no money created or destroyed");
  // the rating side of a settlement must also happen exactly once (a second pass would double-count it)
  const rows = h.app.db.all("SELECT user_id, rating, wins + losses + draws AS played FROM ratings ORDER BY user_id");
  assert.deepEqual(rows.map((r) => r.played), [1, 1], "each player has exactly one rated game");
  assert.equal(rows[0].rating + rows[1].rating, 2400, "rating points are conserved");
  assert.ok([1188, 1212].includes(rows[0].rating), `a single ±12 step, not compounded (got ${rows[0].rating})`);
  audit(h);
});

test("a submission that arrives after the deadline is refused even if the settle timer has not fired yet", async () => {
  const h = await boot({ match: { durationScale: 1, graceMs: 60000 } }); // long real deadline: the timer will not fire during the test
  const a = await h.player(), b = await h.player();
  const m = await h.pair(a, b);
  await h.begin(a, b, m.id);
  h.app.db.run("UPDATE matches SET submit_deadline = ? WHERE id = ?", Date.now() - 1, m.id); // the deadline has now passed
  await assert.rejects(a.client.submit(m.id, 5), { code: "TOO_LATE" });
  assert.equal(h.app.db.get("SELECT score FROM match_players WHERE match_id = ? AND user_id = ?", m.id, a.id).score, null, "nothing was recorded");
  await a.client.forfeit(m.id); // clean up: settles by forfeit
});

test("an implausibly high score is flagged for review but does not change the result", async () => {
  const h = await boot();
  const a = await h.player(), b = await h.player();
  const m = await h.pair(a, b);
  await h.begin(a, b, m.id);
  await a.client.submit(m.id, 9_000_000); // 'reaction' tops out around 5000
  await b.client.submit(m.id, 3000);
  const [ra] = await Promise.all([a.client.waitFor("match.result"), b.client.waitFor("match.result")]);
  assert.equal(ra.match.result, "win", "advisory only: the result stands");
  await h.app.matches.flagsSettled();
  const flags = h.app.matches.flagged();
  assert.equal(flags.length, 1);
  assert.equal(flags[0].user_id, a.id);
  assert.match(flags[0].flag, /3× the strongest bot/);
});

/* ------------------------------------------------------------------ crash recovery */

test("after a restart: queued tickets are refunded, unstarted matches voided, running matches still finish", async () => {
  const file = path.join(os.tmpdir(), `duel-recovery-${process.pid}-${Date.now()}.db`);
  const slow = { match: { durationScale: 0.01, graceMs: 400 } }; // ~0.3 s + 0.4 s deadline
  const h1 = await startApp({ dbPath: file, ...slow });
  const [q, f1, f2, r1, r2] = [await h1.player(), await h1.player(), await h1.player(), await h1.player(), await h1.player()];
  const funds = new Map([q, f1, f2, r1, r2].map((p) => [p.id, p.bal()]));

  await q.client.joinQueue({ game: "aim", stake: String(STAKE) }); // stays queued
  const found = await h1.pair(f1, f2, { game: "reaction" }); // found, nobody ready
  const running = await h1.pair(r1, r2, { game: "darts" });
  await h1.begin(r1, r2, running.id);
  await r1.client.submit(running.id, 700); // r2 never does
  await h1.close(); // "crash": no settlement happens on the way down

  const h2 = await startApp({ dbPath: file, ...slow });
  apps.push(h2);
  const at = h2.app;
  assert.equal(at.db.get("SELECT state FROM tickets WHERE user_id = ?", q.id).state, "cancelled");
  assert.equal(at.ledger.balance(ACCT.user(q.id)), funds.get(q.id), "the queued stake came back");
  assert.equal(at.db.get("SELECT state, reason FROM matches WHERE id = ?", found.id).reason, "server_restart");
  assert.equal(at.ledger.balance(ACCT.user(f1.id)), funds.get(f1.id));
  assert.equal(at.ledger.balance(ACCT.user(f2.id)), funds.get(f2.id));

  await sleep(1500); // the recovered deadline timer settles the running match: r1 had submitted, r2 had not
  const done = at.db.get("SELECT state, outcome, reason, winner_seat FROM matches WHERE id = ?", running.id);
  assert.deepEqual({ ...done }, { state: "settled", outcome: "win", reason: "timeout", winner_seat: 0 });
  assert.ok(at.ledger.balance(ACCT.user(r1.id)) > funds.get(r1.id));
  assert.equal(at.ledger.balance(ACCT.user(r2.id)), funds.get(r2.id) - STAKE);
  assert.deepEqual(at.ledger.audit().problems, []);
  fs.rmSync(file, { force: true }); fs.rmSync(file + "-wal", { force: true }); fs.rmSync(file + "-shm", { force: true });
});
