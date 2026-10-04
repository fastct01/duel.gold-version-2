/* Invite-only play (no public queue, no player search) and the 18+ attestation required for staked lobbies. */
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startApp, mETH } from "./helpers/app.js";
import { ACCT } from "../src/ledger.js";
import { MIGRATIONS } from "../src/db/schema.js";
import { Db } from "../src/db/index.js";

const apps = [];
const boot = async (over) => { const h = await startApp(over); apps.push(h); return h; };
after(async () => { for (const h of apps) await h.close().catch(() => {}); });

const STAKE = mETH;
const GAME = "reaction";
const staked = (p, stake = STAKE) => p.client.createLobby({ game: GAME, stake: String(stake) });
const audit = (h) => assert.deepEqual(h.app.ledger.audit().problems, []);
const rest = (h, method, path, token, body) => fetch(h.url + path, {
  method, headers: { ...(body ? { "content-type": "application/json" } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined,
});

/* ================================================================== no public matchmaking */

test("the queue is gone: WS queue.join / queue.leave are unknown commands, nothing is held", async () => {
  const h = await boot();
  const p = await h.player();
  const before = p.bal();
  for (const type of ["queue.join", "queue.leave"]) {
    await assert.rejects(p.client.request(type, { game: GAME, stake: String(STAKE) }), { code: "UNKNOWN_TYPE" }, type);
  }
  assert.equal(p.bal(), before, "no stake was taken");
  assert.equal(h.app.db.get("SELECT COUNT(*) AS n FROM tickets").n, 0);
  // a code does not bring it back
  await assert.rejects(p.client.request("queue.join", { game: GAME, stake: "0", code: "FRIEND12" }), { code: "UNKNOWN_TYPE" });
});

test("the queue is gone over HTTP too: POST and DELETE /v1/queue are 404", async () => {
  const h = await boot();
  const p = await h.player({ connect: false });
  for (const [method, body] of [["POST", { game: GAME, stake: "0" }], ["DELETE", undefined], ["GET", undefined], ["POST", { game: GAME, stake: "0", code: "FRIEND12" }]]) {
    const r = await rest(h, method, "/v1/queue", p.client.token, body);
    assert.equal(r.status, 404, `${method} /v1/queue`);
    assert.equal((await r.json()).error.code, "NOT_FOUND");
  }
  assert.equal(h.app.db.get("SELECT COUNT(*) AS n FROM tickets").n, 0);
});

test("the queue events, SDK methods and service methods no longer exist", async () => {
  const h = await boot();
  const p = await h.player();
  assert.equal(typeof p.client.joinQueue, "undefined");
  assert.equal(typeof p.client.leaveQueue, "undefined");
  assert.equal(typeof h.app.matches.join, "undefined");
  assert.equal(typeof h.app.matches.leave, "undefined");
  assert.equal(typeof h.app.matches.lobby, "undefined");
  assert.equal(fs.existsSync(new URL("../src/matches/queue.js", import.meta.url)), false, "the pairing module is deleted");
  assert.equal((await p.client.api("GET", "/v1/me")).active, null, "nothing is queued, ever");
});

test("the public activity endpoint is gone: no counts of who is waiting, no list of recent winners", async () => {
  const h = await boot();
  const a = await h.player();
  await staked(a);
  for (const path of ["/v1/lobby", "/v1/lobby/"]) {
    const r = await fetch(h.url + path);
    assert.equal(r.status, 404, path);
  }
});

test("there is no endpoint that lists or searches players, lobbies or matches; only a code opens a lobby", async () => {
  const h = await boot();
  const a = await h.player(), b = await h.player({ name: "Findable" });
  const lobby = await staked(a);
  const probes = [
    ["GET", "/v1/players"], ["GET", "/v1/players?q=Findable"], ["GET", "/v1/players/search?q=Findable"], ["GET", `/v1/players/${b.id}`],
    ["GET", "/v1/users"], ["GET", `/v1/users/${b.id}`], ["GET", "/v1/users?name=Findable"], ["GET", "/v1/search?q=Findable"], ["GET", "/v1/online"],
    ["GET", "/v1/lobbies"], ["GET", "/v1/lobbies?game=reaction"], ["GET", "/v1/lobbies/open"], ["GET", "/v1/matches/open"], ["GET", "/v1/matchmaking"],
    ["POST", "/v1/challenge"], ["POST", `/v1/players/${b.id}/challenge`], ["POST", "/v1/invite"], ["POST", "/v1/matches"], ["POST", "/v1/friends"], ["GET", "/v1/friends"],
  ];
  for (const [method, path] of probes) {
    const r = await rest(h, method, path, a.client.token, method === "POST" ? { opponent: b.id, userId: b.id } : undefined);
    assert.equal(r.status, 404, `${method} ${path} must not exist`);
  }
  // the one place a lobby can be found is its own code; a wrong or guessed one is just "not found"
  assert.equal((await fetch(`${h.url}/v1/lobbies/${lobby.code}`)).status, 200);
  for (const code of ["AAAAAAAA", "ABCD2345", "short", "0O1IL000", `${lobby.code}X`]) {
    const r = await fetch(`${h.url}/v1/lobbies/${code}`);
    assert.equal(r.status, 404, code);
  }
  await assert.rejects(b.client.joinLobby("ABCD2345"), { code: "LOBBY_NOT_FOUND" });
  // a lobby request cannot be aimed at a person: extra fields are ignored and the lobby is still code-only
  const aimed = await b.client.api("POST", "/v1/lobbies", { game: GAME, stake: "0", invite: a.id, opponent: a.id, to: a.address });
  assert.ok(aimed.lobby.code);
  assert.equal(a.client.peek("lobby.updated").length + a.client.peek("match.found").length, 0, "nobody was pulled in");
});

test("the leaderboard stays, and offers no way to find or challenge anyone", async () => {
  const h = await boot();
  const [a, b] = [await h.player({ name: "Alpha" }), await h.player({ name: "Bravo" })];
  const m = await h.pair(a, b);
  await h.begin(a, b, m.id);
  await a.client.submit(m.id, 5000);
  await b.client.submit(m.id, 10);
  await Promise.all([a.client.waitFor("match.result"), b.client.waitFor("match.result")]);
  const board = await fetch(`${h.url}/v1/leaderboard?game=${GAME}`).then((r) => r.json());
  assert.equal(board.players.length, 2);
  assert.deepEqual(Object.keys(board.players[0]).sort(), ["draws", "losses", "player", "rank", "rating", "wins"]);
  // names, a public id and a shortened address only: never a full address, and no endpoint takes that id to start a match
  const text = JSON.stringify(board);
  assert.ok(!text.toLowerCase().includes(a.address) && !text.toLowerCase().includes(b.address), "no full wallet address");
  b.client.clearBuffer();
  const r = await rest(h, "POST", "/v1/lobbies", a.client.token, { game: GAME, stake: "0", opponent: board.players[1].player.id });
  assert.equal(r.status, 201);
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(b.client.peek().length, 0, "naming a player in the request reaches nobody");
});

test("lobbies are untouched: create, join by code, leave, start and close all still work", async () => {
  const h = await boot();
  const [host, g1, g2] = [await h.player(), await h.player(), await h.player()];
  const { code } = await staked(host);
  assert.equal((await g1.client.joinLobby(code)).lobby.playerCount, 2);
  assert.equal((await g2.client.joinLobby(code)).lobby.playerCount, 3);
  assert.equal((await g2.client.leaveLobby(code)).closedReason, "left");
  const m = await host.client.startLobby(code);
  assert.equal(m.playerCount, 2);
  await Promise.all([host, g1].map((p) => p.client.waitFor("match.found")));
  const { code: second } = await staked(g2);
  assert.equal((await g2.client.closeLobby(second)).state, "closed");
  assert.equal(g2.bal(), 100n * mETH, "closing refunded the stake");
  audit(h);
});

/* ================================================================== 18+ attestation */

test("POST /v1/me/age records the attestation; only an explicit adult:true counts", async () => {
  const h = await boot();
  const p = await h.player({ adult: false });
  assert.equal((await p.client.api("GET", "/v1/me")).responsible.adultConfirmed, false);
  assert.equal(p.client.me.responsible.adultConfirmed, false, "also in the login response");
  for (const body of [{ adult: false }, {}, { adult: "true" }, { adult: 1 }, { adult: null }, { age: 30 }]) {
    await assert.rejects(p.client.api("POST", "/v1/me/age", body), { code: "BAD_REQUEST", status: 400 }, JSON.stringify(body));
  }
  assert.equal((await p.client.api("GET", "/v1/me")).responsible.adultConfirmed, false, "nothing was recorded");
  assert.equal((await rest(h, "POST", "/v1/me/age", null, { adult: true })).status, 401, "needs a signed-in player");

  const out = await p.client.api("POST", "/v1/me/age", { adult: true });
  assert.equal(out.adultConfirmed, true);
  assert.equal((await p.client.api("GET", "/v1/me")).responsible.adultConfirmed, true);
  assert.equal((await p.client.request("sync")).me.responsible.adultConfirmed, true, "over the socket too");
  const at = h.app.db.get("SELECT age_attested_at AS t FROM users WHERE id = ?", p.id).t;
  assert.ok(at > 0);
  await p.client.api("POST", "/v1/me/age", { adult: true });
  assert.equal(h.app.db.get("SELECT age_attested_at AS t FROM users WHERE id = ?", p.id).t, at, "the first attestation time is kept");
});

test("a staked lobby cannot be created without the attestation: 403 AGE_NOT_CONFIRMED, nothing held; a free one can", async () => {
  const h = await boot();
  const p = await h.player({ adult: false });
  const before = p.bal();
  await assert.rejects(staked(p), { code: "AGE_NOT_CONFIRMED", status: 403 });
  await assert.rejects(p.client.request("lobby.create", { game: GAME, stake: String(STAKE) }), { code: "AGE_NOT_CONFIRMED" }, "over the socket");
  assert.equal(p.bal(), before);
  assert.equal(h.app.db.get("SELECT COUNT(*) AS n FROM tickets WHERE user_id = ?", p.id).n, 0);

  const free = await p.client.createLobby({ game: GAME, stake: "0" }); // free play needs nothing
  assert.equal(free.state, "open");
  await p.client.closeLobby(free.code);

  await p.client.api("POST", "/v1/me/age", { adult: true });
  const real = await staked(p);
  assert.equal(real.stake, String(STAKE));
  assert.equal(p.bal(), before - STAKE);
  audit(h);
});

test("the age check comes before the balance and loss-limit checks", async () => {
  const h = await boot();
  const poor = await h.player({ adult: false, fund: 0n });
  await assert.rejects(staked(poor), { code: "AGE_NOT_CONFIRMED" }, "not INSUFFICIENT_FUNDS");
  const limited = await h.player({ adult: false });
  await limited.client.api("PUT", "/v1/me/loss-limit", { amount: "1" });
  await assert.rejects(staked(limited), { code: "AGE_NOT_CONFIRMED" }, "not LOSS_LIMIT");
  await limited.client.api("POST", "/v1/me/age", { adult: true });
  await assert.rejects(staked(limited), { code: "LOSS_LIMIT" }, "once confirmed, the daily loss limit still applies");
});

test("joining a staked lobby needs the attestation; joining a free one does not", async () => {
  const h = await boot();
  const host = await h.player(), minor = await h.player({ adult: false });
  const real = await staked(host);
  const free = await host.client.api("POST", "/v1/lobbies", { game: GAME, stake: "0" }).catch((e) => e);
  assert.equal(free.code, "ALREADY_ACTIVE", "one lobby per host");
  await assert.rejects(minor.client.joinLobby(real.code), { code: "AGE_NOT_CONFIRMED", status: 403 });
  await assert.rejects(minor.client.request("lobby.join", { code: real.code }), { code: "AGE_NOT_CONFIRMED" }, "over the socket");
  assert.equal(minor.bal(), 100n * mETH, "no stake was taken");
  assert.equal((await host.client.getLobby(real.code)).playerCount, 1, "the guest is not on the roster");
  assert.equal(host.client.peek("lobby.updated").length, 0);

  await host.client.closeLobby(real.code);
  const freeLobby = await host.client.createLobby({ game: GAME, stake: "0" });
  const out = await minor.client.joinLobby(freeLobby.code);
  assert.equal(out.lobby.playerCount, 2, "free play: no attestation needed");
  await host.client.startLobby(freeLobby.code);
  await Promise.all([host, minor].map((p) => p.client.waitFor("match.found")));
  audit(h);
});

test("starting a staked lobby needs the host's attestation too", async () => {
  const h = await boot();
  const [host, guest] = [await h.player(), await h.player()];
  const lobby = await staked(host);
  await guest.client.joinLobby(lobby.code);
  // an attestation that is missing at start time (an account that predates it, or one reset by an operator)
  h.app.db.run("UPDATE users SET age_attested_at = NULL WHERE id = ?", host.id);
  await assert.rejects(host.client.startLobby(lobby.code), { code: "AGE_NOT_CONFIRMED", status: 403 });
  await assert.rejects(host.client.request("lobby.start", { code: lobby.code }), { code: "AGE_NOT_CONFIRMED" });
  assert.equal((await host.client.getLobby(lobby.code)).state, "open", "the lobby is still open and intact");
  assert.equal(h.app.ledger.balance(ACCT.ticket(1)) + h.app.ledger.balance(ACCT.ticket(2)), STAKE * 2n);
  await host.client.api("POST", "/v1/me/age", { adult: true });
  assert.equal((await host.client.startLobby(lobby.code)).playerCount, 2);
  // a stranger asking to start someone else's lobby still hears "not the host", not an age error
  const other = await h.player({ adult: false });
  const free = await other.client.createLobby({ game: GAME, stake: "0" });
  await assert.rejects(host.client.startLobby(free.code), { code: "LOBBY_NOT_HOST" });
  audit(h);
});

test("a lobby that fills up starts by itself once every member is attested", async () => {
  const h = await boot({ match: { lobbyMaxPlayers: 2 } });
  const [host, guest] = [await h.player(), await h.player()];
  const lobby = await staked(host);
  const out = await guest.client.joinLobby(lobby.code);
  assert.equal(out.match.state, "found", "the lobby filled and started");
});

/* ================================================================== the age column comes from a new migration */

test("age_attested_at is added by a new migration, and a database that still has the old column upgrades cleanly", async () => {
  assert.ok(MIGRATIONS.length >= 6);
  const { DatabaseSync } = await import("node:sqlite");
  const tmp = (n) => path.join(os.tmpdir(), `duel-age-${n}-${process.pid}-${Date.now()}.db`);
  const clean = (f) => { for (const x of [f, f + "-wal", f + "-shm"]) fs.rmSync(x, { force: true }); };

  // (a) a database at version 3 without the column: migration 4 adds it
  const fresh = tmp("a");
  let raw = new DatabaseSync(fresh);
  for (let i = 0; i < 3; i++) raw.exec(MIGRATIONS[i]);
  raw.exec("PRAGMA user_version = 3");
  assert.ok(!raw.prepare("PRAGMA table_info(users)").all().some((c) => c.name === "age_attested_at"));
  raw.prepare("INSERT INTO users (address, display_name, created_at) VALUES ('0xabc', 'Old', 1)").run();
  raw.close();
  let db = new Db(fresh);
  assert.equal(db.raw.prepare("PRAGMA user_version").get().user_version, MIGRATIONS.length);
  assert.ok(db.all("PRAGMA table_info(users)").some((c) => c.name === "age_attested_at"));
  assert.equal(db.get("SELECT age_attested_at AS t FROM users WHERE address = '0xabc'").t, null, "existing players have not attested");
  assert.ok(db.all("PRAGMA table_info(deposits)").some((c) => c.name === "status"));
  assert.ok(db.all("PRAGMA table_info(withdrawals)").some((c) => c.name === "fee"));
  db.close();
  clean(fresh);

  // (b) a database written before the attestation was retired already has the column (and an old answer): it must not fail, and the answer stays
  const legacy = tmp("b");
  raw = new DatabaseSync(legacy);
  for (let i = 0; i < 3; i++) raw.exec(MIGRATIONS[i]);
  raw.exec("ALTER TABLE users ADD COLUMN age_attested_at INTEGER");
  raw.exec("PRAGMA user_version = 3");
  raw.prepare("INSERT INTO users (address, display_name, created_at, age_attested_at) VALUES ('0xdef', 'Veteran', 1, 12345)").run();
  raw.close();
  db = new Db(legacy);
  assert.equal(db.raw.prepare("PRAGMA user_version").get().user_version, MIGRATIONS.length);
  assert.equal(db.get("SELECT age_attested_at AS t FROM users WHERE address = '0xdef'").t, 12345);
  db.close();
  clean(legacy);

  // (c) migrating twice is a no-op
  const again = tmp("c");
  new Db(again).close();
  db = new Db(again);
  assert.equal(db.raw.prepare("PRAGMA user_version").get().user_version, MIGRATIONS.length);
  db.close();
  clean(again);
});
