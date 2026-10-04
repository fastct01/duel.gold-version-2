/* Invite-only lobbies: create → share code → friends join (up to lobbyMaxPlayers) → host starts → normal match flow;
   rosters, refunds, races, admission rules, restarts. N-player settlement lives in multiplayer.test.js. */
import test, { after } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { startApp, mETH } from "./helpers/app.js";
import { ACCT } from "../src/ledger.js";

const apps = [];
const boot = async (over) => { const h = await startApp(over); apps.push(h); return h; };
after(async () => { for (const h of apps) await h.close().catch(() => {}); });

const STAKE = mETH;
const GAME = "reaction";
const audit = (h) => assert.deepEqual(h.app.ledger.audit().problems, []);
const mk = (p, stake = STAKE) => p.client.createLobby({ game: GAME, stake: String(stake) });
const escrowTotal = (h) => h.app.db.get("SELECT COALESCE(SUM(CAST(balance AS INTEGER)), 0) AS n FROM accounts WHERE id LIKE 'escrow:%'").n;
/* exact (BigInt) version for sums beyond 2^53 wei */
const escrow = (h) => h.app.db.all("SELECT balance FROM accounts WHERE id LIKE 'escrow:%'").reduce((a, r) => a + BigInt(r.balance), 0n);

test("create → public get → join → host starts → both get match.found → play → settle", async () => {
  const h = await boot();
  const [host, guest] = [await h.player({ name: "Hosty" }), await h.player({ name: "Gus" })];
  const before = host.bal();
  const lobby = await mk(host);
  assert.match(lobby.code, /^[A-HJKMNP-Z2-9]{8}$/);
  assert.equal(lobby.state, "open");
  assert.equal(lobby.host.name, "Hosty");
  assert.equal(lobby.stake, String(STAKE));
  assert.equal(lobby.pot, String(STAKE), "pot = stake x players in the lobby: just the host so far");
  assert.equal(lobby.winnerPayout, String(STAKE - STAKE / 10n));
  assert.equal(lobby.game.id, GAME);
  assert.ok(lobby.expiresAt > lobby.createdAt);
  assert.deepEqual([lobby.minPlayers, lobby.maxPlayers, lobby.playerCount], [2, 10, 1]);
  assert.equal(lobby.role, "host");
  assert.equal(lobby.players.length, 1);
  assert.deepEqual({ name: lobby.players[0].name, host: lobby.players[0].host, you: lobby.players[0].you }, { name: "Hosty", host: true, you: true });
  assert.equal(lobby.players[0].avatar, `${host.address.slice(0, 6)}…${host.address.slice(-4)}`);
  assert.equal(host.bal(), before - STAKE, "host stake escrowed");
  const created = await host.client.waitFor("lobby.created");
  assert.equal(created.lobby.code, lobby.code);
  assert.equal(created.lobby.role, "host");

  // /me shows the open lobby
  const me = await host.client.api("GET", "/v1/me");
  assert.equal(me.active.kind, "lobby");
  assert.equal(me.active.lobby.code, lobby.code);
  assert.equal(me.active.lobby.role, "host");
  assert.equal(me.balances.inPlay, String(STAKE));

  // public GET, no auth: the public variant, no member-only fields
  const res = await fetch(`${h.url}/v1/lobbies/${lobby.code}`);
  assert.equal(res.status, 200);
  const pub = (await res.json()).lobby;
  assert.equal(pub.code, lobby.code);
  assert.ok(!("role" in pub));
  assert.deepEqual(pub.players, [{ name: "Hosty", host: true }]);

  // joining adds the guest and holds the stake; it does NOT start a match
  const joined = await guest.client.joinLobby(lobby.code);
  assert.deepEqual(Object.keys(joined), ["lobby"]);
  assert.equal(joined.lobby.state, "open");
  assert.equal(joined.lobby.role, "guest");
  assert.equal(joined.lobby.playerCount, 2);
  assert.equal(joined.lobby.pot, String(STAKE * 2n));
  assert.equal(joined.lobby.winnerPayout, String(STAKE * 2n - STAKE * 2n / 10n));
  assert.deepEqual(joined.lobby.players.map((p) => [p.name, p.host, p.you]), [["Hosty", true, false], ["Gus", false, true]]);
  assert.equal(guest.bal(), 100n * mETH - STAKE);
  assert.equal(h.app.db.get("SELECT COUNT(*) AS n FROM matches").n, 0, "no match yet");
  const upd = await host.client.waitFor("lobby.updated");
  assert.equal(upd.lobby.playerCount, 2);
  assert.equal(upd.lobby.role, "host");
  assert.deepEqual(upd.lobby.players.map((p) => [p.name, p.you]), [["Hosty", true], ["Gus", false]]);

  const match = await host.client.startLobby(lobby.code);
  assert.equal(match.state, "found");
  assert.equal(match.private, true);
  assert.equal(match.opponent.name, "Gus");
  assert.equal(match.playerCount, 2);
  const [fh, fg] = await Promise.all([host.client.waitFor("match.found"), guest.client.waitFor("match.found")]);
  assert.equal(fh.match.id, match.id);
  assert.equal(fg.match.id, match.id);
  assert.equal(fg.match.opponent.name, "Hosty");
  assert.equal(host.bal(), before - STAKE);
  assert.equal(guest.bal(), 100n * mETH - STAKE);

  const closed = await host.client.getLobby(lobby.code);
  assert.equal(closed.state, "matched");
  assert.equal(closed.closedReason, "matched");
  assert.equal(closed.matchId, match.id);
  assert.equal(closed.playerCount, 2);
  await assert.rejects(h.player().then((late) => late.client.joinLobby(lobby.code)), { code: "LOBBY_CLOSED" });

  const meHost = await host.client.api("GET", "/v1/me");
  assert.equal(meHost.active.kind, "match");

  await h.begin(host, guest, match.id);
  await host.client.submit(match.id, 900);
  await guest.client.submit(match.id, 100);
  const r = await host.client.waitFor("match.result");
  assert.equal(r.match.result, "win");
  assert.equal(host.bal(), before + STAKE - STAKE * 2n / 10n);
  assert.equal(h.house(), STAKE * 2n / 10n);
  assert.equal(escrowTotal(h), 0);
  audit(h);
});

