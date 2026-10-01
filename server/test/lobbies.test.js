/* Invite-only lobbies: create → share code → friend joins → normal match flow; refunds, races, admission rules. */
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

test("create → public get → join → both get match.found → play → settle", async () => {
  const h = await boot();
  const [host, guest] = [await h.player({ name: "Hosty" }), await h.player()];
  const before = host.bal();
  const lobby = await mk(host);
  assert.match(lobby.code, /^[A-HJKMNP-Z2-9]{8}$/);
  assert.equal(lobby.state, "open");
  assert.equal(lobby.host.name, "Hosty");
  assert.equal(lobby.stake, String(STAKE));
  assert.equal(lobby.pot, String(STAKE * 2n));
  assert.equal(lobby.winnerPayout, String(STAKE * 2n - STAKE * 2n / 10n));
  assert.equal(lobby.game.id, GAME);
  assert.ok(lobby.expiresAt > lobby.createdAt);
  assert.equal(host.bal(), before - STAKE, "host stake escrowed");
  const created = await host.client.waitFor("lobby.created");
  assert.equal(created.lobby.code, lobby.code);

  // /me shows the open lobby
  const me = await host.client.api("GET", "/v1/me");
  assert.equal(me.active.kind, "lobby");
  assert.equal(me.active.lobby.code, lobby.code);
  assert.equal(me.balances.inPlay, String(STAKE));

  // public GET, no auth
  const res = await fetch(`${h.url}/v1/lobbies/${lobby.code}`);
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()).lobby, lobby);

  const match = await guest.client.joinLobby(lobby.code);
  assert.equal(match.state, "found");
  assert.equal(match.private, true);
  assert.equal(match.opponent.name, "Hosty");
  const [fh, fg] = await Promise.all([host.client.waitFor("match.found"), guest.client.waitFor("match.found")]);
  assert.equal(fh.match.id, match.id);
  assert.equal(fg.match.id, match.id);
  assert.equal(host.bal(), before - STAKE);
  assert.equal(guest.bal(), 100n * mETH - STAKE);

  const closed = await host.client.getLobby(lobby.code);
  assert.equal(closed.state, "matched");
  assert.equal(closed.closedReason, "matched");
  assert.equal(closed.matchId, match.id);
  await assert.rejects(guest.client.joinLobby(lobby.code), { code: "LOBBY_CLOSED" });

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
  assert.equal(m.state, "found");
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

test("concurrent double-join: exactly one wins, the loser is not charged, audit is clean", async () => {
  const h = await boot();
  const host = await h.player();
  const guests = [await h.player(), await h.player(), await h.player()];
  const lobby = await mk(host);
  const results = await Promise.allSettled(guests.map((g) => g.client.joinLobby(lobby.code)));
  const won = results.filter((r) => r.status === "fulfilled");
  const lost = results.filter((r) => r.status === "rejected");
  assert.equal(won.length, 1);
  assert.equal(lost.length, 2);
  for (const l of lost) assert.equal(l.reason.code, "LOBBY_CLOSED");
  guests.forEach((g, i) => assert.equal(g.bal(), results[i].status === "fulfilled" ? 100n * mETH - STAKE : 100n * mETH));
  assert.equal(h.app.db.get("SELECT COUNT(*) AS n FROM matches").n, 1);
  assert.equal(escrowTotal(h), Number(STAKE * 2n));
  audit(h);
});

test("host cancelling while a guest joins gives one consistent outcome", async () => {
  for (let i = 0; i < 5; i++) {
    const h = await boot();
    const [host, guest] = [await h.player(), await h.player()];
    const lobby = await mk(host);
    const [c, j] = await Promise.allSettled([host.client.closeLobby(lobby.code), guest.client.joinLobby(lobby.code)]);
    if (c.status === "fulfilled") {
      assert.equal(j.status, "rejected");
      assert.equal(j.reason.code, "LOBBY_CLOSED");
      assert.equal(host.bal(), 100n * mETH);
      assert.equal(guest.bal(), 100n * mETH);
    } else {
      assert.equal(c.reason.code, "LOBBY_CLOSED");
      assert.equal(j.status, "fulfilled");
      assert.equal(host.bal(), 100n * mETH - STAKE);
    }
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
  assert.equal((await friend.client.joinLobby(free.code)).stake, "0");
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
  assert.equal((await guest.joinLobby(keep.code)).state, "found");
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
  assert.equal(l2.playing, 0);
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
