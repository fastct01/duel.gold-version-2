/* GET /v1/lobby: public, anonymous live activity (queues, running matches, recent results). */
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { startApp, mETH, sleep } from "./helpers/app.js";

const apps = [];
const boot = async (over = {}) => { const h = await startApp({ ...over, match: { lobbyCacheMs: 0, ...(over.match || {}) } }); apps.push(h); return h; };
after(async () => { for (const h of apps) await h.close().catch(() => {}); });

const lobby = async (h) => {
  const res = await fetch(`${h.url}/v1/lobby`);
  assert.equal(res.status, 200);
  return res.json();
};

test("an empty lobby has the documented shape", async () => {
  const h = await boot();
  const l = await lobby(h);
  assert.equal(typeof l.at, "number");
  assert.deepEqual({ online: l.online, playing: l.playing, games: l.games, recent: l.recent }, { online: 0, playing: 0, games: [], recent: [] });
});

test("online counts distinct connected players", async () => {
  const h = await boot();
  const a = await h.player();
  await h.player();
  await h.player({ connect: false });
  assert.equal((await lobby(h)).online, 2);
  a.client.close();
  await sleep(100);
  assert.equal((await lobby(h)).online, 1);
});

test("a public ticket shows up under its game and stake; a private-code ticket does not", async () => {
  const h = await boot({ match: { queueTimeoutMs: 20000 } });
  const [a, b, c, d] = [await h.player(), await h.player(), await h.player(), await h.player()];
  await a.client.joinQueue({ game: "reaction", stake: String(mETH) });
  let l = await lobby(h);
  assert.deepEqual(l.games, [{ game: "reaction", waiting: 1, playing: 0, stakes: [{ stake: String(mETH), waiting: 1 }] }]);

  await b.client.joinQueue({ game: "aim", stake: "0", code: "FRIENDS1" }); // private: invisible
  await c.client.joinQueue({ game: "aim", stake: String(mETH * 2n) });
  await d.client.joinQueue({ game: "aim", stake: "0" });
  l = await lobby(h);
  assert.equal(l.games.length, 2);
  assert.equal(l.games[0].game, "aim"); // sorted by waiting, ties by playing
  assert.equal(l.games[0].waiting, 2);
  assert.deepEqual(l.games[0].stakes, [{ stake: "0", waiting: 1 }, { stake: String(mETH * 2n), waiting: 1 }]);
  assert.equal(l.games[1].game, "reaction");

  const text = JSON.stringify(l);
  for (const p of [a, b, c, d]) { assert.ok(!text.includes(p.address)); assert.ok(!text.includes(p.client.me.address.toLowerCase())); }
  assert.ok(!text.includes("FRIENDS1"));
  await a.client.leaveQueue?.().catch(() => {});
});

test("a private match is not counted as playing or recent", async () => {
  const h = await boot();
  const [a, b] = [await h.player(), await h.player()];
  const m = await h.pair(a, b, { code: "SECRET99" });
  await h.begin(a, b, m.id);
  const l = await lobby(h);
  assert.equal(l.playing, 0);
  await b.client.forfeit(m.id);
  await sleep(50);
  assert.deepEqual((await lobby(h)).recent, []);
});

test("a running match counts in playing, then lands in recent with the winner's name only", async () => {
  const h = await boot();
  const [a, b] = [await h.player({ name: "Alice" }), await h.player({ name: "Bob" })];
  const m = await h.pair(a, b, { game: "reaction", stake: mETH });
  let l = await lobby(h);
  assert.equal(l.playing, 1, "accepting counts as in progress");
  assert.deepEqual(l.games, [{ game: "reaction", waiting: 0, playing: 1, stakes: [] }]);
  await h.begin(a, b, m.id);
  assert.equal((await lobby(h)).playing, 1);
  assert.deepEqual((await lobby(h)).recent, []);

  await b.client.forfeit(m.id); // Alice wins
  await sleep(50);
  l = await lobby(h);
  assert.equal(l.playing, 0);
  assert.deepEqual(l.games, []);
  assert.equal(l.recent.length, 1);
  const [r] = l.recent;
  assert.equal(r.id, m.id);
  assert.equal(r.game, "reaction");
  assert.equal(r.stake, String(mETH));
  assert.equal(r.pot, String(mETH * 2n));
  assert.deepEqual(r.winner, { name: "Alice" });
  assert.equal(r.result, "win");
  assert.equal(typeof r.endedAt, "number");
  assert.deepEqual(Object.keys(r).sort(), ["endedAt", "game", "id", "pot", "result", "stake", "winner"]);
  const text = JSON.stringify(l).toLowerCase();
  for (const p of [a, b]) assert.ok(!text.includes(p.address.slice(2)));
  console.log("lobby example:", JSON.stringify(l));
});

test("a void (never started) match is not listed in recent", async () => {
  const h = await boot({ match: { acceptMs: 150 } });
  const [a, b] = [await h.player(), await h.player()];
  const m = await h.pair(a, b);
  await sleep(400); // nobody accepts: voided and refunded
  assert.equal(h.app.db.get("SELECT outcome FROM matches WHERE id = ?", m.id).outcome, "void");
  const l = await lobby(h);
  assert.deepEqual(l.recent, []);
  assert.equal(l.playing, 0);
});

test("the snapshot is served from a short cache, and recent is capped at 8 newest first", async () => {
  const h = await boot({ match: { lobbyCacheMs: 60000 } });
  const first = await lobby(h);
  const [a, b] = [await h.player(), await h.player()];
  await a.client.joinQueue({ game: "reaction", stake: "0" });
  const l = await lobby(h);
  assert.equal(l.games.length, 1, "queue counts are always live");
  assert.equal(l.playing, first.playing);

  const h2 = await boot();
  for (let i = 0; i < 9; i++) {
    const [c, d] = [await h2.player(), await h2.player()]; // fresh players: repeated forfeits would earn a queue ban
    const m = await h2.pair(c, d, { stake: 0n });
    await h2.begin(c, d, m.id);
    await d.client.forfeit(m.id);
    await sleep(30);
  }
  const { recent } = await lobby(h2);
  assert.equal(recent.length, 8);
  assert.deepEqual(recent.map((r) => r.id), [...recent.map((r) => r.id)].sort((x, y) => y - x));
  void b;
});