test("cancel refunds the host, notifies every connection, and closes the public view", async () => {
  const h = await boot();
  const host = await h.player();
  const before = host.bal();
  const lobby = await mk(host);
  await host.client.waitFor("lobby.created");
  const out = await host.client.closeLobby(lobby.code);
  assert.equal(out.state, "closed");
  assert.equal(out.closedReason, "cancelled");
  assert.equal(host.bal(), before);
  const ev = await host.client.waitFor("lobby.closed");
  assert.equal(ev.lobby.closedReason, "cancelled");
  assert.equal((await host.client.getLobby(lobby.code)).state, "closed");
  assert.equal((await host.client.closeLobby(lobby.code)).state, "closed", "closing twice is harmless");
  const guest = await h.player();
  await assert.rejects(guest.client.joinLobby(lobby.code), { code: "LOBBY_CLOSED", status: 409 });
  assert.equal(guest.bal(), 100n * mETH, "not charged");
  assert.equal((await host.client.api("GET", "/v1/me")).active, null);
  // the host may open a new lobby afterwards
  await mk(host);
  audit(h);
});

test("only the host can close a lobby; the WS mirror works too", async () => {
  const h = await boot();
  const [host, other] = [await h.player(), await h.player()];
  const lobby = await mk(host);
  await assert.rejects(other.client.closeLobby(lobby.code), { code: "LOBBY_NOT_HOST", status: 403 });
  const out = await host.client.request("lobby.close", {});
  assert.equal(out.lobby.closedReason, "cancelled");
  const viaWs = await other.client.request("lobby.create", { game: GAME, stake: String(STAKE) });
  assert.equal(viaWs.lobby.state, "open");
  await other.client.request("lobby.close", { code: viaWs.lobby.code.toLowerCase() });
  await assert.rejects(other.client.request("lobby.close", {}), { code: "LOBBY_NOT_FOUND" });
  audit(h);
});

test("an unclaimed lobby expires: stake refunded, host told, join refused", async () => {
  const h = await boot({ match: { lobbyTtlMs: 250 } });
  const [host, guest] = [await h.player(), await h.player()];
  const lobby = await mk(host);
  assert.equal(h.app.ledger.balance(ACCT.user(host.id)), 100n * mETH - STAKE);
  const ev = await host.client.waitFor("lobby.closed", null, 3000);
  assert.equal(ev.lobby.closedReason, "expired");
  assert.equal(host.bal(), 100n * mETH);
  assert.equal((await guest.client.getLobby(lobby.code)).closedReason, "expired");
  await assert.rejects(guest.client.joinLobby(lobby.code), { code: "LOBBY_CLOSED" });
  assert.equal(guest.bal(), 100n * mETH);
  audit(h);
});

test("error codes: LOBBY_NOT_FOUND, LOBBY_OWN, case-insensitive codes", async () => {
  const h = await boot();
  const [host, guest] = [await h.player(), await h.player()];
  await assert.rejects(guest.client.getLobby("ABCDEFGH"), { code: "LOBBY_NOT_FOUND", status: 404 });
  await assert.rejects(guest.client.getLobby("x"), { code: "LOBBY_NOT_FOUND", status: 404 });
  await assert.rejects(guest.client.joinLobby("ABCDEFGH"), { code: "LOBBY_NOT_FOUND", status: 404 });
  const lobby = await mk(host);
  await assert.rejects(host.client.joinLobby(lobby.code), { code: "LOBBY_OWN", status: 409 });
  assert.equal((await guest.client.getLobby(lobby.code.toLowerCase())).code, lobby.code);
  const m = await guest.client.joinLobby(` ${lobby.code.toLowerCase()} `.trim());
  assert.equal(m.lobby.state, "open");
  assert.equal(m.lobby.playerCount, 2);
  await assert.rejects(guest.client.joinLobby(lobby.code), { code: "LOBBY_ALREADY_IN", status: 409 });
  assert.equal(guest.bal(), 100n * mETH - STAKE, "the second attempt charged nothing");
  audit(h);
});

test("GET /v1/lobbies/:code never leaks addresses or user ids", async () => {
  const h = await boot();
  const host = await h.player({ name: "Pat" });
  const lobby = await mk(host);
  const body = await (await fetch(`${h.url}/v1/lobbies/${lobby.code}`)).text();
  assert.ok(!body.toLowerCase().includes(host.address.slice(2, 12)), "no address");
  assert.ok(!/"(id|userId|address)"/.test(body.replace(/"game":\{"id":"[^"]*"/, "")), body);
  const joined = await h.player();
  const m = await joined.client.joinLobby(lobby.code);
  void m;
  const memberView = JSON.stringify(m.lobby);
  assert.ok(!memberView.includes(host.address.slice(2, 12)), "even members only get short avatars, never a full address");
  assert.ok(memberView.includes(`${host.address.slice(0, 6)}…${host.address.slice(-4)}`));
  const after = await (await fetch(`${h.url}/v1/lobbies/${lobby.code}`)).text();
  assert.ok(!after.toLowerCase().includes(host.address.slice(2, 12)));
  assert.ok(!after.toLowerCase().includes(joined.address.slice(2, 12)));
});

test("a host cannot queue, host a second lobby, or join someone else's while theirs is open", async () => {
  const h = await boot();
  const [host, other] = [await h.player(), await h.player()];
  const mine = await mk(host);
  const theirs = await mk(other);
  await assert.rejects(mk(host), { code: "ALREADY_ACTIVE" });
  await assert.rejects(host.client.joinQueue({ game: GAME, stake: "0" }), { code: "ALREADY_ACTIVE" });
  await assert.rejects(host.client.joinLobby(theirs.code), { code: "ALREADY_ACTIVE" });
  assert.equal((await host.client.getLobby(mine.code)).state, "open");
  assert.equal(host.bal(), 100n * mETH - STAKE, "failed attempts charged nothing");
  audit(h);
});

test("concurrent joins can never overfill a lobby or move money twice", async () => {
  const h = await boot({ match: { lobbyMaxPlayers: 3 } });
  const host = await h.player();
  const guests = [await h.player(), await h.player(), await h.player(), await h.player()];
  const lobby = await mk(host);
  const results = await Promise.allSettled(guests.map((g) => g.client.joinLobby(lobby.code)));
  const won = results.filter((r) => r.status === "fulfilled");
  const lost = results.filter((r) => r.status === "rejected");
  assert.equal(won.length, 2, "host + 2 guests = 3 = the cap");
  assert.equal(lost.length, 2);
  for (const l of lost) assert.equal(l.reason.code, "LOBBY_FULL");
  assert.equal(won.filter((r) => r.value.match).length, 1, "exactly one join filled the lobby and carries the match");
  guests.forEach((g, i) => assert.equal(g.bal(), results[i].status === "fulfilled" ? 100n * mETH - STAKE : 100n * mETH));
  assert.equal(h.app.db.get("SELECT COUNT(*) AS n FROM matches").n, 1);
  assert.equal(h.app.db.get("SELECT COUNT(*) AS n FROM match_players").n, 3);
  assert.equal(escrowTotal(h), Number(STAKE * 3n));
  audit(h);
});

test("the same player joining twice at once is charged once", async () => {
  const h = await boot();
  const [host, guest] = [await h.player(), await h.player()];
  const lobby = await mk(host);
  const results = await Promise.allSettled([guest.client.joinLobby(lobby.code), guest.client.joinLobby(lobby.code), guest.client.api("POST", `/v1/lobbies/${lobby.code}/join`)]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  for (const r of results.filter((x) => x.status === "rejected")) assert.equal(r.reason.code, "LOBBY_ALREADY_IN");
  assert.equal(guest.bal(), 100n * mETH - STAKE);
  assert.equal(h.app.db.get("SELECT COUNT(*) AS n FROM tickets WHERE lobby_ticket_id IS NOT NULL").n, 1);
  audit(h);
});

test("host cancelling while a guest joins gives one consistent outcome", async () => {
  for (let i = 0; i < 5; i++) {
    const h = await boot();
    const [host, guest] = [await h.player(), await h.player()];
    const lobby = await mk(host);
    const [c, j] = await Promise.allSettled([host.client.closeLobby(lobby.code), guest.client.joinLobby(lobby.code)]);
    assert.equal(c.status, "fulfilled", "an open lobby can always be closed, even by a join that landed first");
    if (j.status === "rejected") assert.equal(j.reason.code, "LOBBY_CLOSED");
    else await guest.client.waitFor("lobby.closed"); // joined first, then the host closed: the guest was refunded
    assert.equal(host.bal(), 100n * mETH);
    assert.equal(guest.bal(), 100n * mETH);
    assert.equal(escrowTotal(h), 0);
    audit(h);
  }
});

test("host starting while a guest joins gives one consistent outcome", async () => {
  for (let i = 0; i < 5; i++) {
    const h = await boot();
    const [host, g1, g2] = [await h.player(), await h.player(), await h.player()];
    const lobby = await mk(host);
    await g1.client.joinLobby(lobby.code);
    const [st, j] = await Promise.allSettled([host.client.startLobby(lobby.code), g2.client.joinLobby(lobby.code)]);
    assert.equal(st.status, "fulfilled");
    const seats = h.app.db.get("SELECT COUNT(*) AS n FROM match_players").n;
    if (j.status === "fulfilled") { assert.equal(seats, 3); assert.equal(st.value.playerCount, 3); assert.equal(g2.bal(), 100n * mETH - STAKE); }
    else { assert.equal(j.reason.code, "LOBBY_CLOSED"); assert.equal(seats, 2); assert.equal(g2.bal(), 100n * mETH); }
    assert.equal(escrowTotal(h), Number(STAKE) * seats);
    audit(h);
  }
});

test("stake and responsible-play rules apply to both host and guest", async () => {
  const h = await boot();
  const lobbyHost = await h.player();
  const lobby = await mk(lobbyHost);

  // host side (create)
  const poor = await h.player({ fund: STAKE / 2n });
  await assert.rejects(mk(poor), (e) => /INSUFFICIENT/.test(e.code));
  await assert.rejects(lobbyHost.client.createLobby({ game: GAME, stake: "1" }), { code: "BAD_STAKE" });
  await assert.rejects(lobbyHost.client.createLobby({ game: "nope", stake: "0" }), { code: "UNKNOWN_GAME" });

  // guest side (join) — each failure leaves the lobby open and charges nothing
  const bal = poor.bal();
  await assert.rejects(poor.client.joinLobby(lobby.code), (e) => /INSUFFICIENT/.test(e.code));
  assert.equal(poor.bal(), bal);
  assert.equal((await lobbyHost.client.getLobby(lobby.code)).state, "open");

  // free lobbies need no funds at all
  const broke = await h.player({ fund: 0n });
  const free = await broke.client.createLobby({ game: GAME, stake: "0" });
  assert.equal(free.stake, "0");
  const friend = await h.player({ fund: 0n });
  assert.equal((await friend.client.joinLobby(free.code)).lobby.stake, "0");
  audit(h);
});

test("a guest over their daily loss limit cannot join", async () => {
  const h = await boot();
  const host = await h.player();
  const g = await h.player();
  await g.client.api("PUT", "/v1/me/loss-limit", { amount: String(STAKE / 2n) });
  const lobby = await mk(host);
  await assert.rejects(g.client.joinLobby(lobby.code), { code: "LOSS_LIMIT" });
  assert.equal(g.bal(), 100n * mETH);
});

test("public queue is off unless enabled: REST and WS refuse with PUBLIC_QUEUE_DISABLED; private codes still work", async () => {
  const h = await boot({ match: { publicQueue: false } });
  const [a, b] = [await h.player(), await h.player()];
  await assert.rejects(a.client.joinQueue({ game: GAME, stake: "0" }), { code: "PUBLIC_QUEUE_DISABLED" });
  await assert.rejects(a.client.api("POST", "/v1/queue", { game: GAME, stake: "0" }), { code: "PUBLIC_QUEUE_DISABLED", status: 403 });
  assert.equal(a.bal(), 100n * mETH);
  assert.equal((await fetch(`${h.url}/v1/config`).then((r) => r.json())).match.publicQueue, false);
  assert.equal((await fetch(`${h.url}/v1/config`).then((r) => r.json())).match.lobbyTtlMs, 30 * 60000);
  assert.equal((await fetch(`${h.url}/v1/config`).then((r) => r.json())).match.lobbyMaxPlayers, 10);
  const m = await h.pair(a, b, { stake: 0, code: "friends1" });
  assert.ok(m.id);
});

test("an open lobby survives a restart with its escrow and expiry; an expired one is refunded once", async () => {
  const file = path.join(os.tmpdir(), `duel-lobby-${process.pid}-${Date.now()}.db`);
  const h1 = await startApp({ dbPath: file });
  const [host, stale] = [await h1.player(), await h1.player()];
  const keep = await mk(host);
  const old = await mk(stale);
  h1.app.db.run("UPDATE tickets SET created_at = created_at - 3600000 WHERE lobby_code = ?", old.code); // past its 30 min ttl
  await h1.close();

  const h2 = await startApp({ dbPath: file });
  apps.push(h2);
  assert.equal(h2.app.ledger.balance(ACCT.user(stale.id)), 100n * mETH, "expired lobby refunded");
  assert.equal(h2.app.ledger.balance(ACCT.user(host.id)), 100n * mETH - STAKE, "live lobby still holds the stake");
  assert.equal(h2.app.matches.getLobby(keep.code).state, "open");
  assert.equal(h2.app.matches.getLobby(old.code).closedReason, "expired");
  assert.equal(h2.app.matches.sync(host.id).active.kind, "lobby");
  const guest = await (async () => {
    const { Wallet } = await import("ethers");
    const { DuelClient } = await import("../client/duel-client.js");
    const w = Wallet.createRandom();
    const c = new DuelClient({ baseUrl: h2.app.url, address: w.address, sign: (m) => w.signMessage(m) });
    await c.login();
    h2.seq = 1000; // the harness numbers deposits from 1 and the ledger de-duplicates by that key
    h2.credit(c.me.id, 10n * mETH);
    return c;
  })();
  assert.equal((await guest.joinLobby(keep.code)).lobby.state, "open");
  assert.equal(h2.app.matches.startLobby(host.id, keep.code).state, "found", "the restored host can start it");
  assert.deepEqual(h2.app.ledger.audit().problems, []);
  await h2.close();
  // a second restart must not refund anything twice
  const h3 = await startApp({ dbPath: file });
  apps.push(h3);
  assert.equal(h3.app.ledger.balance(ACCT.user(stale.id)), 100n * mETH);
  assert.deepEqual(h3.app.ledger.audit().problems, []);
  fs.rmSync(file, { force: true }); fs.rmSync(file + "-wal", { force: true }); fs.rmSync(file + "-shm", { force: true });
});

test("lobby matches stay out of the public lobby stats and the admin audit is clean", async () => {
  const h = await boot({ match: { lobbyCacheMs: 0 } });
  const [host, guest] = [await h.player(), await h.player()];
  const lobby = await mk(host);
  const l1 = await fetch(`${h.url}/v1/lobby`).then((r) => r.json());
  assert.deepEqual(l1.games, []);
  await guest.client.joinLobby(lobby.code);
  const l2 = await fetch(`${h.url}/v1/lobby`).then((r) => r.json());
  assert.deepEqual(l2.games, [], "waiting guests are not queue tickets");
  await host.client.startLobby(lobby.code);
  const l3 = await fetch(`${h.url}/v1/lobby`).then((r) => r.json());
  assert.equal(l3.playing, 0, "a private lobby match is not counted");
  audit(h);
});

test("GET /v1/lobbies/:code is rate limited per IP", async () => {
  const h = await boot({ rate: { apiPerMin: 5 } });
  let limited = 0;
  for (let i = 0; i < 30; i++) {
    const r = await fetch(`${h.url}/v1/lobbies/ABCDEFGH`);
    if (r.status === 429) limited++;
  }
  assert.ok(limited > 0);
});

/* ================================================================== multi-player lobbies */

const nm = (i) => `Player ${i}`;
const crew = async (h, n, opts = {}) => { const g = []; for (let i = 0; i < n; i++) g.push(await h.player({ name: nm(i), ...opts })); return g; };
const names = (lobby) => lobby.players.map((p) => p.name);
const settle = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const START = 100n * mETH;

test("capacity: 10 players fill a lobby, the 10th join starts it, the 11th gets LOBBY_FULL", async () => {
  const h = await boot();
  const g = await crew(h, 11);
  const [host, ...guests] = g.slice(0, 10);
  const lobby = await mk(host);
  assert.equal(lobby.maxPlayers, 10);

  for (let i = 0; i < 8; i++) {
    const out = await guests[i].client.joinLobby(lobby.code);
    assert.ok(!out.match, `join ${i + 2} is not the last one`);
    assert.equal(out.lobby.state, "open");
    assert.equal(out.lobby.playerCount, i + 2);
    assert.equal(out.lobby.pot, String(STAKE * BigInt(i + 2)));
    assert.equal(out.lobby.winnerPayout, String(STAKE * BigInt(i + 2) * 9n / 10n));
    assert.deepEqual(names(out.lobby), g.slice(0, i + 2).map((_, k) => nm(k)), "host first, then join order");
  }
  assert.equal(h.app.db.get("SELECT COUNT(*) AS n FROM matches").n, 0, "nine players and still no match");
  // every member of the 9-player lobby has been told, with their own view
  for (const [k, p] of g.slice(0, 9).entries()) {
    const ev = await p.client.waitFor("lobby.updated", (m) => m.lobby.playerCount === 9);
    assert.equal(ev.lobby.role, k === 0 ? "host" : "guest");
    assert.deepEqual(ev.lobby.players.map((x) => x.you), g.slice(0, 9).map((_, i) => i === k));
  }

  const last = await guests[8].client.joinLobby(lobby.code); // the 10th player
  assert.equal(last.lobby.state, "matched");
  assert.equal(last.lobby.playerCount, 10);
  assert.equal(last.lobby.matchId, last.match.id);
  assert.equal(last.match.playerCount, 10);
  assert.equal(last.match.state, "found");
  assert.equal(last.match.you.seat, 9);
  assert.deepEqual(last.match.players.map((p) => p.name), g.slice(0, 10).map((_, i) => nm(i)), "seats follow join order, host in seat 0");
  assert.equal(last.match.pot, String(STAKE * 10n));

  // everyone got match.found for the same match, and the lobby update with the full roster came first
  for (const [k, p] of g.slice(0, 10).entries()) {
    const found = await p.client.waitFor("match.found");
    assert.equal(found.match.id, last.match.id);
    assert.equal(found.match.you.seat, k);
    assert.equal(found.match.players.filter((x) => x.you).length, 1);
    const types = p.client.peek().map((m) => m.type);
    assert.ok(!types.includes("lobby.closed"), "starting is not closing");
  }
  const hostTypes = host.client.peek().map((m) => m.type);
  assert.ok(hostTypes.includes("lobby.updated"));

  // the lobby is full: the 11th is told so, and nothing moves
  await assert.rejects(g[10].client.joinLobby(lobby.code), { code: "LOBBY_FULL", status: 409 });
  assert.equal(g[10].bal(), START);

  g.slice(0, 10).forEach((p) => assert.equal(p.bal(), START - STAKE));
  assert.equal(h.app.ledger.balance(ACCT.match(last.match.id)), STAKE * 10n);
  assert.equal(h.app.db.get("SELECT COUNT(*) AS n FROM tickets WHERE state = 'queued'").n, 0);
  const pub = await g[10].client.getLobby(lobby.code);
  assert.equal(pub.state, "matched");
  assert.equal(pub.playerCount, 10);
  assert.deepEqual(pub.players.map((p) => p.host), [true, ...Array(9).fill(false)]);
  assert.equal(escrow(h), STAKE * 10n);
  audit(h);
});

test("lobbyMaxPlayers = 2 is the classic 1v1: the first join starts it and later joiners get LOBBY_FULL", async () => {
  const h = await boot({ match: { lobbyMaxPlayers: 2 } });
  const [host, guest, late] = await crew(h, 3);
  const lobby = await mk(host);
  assert.equal(lobby.maxPlayers, 2);
  const out = await guest.client.joinLobby(lobby.code);
  assert.equal(out.match.state, "found");
  assert.equal(out.match.playerCount, 2);
  assert.equal(out.lobby.state, "matched");
  await host.client.waitFor("match.found");
  await assert.rejects(late.client.joinLobby(lobby.code), { code: "LOBBY_FULL" });
  assert.equal(late.bal(), START);
  assert.equal((await fetch(`${h.url}/v1/config`).then((r) => r.json())).match.lobbyMaxPlayers, 2);
  audit(h);
});

test("LOBBY_MAX_PLAYERS is validated: 2 to 10", async () => {
  const { loadConfig } = await import("../src/config.js");
  assert.equal(loadConfig({ NODE_ENV: "test" }).match.lobbyMaxPlayers, 10);
  assert.equal(loadConfig({ NODE_ENV: "test", LOBBY_MAX_PLAYERS: "2" }).match.lobbyMaxPlayers, 2);
  assert.equal(loadConfig({ NODE_ENV: "test", LOBBY_MAX_PLAYERS: "6" }).match.lobbyMaxPlayers, 6);
  for (const bad of ["1", "0", "11", "x", "2.5"]) assert.throws(() => loadConfig({ NODE_ENV: "test", LOBBY_MAX_PLAYERS: bad }), /LOBBY_MAX_PLAYERS/, bad);
  assert.throws(() => loadConfig({ NODE_ENV: "test" }, { match: { lobbyMaxPlayers: 12 } }), /LOBBY_MAX_PLAYERS/);
});

test("a guest can leave before the start: stake refunded, the others see the new roster", async () => {
  const h = await boot();
  const [host, a, b] = await crew(h, 3);
  const lobby = await mk(host);
  await a.client.joinLobby(lobby.code);
  await b.client.joinLobby(lobby.code);
  assert.equal(a.bal(), START - STAKE);
  for (const p of [host, a, b]) await p.client.waitFor("lobby.updated", (m) => m.lobby.playerCount === 3);

  const out = await a.client.leaveLobby(lobby.code);
  assert.equal(out.state, "closed", "the lobby is over for the leaver");
  assert.equal(out.closedReason, "left");
  assert.equal(out.code, lobby.code);
  assert.ok(!("role" in out) && out.players.every((p) => !("avatar" in p)), "a leaver is no longer a member: public view");
  assert.equal(a.bal(), START);
  assert.equal(h.app.ledger.balance(ACCT.ticket(h.app.db.get("SELECT id FROM tickets WHERE user_id = ? AND lobby_ticket_id IS NOT NULL", a.id).id)), 0n);

  const closed = await a.client.waitFor("lobby.closed");
  assert.equal(closed.lobby.closedReason, "left");
  const wallet = await a.client.waitFor("wallet.updated", (m) => m.reason === "stake-released");
  assert.ok(wallet);

  for (const [p, role, you] of [[host, "host", [true, false]], [b, "guest", [false, true]]]) {
    const ev = await p.client.waitFor("lobby.updated", (m) => m.lobby.playerCount === 2 && names(m.lobby)[1] === nm(2));
    assert.equal(ev.lobby.role, role);
    assert.deepEqual(names(ev.lobby), [nm(0), nm(2)]);
    assert.deepEqual(ev.lobby.players.map((x) => x.you), you);
    assert.equal(ev.lobby.pot, String(STAKE * 2n));
    assert.equal(ev.lobby.state, "open");
  }
  assert.deepEqual(names(await h.player().then((x) => x.client.getLobby(lobby.code))), [nm(0), nm(2)]);
  assert.equal((await a.client.api("GET", "/v1/me")).active, null, "the leaver is free again");
  assert.equal(escrowTotal(h), Number(STAKE * 2n));

  // may come back, and the host may not leave their own lobby
  const again = await a.client.joinLobby(lobby.code);
  assert.deepEqual(names(again.lobby), [nm(0), nm(2), nm(1)], "back at the end of the queue");
  await assert.rejects(host.client.leaveLobby(lobby.code), { code: "LOBBY_HOST_LEAVE", status: 409, message: /Cancel the lobby instead/ });
  const stranger = await h.player();
  await assert.rejects(stranger.client.leaveLobby(lobby.code), { code: "LOBBY_NOT_IN", status: 409 });
  await assert.rejects(stranger.client.leaveLobby("ABCDEFGH"), { code: "LOBBY_NOT_FOUND", status: 404 });
  assert.equal(host.bal(), START - STAKE);
  audit(h);
});

test("leaving a lobby that already started is refused; so is leaving a closed one", async () => {
  const h = await boot();
  const [host, a, b] = await crew(h, 3);
  const { code } = await h.lobbyOf([host, a, b]);
  await host.client.startLobby(code);
  await assert.rejects(a.client.leaveLobby(code), { code: "LOBBY_CLOSED", status: 409 });
  assert.equal(a.bal(), START - STAKE, "still in the match");
  const x = await h.player(), y = await h.player();
  const l2 = await mk(x);
  await y.client.joinLobby(l2.code);
  await x.client.closeLobby(l2.code);
  await assert.rejects(y.client.leaveLobby(l2.code), { code: "LOBBY_CLOSED" });
  audit(h);
});

test("a waiting guest sees the lobby on sync and /me, like the host", async () => {
  const h = await boot();
  const [host, a, b] = await crew(h, 3);
  const { code } = await h.lobbyOf([host, a, b]);
  for (const [p, role] of [[host, "host"], [a, "guest"], [b, "guest"]]) {
    const me = await p.client.api("GET", "/v1/me");
    assert.equal(me.active.kind, "lobby");
    assert.equal(me.active.lobby.code, code);
    assert.equal(me.active.lobby.role, role);
    assert.equal(me.active.lobby.playerCount, 3);
    assert.equal(me.balances.inPlay, String(STAKE));
    assert.deepEqual(names(me.active.lobby), [nm(0), nm(1), nm(2)]);
    assert.equal(me.active.lobby.players.filter((x) => x.you).length, 1);
    const viaWs = await p.client.sync();
    assert.equal(viaWs.me.active.lobby.role, role);
  }
  // a waiting guest is busy: no queueing, hosting or joining elsewhere
  await assert.rejects(a.client.joinQueue({ game: GAME, stake: "0", code: "ABCD1234" }), { code: "ALREADY_ACTIVE" });
  await assert.rejects(mk(a), { code: "ALREADY_ACTIVE" });
  const other = await h.player();
  const l2 = await mk(other);
  await assert.rejects(a.client.joinLobby(l2.code), { code: "ALREADY_ACTIVE", message: /Leave the lobby you joined/ });
  await assert.rejects(a.client.api("DELETE", `/v1/lobbies/${code}`), { code: "LOBBY_NOT_HOST", status: 403 });
  await assert.rejects(a.client.request("lobby.close", {}), { code: "LOBBY_NOT_HOST" });
  audit(h);
});

test("the host closing the lobby refunds every member and tells each of them", async () => {
  const h = await boot();
  const g = await crew(h, 4);
  const { code } = await h.lobbyOf(g);
  g.forEach((p) => assert.equal(p.bal(), START - STAKE));
  const out = await g[0].client.closeLobby(code);
  assert.equal(out.state, "closed");
  assert.equal(out.closedReason, "cancelled");
  assert.equal(out.role, "host");
  assert.equal(out.playerCount, 4);
  for (const [k, p] of g.entries()) {
    assert.equal(p.bal(), START, `player ${k} refunded`);
    const ev = await p.client.waitFor("lobby.closed");
    assert.equal(ev.lobby.closedReason, "cancelled");
    assert.equal(ev.lobby.state, "closed");
    assert.equal(ev.lobby.role, k === 0 ? "host" : "guest");
    assert.equal(ev.lobby.players.length, 4);
    await p.client.waitFor("wallet.updated", (m) => m.reason === "stake-released");
    assert.equal((await p.client.api("GET", "/v1/me")).active, null);
  }
  assert.equal(escrowTotal(h), 0);
  assert.equal(h.house(), 0n);
  const pub = await g[1].client.getLobby(code);
  assert.deepEqual([pub.state, pub.closedReason, pub.playerCount], ["closed", "cancelled", 4]);
  await assert.rejects(g[1].client.joinLobby(code), { code: "LOBBY_CLOSED" });
  // closing twice is harmless, and everybody can host again
  assert.equal((await g[0].client.closeLobby(code)).state, "closed");
  await mk(g[1]);
  audit(h);
});

test("an expired lobby refunds the host and every guest", async () => {
  const h = await boot({ match: { lobbyTtlMs: 700 } });
  const g = await crew(h, 4);
  const { code } = await h.lobbyOf(g);
  g.forEach((p) => assert.equal(p.bal(), START - STAKE));
  for (const p of g) {
    const ev = await p.client.waitFor("lobby.closed", null, 4000);
    assert.equal(ev.lobby.closedReason, "expired");
    await p.client.waitFor("wallet.updated", (m) => m.reason === "stake-released");
    assert.equal(p.bal(), START);
  }
  assert.equal(escrowTotal(h), 0);
  assert.equal((await g[2].client.getLobby(code)).closedReason, "expired");
  await assert.rejects(g[2].client.joinLobby(code), { code: "LOBBY_CLOSED" });
  assert.equal((await g[3].client.api("GET", "/v1/me")).active, null);
  audit(h);
});

test("starting needs 2+ players and only the host may do it", async () => {
  const h = await boot();
  const [host, a, b, stranger] = await crew(h, 4);
  const lobby = await mk(host);
  await assert.rejects(host.client.startLobby(lobby.code), (e) => e.code === "LOBBY_NOT_ENOUGH_PLAYERS" && e.status === 409 && e.extra.minPlayers === 2 && e.extra.playerCount === 1);
  assert.equal((await host.client.getLobby(lobby.code)).state, "open");
  assert.equal(h.app.db.get("SELECT COUNT(*) AS n FROM matches").n, 0);

  await a.client.joinLobby(lobby.code);
  await assert.rejects(a.client.startLobby(lobby.code), { code: "LOBBY_NOT_HOST", status: 403 });
  await assert.rejects(stranger.client.startLobby(lobby.code), { code: "LOBBY_NOT_HOST", status: 403 });
  await assert.rejects(host.client.startLobby("ABCDEFGH"), { code: "LOBBY_NOT_FOUND", status: 404 });
  assert.equal(h.app.db.get("SELECT COUNT(*) AS n FROM matches").n, 0);

  // a guest leaves again: back to one player, so no start
  await a.client.leaveLobby(lobby.code);
  await assert.rejects(host.client.startLobby(lobby.code), { code: "LOBBY_NOT_ENOUGH_PLAYERS" });
  await a.client.joinLobby(lobby.code);
  await b.client.joinLobby(lobby.code);

  const match = await host.client.startLobby(lobby.code);
  assert.equal(match.playerCount, 3);
  assert.equal(match.state, "found");
  assert.deepEqual(match.players.map((p) => p.name), [nm(0), nm(1), nm(2)], "a left and rejoined guest keeps the place they rejoined at");
  for (const p of [host, a, b]) assert.equal((await p.client.waitFor("match.found")).match.id, match.id);
  assert.equal(h.app.ledger.balance(ACCT.match(match.id)), STAKE * 3n);
  const row = h.app.db.get("SELECT state, match_id FROM tickets WHERE lobby_code = ?", lobby.code);
  assert.deepEqual({ ...row }, { state: "matched", match_id: match.id });

  // it has started: no second start, no late joiners, no leaving, no closing
  await assert.rejects(host.client.startLobby(lobby.code), { code: "LOBBY_CLOSED", status: 409 });
  await assert.rejects(stranger.client.joinLobby(lobby.code), { code: "LOBBY_CLOSED", status: 409 });
  await assert.rejects(a.client.joinLobby(lobby.code), { code: "LOBBY_ALREADY_IN", status: 409 });
  await assert.rejects(host.client.closeLobby(lobby.code), { code: "LOBBY_CLOSED", status: 409 });
  assert.equal(stranger.bal(), START);
  const pub = await stranger.client.getLobby(lobby.code);
  assert.deepEqual([pub.state, pub.matchId, pub.playerCount], ["matched", match.id, 3]);
  audit(h);
});

test("every lobby action also works over the WebSocket", async () => {
  const h = await boot();
  const [host, a, b] = await crew(h, 3);
  const { lobby } = await host.client.request("lobby.create", { game: GAME, stake: String(STAKE) });
  const j1 = await a.client.request("lobby.join", { code: lobby.code });
  assert.deepEqual(Object.keys(j1), ["lobby"]);
  assert.equal(j1.lobby.role, "guest");
  await assert.rejects(a.client.request("lobby.join", { code: lobby.code }), { code: "LOBBY_ALREADY_IN" });
  await assert.rejects(host.client.request("lobby.join", { code: lobby.code }), { code: "LOBBY_OWN" });
  await assert.rejects(host.client.request("lobby.leave", { code: lobby.code }), { code: "LOBBY_HOST_LEAVE" });
  const left = await a.client.request("lobby.leave", { code: lobby.code });
  assert.equal(left.lobby.closedReason, "left");
  await a.client.request("lobby.join", { code: lobby.code.toLowerCase() });
  await b.client.request("lobby.join", { code: lobby.code });
  await assert.rejects(a.client.request("lobby.start", { code: lobby.code }), { code: "LOBBY_NOT_HOST" });
  const started = await host.client.request("lobby.start", { code: lobby.code });
  assert.deepEqual(Object.keys(started), ["match"]);
  assert.equal(started.match.playerCount, 3);
  for (const p of [host, a, b]) await p.client.waitFor("match.found");
  await assert.rejects(host.client.request("lobby.start", { code: lobby.code }), { code: "LOBBY_CLOSED" });
  await assert.rejects(host.client.request("lobby.start", {}), { code: "LOBBY_NOT_FOUND" });
  audit(h);
});

test("a lobby match nobody accepts in time is voided: everyone refunded, only the no-shows get a strike", async () => {
  const h = await boot({ match: { acceptMs: 900 } });
  const g = await crew(h, 4);
  const m = await h.lobbyMatch(g);
  await g[0].client.ready(m.id);
  await g[1].client.ready(m.id);
  // the ones who did ready hear about each other, with seats
  const seen = await g[0].client.waitFor("match.opponent_ready", (e) => e.seat === 1);
  assert.equal(seen.matchId, m.id);
  for (const p of g) {
    const v = await p.client.waitFor("match.void", null, 4000);
    assert.equal(v.match.reason, "no_show");
    assert.equal(v.match.result, "void");
    assert.deepEqual(v.match.players.map((x) => x.ready), [true, true, false, false]);
    await p.client.waitFor("wallet.updated", (e) => e.reason === "match-settled");
    assert.equal(p.bal(), START);
  }
  const strikes = g.map((p) => h.app.users.byId(p.id).strikes);
  assert.deepEqual(strikes, [0, 0, 1, 1]);
  assert.equal(h.house(), 0n);
  assert.equal(escrowTotal(h), 0);
  assert.equal(h.app.db.get("SELECT COUNT(*) AS n FROM ratings").n, 0);
  assert.equal((await g[0].client.api("GET", "/v1/me")).active, null);
  audit(h);
});

test("declining a lobby match voids it for everybody and strikes only the one who declined", async () => {
  const h = await boot();
  const g = await crew(h, 4);
  const m = await h.lobbyMatch(g);
  await g[0].client.ready(m.id);
  const out = await g[2].client.forfeit(m.id);
  assert.equal(out.state, "void");
  for (const p of g) {
    const v = await p.client.waitFor("match.void");
    assert.equal(v.match.reason, "declined");
    assert.equal(p.bal(), START);
  }
  assert.deepEqual(g.map((p) => h.app.users.byId(p.id).strikes), [0, 0, 1, 0]);
  audit(h);
});

test("restart: an open lobby keeps its guests, escrow and roster; expired ones are refunded once, for everyone", async () => {
  const file = path.join(os.tmpdir(), `duel-lobby-multi-${process.pid}-${Date.now()}.db`);
  const { Wallet } = await import("ethers");
  const { DuelClient } = await import("../client/duel-client.js");
  const h1 = await startApp({ dbPath: file });
  const live = await crew(h1, 4);            // host + 3 guests, still open
  const stale = await crew(h1, 3);           // host + 2 guests, will be past the ttl
  const lone = await h1.player({ name: "Loner" });
  const liveLobby = await h1.lobbyOf(live);
  const staleLobby = await h1.lobbyOf(stale);
  const loneLobby = await mk(lone);
  h1.app.db.run("UPDATE tickets SET created_at = created_at - 3600000 WHERE lobby_code = ?", staleLobby.code);
  const wallets = new Map([...live, ...stale, lone].map((p) => [p.id, p.wallet]));
  await h1.close();

  const h2 = await startApp({ dbPath: file });
  apps.push(h2);
  const bal = (id) => h2.app.ledger.balance(ACCT.user(id));
  for (const p of stale) assert.equal(bal(p.id), START, "expired lobby: host and guests refunded");
  for (const p of live) assert.equal(bal(p.id), START - STAKE, "live lobby still holds every stake");
  assert.equal(bal(lone.id), START - STAKE);
  const pub = h2.app.matches.getLobby(liveLobby.code);
  assert.deepEqual([pub.state, pub.playerCount], ["open", 4]);
  assert.deepEqual(names(pub), [nm(0), nm(1), nm(2), nm(3)]);
  const dead = h2.app.matches.getLobby(staleLobby.code);
  assert.deepEqual([dead.state, dead.closedReason, dead.playerCount], ["closed", "expired", 3]);
  assert.equal(h2.app.matches.getLobby(loneLobby.code).playerCount, 1);
  const s = h2.app.matches.sync(live[2].id).active;
  assert.equal(s.kind, "lobby");
  assert.equal(s.lobby.role, "guest");
  assert.deepEqual(s.lobby.players.map((x) => x.you), [false, false, true, false]);
  assert.equal(h2.app.matches.sync(stale[1].id).active, null);
  assert.deepEqual(h2.app.ledger.audit().problems, []);

  const login = async (p) => {
    const w = wallets.get(p.id);
    const c = new DuelClient({ baseUrl: h2.url, address: w.address, sign: (m) => w.signMessage(m) });
    await c.login(); await c.connect();
    return c;
  };
  const [hostC, g1C, g2C, g3C] = await Promise.all(live.map(login));
  void Wallet;
  const me = await g1C.api("GET", "/v1/me");
  assert.equal(me.active.lobby.code, liveLobby.code);
  assert.equal(me.active.lobby.playerCount, 4);
  await assert.rejects(g2C.createLobby({ game: GAME, stake: String(STAKE) }), { code: "ALREADY_ACTIVE" }, "restored guests are busy again");
  // the restored lobby is fully functional: a guest leaves, the rest can start
  await g3C.leaveLobby(liveLobby.code);
  assert.equal(bal(live[3].id), START);
  assert.equal(h2.app.matches.getLobby(liveLobby.code).playerCount, 3);
  const match = await hostC.startLobby(liveLobby.code);
  assert.equal(match.playerCount, 3);
  assert.equal(h2.app.ledger.balance(ACCT.match(match.id)), STAKE * 3n);
  assert.deepEqual(h2.app.ledger.audit().problems, []);
  [hostC, g1C, g2C, g3C].forEach((c) => c.close());
  await h2.close();

  // a second restart: the unaccepted match is voided and refunded, nothing is refunded twice
  const h3 = await startApp({ dbPath: file });
  apps.push(h3);
  for (const p of [...live, ...stale]) assert.equal(h3.app.ledger.balance(ACCT.user(p.id)), START);
  assert.equal(h3.app.ledger.balance(ACCT.user(lone.id)), START - STAKE, "the loner's lobby is still open");
  assert.deepEqual(h3.app.ledger.audit().problems, []);
  await h3.close();
  fs.rmSync(file, { force: true }); fs.rmSync(file + "-wal", { force: true }); fs.rmSync(file + "-shm", { force: true });
});

test("a database from before multi-player lobbies upgrades in place and its open lobby still works", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const { MIGRATIONS } = await import("../src/db/schema.js");
  const file = path.join(os.tmpdir(), `duel-lobby-old-${process.pid}-${Date.now()}.db`);
  const old = new DatabaseSync(file);
  old.exec(MIGRATIONS[0]); old.exec(MIGRATIONS[1]); old.exec("PRAGMA user_version = 2");
  const addr = "0x" + "ab".repeat(20);
  old.prepare("INSERT INTO users (address, display_name, created_at) VALUES (?, ?, ?)").run(addr, "Old Host", Date.now());
  old.prepare("INSERT INTO tickets (user_id, game, stake, code, lobby_code, rating, state, created_at) VALUES (1, 'reaction', '0', 'QWERTYUP', 'QWERTYUP', 1200, 'queued', ?)").run(Date.now());
  old.close();

  const h = await startApp({ dbPath: file });
  apps.push(h);
  assert.equal(h.app.db.raw.prepare("PRAGMA user_version").get().user_version, MIGRATIONS.length);
  assert.ok(h.app.db.all("PRAGMA table_info(tickets)").some((c) => c.name === "lobby_ticket_id"));
  const lobby = h.app.matches.getLobby("QWERTYUP");
  assert.deepEqual([lobby.state, lobby.playerCount, lobby.host.name], ["open", 1, "Old Host"]);
  const guest = await h.player({ fund: 0n });
  const out = await guest.client.joinLobby("QWERTYUP");
  assert.equal(out.lobby.playerCount, 2);
  h.app.matches.startLobby(1, "QWERTYUP");
  assert.equal((await guest.client.waitFor("match.found")).match.playerCount, 2);
  await h.close();
  fs.rmSync(file, { force: true }); fs.rmSync(file + "-wal", { force: true }); fs.rmSync(file + "-shm", { force: true });
});

test("if a full lobby cannot start, it stays open and intact: nothing is lost, the host can start it once the fault is gone", async () => {
  const h = await boot({ match: { lobbyMaxPlayers: 2 } });
  const [host, guest, late] = await crew(h, 3);
  const lobby = await mk(host);
  // make creating a match fail (a storage error in the middle of the start)
  h.app.db.raw.exec("CREATE TRIGGER no_matches BEFORE INSERT ON matches BEGIN SELECT RAISE(ABORT, 'disk full'); END");
  const out = await guest.client.joinLobby(lobby.code);
  assert.deepEqual(Object.keys(out), ["lobby"], "the join itself succeeded; there is just no match");
  assert.equal(out.lobby.state, "open");
  assert.equal(out.lobby.playerCount, 2);
  assert.equal(guest.bal(), START - STAKE);
  assert.equal(h.app.db.get("SELECT COUNT(*) AS n FROM match_players").n, 0, "the failed start rolled back completely");
  assert.equal(escrow(h), STAKE * 2n, "both stakes still sit in their tickets");
  await assert.rejects(late.client.joinLobby(lobby.code), { code: "LOBBY_FULL" });
  await assert.rejects(host.client.startLobby(lobby.code), { code: "INTERNAL" });
  assert.equal((await host.client.getLobby(lobby.code)).state, "open");
  h.app.db.raw.exec("DROP TRIGGER no_matches");
  const match = await host.client.startLobby(lobby.code);
  assert.equal(match.playerCount, 2);
  assert.equal(h.app.ledger.balance(ACCT.match(match.id)), STAKE * 2n);
  audit(h);
});
