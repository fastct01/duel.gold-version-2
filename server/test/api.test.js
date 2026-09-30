/* HTTP + WebSocket surface: errors, auth, admin, CORS/origin, limits, static files, socket abuse. */
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { Wallet } from "ethers";
import WebSocket from "ws";
import { startApp, sleep, mETH } from "./helpers/app.js";
import { DuelClient } from "../client/duel-client.js";

const apps = [];
const boot = async (over) => { const h = await startApp(over); apps.push(h); return h; };
after(async () => { for (const h of apps) await h.close(); });

const raw = async (h, method, path, { headers = {}, body } = {}) => {
  const res = await fetch(h.url + path, { method, headers, body });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, headers: res.headers, json, text };
};

/* ------------------------------------------------------------------ public endpoints */

test("public endpoints describe the platform without needing a session", async () => {
  const h = await boot();
  const cfg = (await raw(h, "GET", "/v1/config")).json;
  assert.equal(cfg.feeBps, 1000);
  assert.equal(cfg.chain, null, "no chain configured in this app");
  assert.match(cfg.notice, /Test network only/);
  assert.deepEqual(cfg.coolOffHours, [24, 168]);

  const { games } = (await raw(h, "GET", "/v1/games")).json;
  assert.equal(games.length, 22);
  assert.equal(games.filter((g) => g.pvp).length, 14);
  assert.ok(games.filter((g) => g.kind === "versus").every((g) => !g.pvp), "versus games are not offered for PvP yet");
  const reaction = games.find((g) => g.id === "reaction");
  assert.equal(reaction.maxSeconds, 30);
  assert.ok(!("raw" in reaction) && !("bot" in reaction), "no internals leak into the catalog");

  const health = (await raw(h, "GET", "/v1/health")).json;
  assert.equal(health.ok, true);
  assert.equal((await raw(h, "GET", "/v1/leaderboard?game=nope")).json.error.code, "UNKNOWN_GAME");
  assert.deepEqual((await raw(h, "GET", "/v1/leaderboard?game=aim")).json.players, []);
});

test("wallet endpoints report clearly when no chain is configured", async () => {
  const h = await boot();
  const p = await h.player({ connect: false });
  for (const [m, path, body] of [["GET", "/v1/wallet"], ["GET", "/v1/wallet/deposits"], ["GET", "/v1/wallet/withdrawals"], ["POST", "/v1/wallet/withdraw", { amount: "1" }]]) {
    await assert.rejects(p.client.api(m, path, body), { code: "WALLET_DISABLED", status: 503 }, path);
  }
  assert.ok((await p.client.api("GET", "/v1/wallet/history")).entries.length >= 1, "the ledger history still works");
});

/* ------------------------------------------------------------------ auth over HTTP */

test("sign-in works end to end over REST, and every failure has a stable error code", async () => {
  const h = await boot();
  const w = Wallet.createRandom();
  const post = (path, body) => raw(h, "POST", path, { headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  const n = (await post("/v1/auth/nonce", { address: w.address })).json;
  const sig = await w.signMessage(n.message);
  assert.equal((await post("/v1/auth/login", { address: w.address, nonce: n.nonce, signature: "0x" + (sig[2] === "0" ? "1" : "0") + sig.slice(3) })).json.error.code, "BAD_SIGNATURE"); // flip a nibble of r: a changed v byte can still be a valid signature
  assert.equal((await post("/v1/auth/login", { address: Wallet.createRandom().address, nonce: n.nonce, signature: sig })).json.error.code, "BAD_NONCE");
  const ok = (await post("/v1/auth/login", { address: w.address, nonce: n.nonce, signature: sig })).json;
  assert.match(ok.token, /^dg_/);
  assert.equal(ok.created, true);
  assert.equal(ok.me.address, w.address);
  assert.equal(ok.me.balances.available, "0");
  assert.equal((await post("/v1/auth/login", { address: w.address, nonce: n.nonce, signature: sig })).json.error.code, "BAD_NONCE", "replay refused");

  const authed = { authorization: `Bearer ${ok.token}` };
  assert.equal((await raw(h, "GET", "/v1/me", { headers: authed })).json.address, w.address);
  assert.equal((await raw(h, "GET", "/v1/me")).status, 401);
  assert.equal((await raw(h, "GET", "/v1/me", { headers: { authorization: "Bearer dg_nonsense_nonsense_nonsense" } })).status, 401);
  assert.equal((await raw(h, "POST", "/v1/auth/logout", { headers: authed })).status, 200);
  assert.equal((await raw(h, "GET", "/v1/me", { headers: authed })).status, 401, "the token is dead after logout");
});

test("profile and responsible-play endpoints", async () => {
  const h = await boot();
  const p = await h.player({ connect: false, adult: false });
  const api = p.client.api.bind(p.client);
  assert.equal((await api("GET", "/v1/me")).responsible.adultConfirmed, false);
  await assert.rejects(api("POST", "/v1/me/age", { adult: false }), { code: "BAD_REQUEST" });
  assert.equal((await api("POST", "/v1/me/age", { adult: true })).adultConfirmed, true);
  assert.equal((await api("PATCH", "/v1/me", { displayName: "  Zed  Zed " })).displayName, "Zed Zed");
  await assert.rejects(api("PATCH", "/v1/me", { displayName: "<b>" }), { code: "BAD_NAME" });

  assert.equal((await api("PUT", "/v1/me/loss-limit", { amount: "5000" })).applied, true);
  const looser = await api("PUT", "/v1/me/loss-limit", { amount: "9000" });
  assert.equal(looser.applied, false);
  assert.ok(looser.effectiveAt > Date.now() + 23 * 3600000, "loosening takes 24 hours");
  await assert.rejects(api("PUT", "/v1/me/loss-limit", { amount: "0" }), { code: "BAD_LIMIT" });
  await assert.rejects(api("PUT", "/v1/me/loss-limit", { amount: "nope" }), { code: "BAD_AMOUNT" });

  const cool = await api("POST", "/v1/me/cool-off", { hours: 168 });
  assert.ok(cool.until > Date.now() + 167 * 3600000);
  await assert.rejects(api("POST", "/v1/me/cool-off", { hours: 1 }), { code: "BAD_COOL_OFF" });
  assert.ok((await api("GET", "/v1/me")).responsible.coolOffUntil);
});

/* ------------------------------------------------------------------ request hygiene */

test("bad requests get clear 4xx errors, never a 500 or a stack trace", async () => {
  const h = await boot();
  const json = { "content-type": "application/json" };
  let r = await raw(h, "POST", "/v1/auth/nonce", { headers: { "content-type": "text/plain" }, body: "hello" });
  assert.equal(r.status, 415);
  r = await raw(h, "POST", "/v1/auth/nonce", { headers: json, body: "{not json" });
  assert.equal(r.status, 400); assert.equal(r.json.error.code, "BAD_JSON");
  r = await raw(h, "POST", "/v1/auth/nonce", { headers: json, body: "[1,2]" });
  assert.equal(r.json.error.code, "BAD_JSON", "arrays are not objects");
  r = await raw(h, "POST", "/v1/auth/nonce", { headers: json, body: JSON.stringify({ address: "x".repeat(100000) }) });
  assert.equal(r.status, 413); assert.equal(r.json.error.code, "BODY_TOO_LARGE");
  r = await raw(h, "POST", "/v1/auth/nonce", { headers: json, body: "{}" });
  assert.equal(r.status, 400); assert.equal(r.json.error.code, "BAD_ADDRESS");
  r = await raw(h, "GET", "/v1/%zz");
  assert.equal(r.status, 404);
  r = await raw(h, "DELETE", "/v1/games");
  assert.equal(r.status, 404);
  for (const res of [r]) assert.ok(!/at \w+ \(/.test(res.text), "no stack traces in bodies");
  assert.ok(r.headers.get("x-request-id"));
  assert.equal(r.headers.get("x-content-type-options"), "nosniff");
  assert.equal(r.headers.get("cache-control"), "no-store");
});

test("sign-in endpoints are rate limited per IP and say when to retry", async () => {
  const h = await boot({ rate: { authPerMin: 5 } });
  const post = () => raw(h, "POST", "/v1/auth/nonce", { headers: { "content-type": "application/json" }, body: JSON.stringify({ address: Wallet.createRandom().address }) });
  const codes = [];
  for (let i = 0; i < 8; i++) codes.push((await post()).status);
  assert.deepEqual(codes, [200, 200, 200, 200, 200, 429, 429, 429]);
  const limited = await post();
  assert.equal(limited.json.error.code, "RATE_LIMITED");
  assert.ok(Number(limited.headers.get("retry-after")) >= 1);
});

test("CORS: wildcard by default; with an allow-list only listed origins are reflected", async () => {
  const open = await boot();
  const r1 = await raw(open, "OPTIONS", "/v1/me", { headers: { origin: "https://anywhere.example", "access-control-request-method": "GET" } });
  assert.equal(r1.status, 204);
  assert.equal(r1.headers.get("access-control-allow-origin"), "*");
  assert.match(r1.headers.get("access-control-allow-headers"), /idempotency-key/);

  const locked = await boot({ allowedOrigins: ["https://duel.example"] });
  const ok = await raw(locked, "GET", "/v1/config", { headers: { origin: "https://duel.example" } });
  assert.equal(ok.headers.get("access-control-allow-origin"), "https://duel.example");
  const evil = await raw(locked, "GET", "/v1/config", { headers: { origin: "https://evil.example" } });
  assert.equal(evil.headers.get("access-control-allow-origin"), null);
});

test("the admin API is off without a token, and needs the exact token when on", async () => {
  const off = await boot();
  assert.equal((await raw(off, "GET", "/v1/admin/audit")).status, 404, "disabled admin API looks like it does not exist");
  const on = await boot({ adminToken: "correct-horse-battery-staple-token" });
  assert.equal((await raw(on, "GET", "/v1/admin/audit")).status, 401);
  assert.equal((await raw(on, "GET", "/v1/admin/audit", { headers: { authorization: "Bearer wrong" } })).status, 401);
  const p = await on.player({ connect: false });
  assert.equal((await raw(on, "GET", "/v1/admin/audit", { headers: { authorization: `Bearer ${p.client.token}` } })).status, 401, "a player session is not an admin token");
  const good = await raw(on, "GET", "/v1/admin/audit", { headers: { authorization: "Bearer correct-horse-battery-staple-token" } });
  assert.equal(good.status, 200);
  assert.equal(good.json.ok, true);
  assert.equal((await raw(on, "GET", "/v1/admin/flags", { headers: { authorization: "Bearer correct-horse-battery-staple-token" } })).status, 200);
});

/* ------------------------------------------------------------------ static files */

test("static files: the packs and the browser client are served, and nothing else is reachable", async () => {
  const h = await boot();
  assert.equal((await raw(h, "GET", "/game/core/sdk.js")).status, 200);
  assert.equal((await raw(h, "GET", "/game/games/reflex.js")).status, 200);
  for (const evil of ["/game/../package.json", "/game/%2e%2e/package.json", "/game/core/../../server/package.json", "/game/index.html", "/game/build.py", "/game/games/../../SPEC.md",
    "/play/../src/index.js", "/play/%2e%2e/%2e%2e/etc/passwd", "/game/core/%00.js", "/game/core"]) {
    const r = await raw(h, "GET", evil);
    assert.ok([404, 400].includes(r.status), `${evil} must not be served (got ${r.status})`);
  }
  const csp = (await raw(h, "GET", "/game/core/sdk.js")).headers.get("content-security-policy");
  assert.match(csp, /default-src 'self'/);
  assert.equal((await raw(h, "POST", "/game/core/sdk.js")).status, 404);
});

/* ------------------------------------------------------------------ WebSocket */

const openRaw = (h, opts) => new Promise((resolve, reject) => {
  const ws = new WebSocket(h.url.replace("http", "ws") + "/v1/ws", opts);
  const msgs = [];
  ws.on("message", (d) => msgs.push(JSON.parse(d.toString())));
  ws.on("open", () => resolve({ ws, msgs, closed: new Promise((r) => ws.on("close", (code) => r(code))) }));
  ws.on("unexpected-response", (_q, res) => reject(Object.assign(new Error("rejected"), { status: res.statusCode })));
  ws.on("error", reject);
});

test("WebSocket: hello first, auth required, bad tokens and silence are dropped", async () => {
  const h = await boot();
  const a = await openRaw(h);
  await sleep(50);
  assert.equal(a.msgs[0].type, "hello");
  assert.equal(a.msgs[0].protocol, 1);
  a.ws.send(JSON.stringify({ type: "queue.join", id: 1, game: "aim", stake: "0" }));
  await sleep(50);
  assert.deepEqual(a.msgs.find((m) => m.type === "ack"), { type: "ack", id: 1, ok: false, error: { code: "UNAUTHORIZED", message: "Send an auth message first." } });
  a.ws.send(JSON.stringify({ type: "auth", id: 2, token: "dg_wrong_wrong_wrong_wrong" }));
  assert.equal(await a.closed, 4001);

  const quiet = await openRaw(h);
  assert.equal(await quiet.closed, 4001, "no auth within 5 seconds");
});

test("WebSocket: malformed input is answered, not fatal; binary frames and floods are cut off", async () => {
  const h = await boot({ rate: { wsPerSec: 5 } });
  const p = await h.player({ connect: false });
  const s = await openRaw(h);
  s.ws.send(JSON.stringify({ type: "auth", id: 1, token: p.client.token }));
  await sleep(80);
  s.ws.send("not json");
  s.ws.send(JSON.stringify(["array"]));
  s.ws.send(JSON.stringify({ type: 5 }));
  s.ws.send(JSON.stringify({ type: "does.not.exist", id: 9 }));
  s.ws.send(JSON.stringify({ type: "queue.join", id: 10, game: {}, stake: [] }));
  s.ws.send(JSON.stringify({ type: "match.submit", id: 11, matchId: "abc; DROP TABLE users", score: 1 }));
  await sleep(120);
  const acks = s.msgs.filter((m) => m.type === "ack");
  assert.equal(acks.find((m) => m.id === 9).error.code, "UNKNOWN_TYPE");
  assert.ok(["UNKNOWN_GAME", "BAD_AMOUNT"].includes(acks.find((m) => m.id === 10).error.code));
  assert.equal(acks.find((m) => m.id === 11).error.code, "NOT_FOUND");
  assert.equal(s.msgs.filter((m) => m.type === "ack" && m.error && m.error.code === "BAD_JSON").length, 1);
  assert.ok(h.app.db.get("SELECT COUNT(*) AS n FROM users").n >= 1, "tables intact");

  for (let i = 0; i < 60; i++) s.ws.send(JSON.stringify({ type: "ping", t: i }));
  assert.equal(await s.closed, 4008, "flooding closes the socket");

  const b = await openRaw(h);
  b.ws.send(Buffer.from([1, 2, 3]));
  assert.equal(await b.closed, 1003);
});

test("WebSocket: origin allow-list applies to browsers; connections per account are capped", async () => {
  const locked = await boot({ allowedOrigins: ["https://duel.example"] });
  await assert.rejects(openRaw(locked, { headers: { origin: "https://evil.example" } }), { status: 403 });
  const good = await openRaw(locked, { headers: { origin: "https://duel.example" } });
  good.ws.close();
  const noOrigin = await openRaw(locked); // a non-browser client sends no Origin
  noOrigin.ws.close();

  const h = await boot();
  const p = await h.player({ connect: false });
  const socks = [];
  for (let i = 0; i < 7; i++) {
    const s = await openRaw(h);
    s.ws.send(JSON.stringify({ type: "auth", id: 1, token: p.client.token }));
    socks.push(s);
    await sleep(40);
  }
  const codes = await Promise.race([Promise.all(socks.slice(6).map((s) => s.closed)), sleep(500).then(() => null)]);
  assert.deepEqual(codes, [4009], "the 7th connection is refused");
  for (const s of socks) s.ws.close();
});

test("WebSocket: a session that expires stops working on the open socket", async () => {
  const h = await boot();
  const p = await h.player();
  h.app.db.run("UPDATE sessions SET expires_at = ? WHERE user_id = ?", Date.now() - 1, p.id); // the socket was authenticated earlier
  const closed = new Promise((r) => p.client.on("close", r));
  await assert.rejects(p.client.request("sync"), { code: "SESSION_EXPIRED" });
  assert.equal((await closed).code, 4003);
});

test("the client SDK surfaces server errors as typed exceptions", async () => {
  const h = await boot();
  const p = await h.player();
  await assert.rejects(p.client.joinQueue({ game: "nope" }), (e) => e.name === "DuelError" && e.code === "UNKNOWN_GAME");
  await assert.rejects(p.client.api("GET", "/v1/matches/xyz"), (e) => e.code === "NOT_FOUND" && e.status === 404);
  await assert.rejects(p.client.waitFor("match.found", null, 100), /timed out waiting/);
});

/* ------------------------------------------------------------------ security regressions */

test("the public /health never leaks the RPC URL (providers put API keys in it) even when the RPC is failing", async () => {
  const http = await import("node:http");
  const { HDNodeWallet } = await import("ethers");
  // an RPC that reports a valid chain id but fails everything else, at a URL that carries a "secret" key
  const rpc = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const m = JSON.parse(body || "{}");
      res.setHeader("content-type", "application/json");
      if (m.method === "eth_chainId") return res.end(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: "0x7a69" }));
      res.statusCode = 500;
      res.end("upstream exploded");
    });
  });
  await new Promise((r) => rpc.listen(0, "127.0.0.1", r));
  const secretUrl = `http://127.0.0.1:${rpc.address().port}/v2/SECRETKEY123456`;
  const logs = [];
  try {
  const h = await boot({ chain: { rpcUrl: secretUrl, pollMs: 50 }, keys: { mnemonic: HDNodeWallet.createRandom().mnemonic.phrase }, logLevel: "warn" });
  h.app.log.warn = (m, f) => logs.push(JSON.stringify({ m, f }));
  for (let i = 0; i < 60 && !h.app.wallet.deposits.lastError; i++) await sleep(50);
  assert.ok(h.app.wallet.deposits.lastError, "the scan really is failing");
  const health = await (await fetch(h.url + "/v1/health")).text();
  assert.ok(health.includes("lastError"), "the operator still sees that something is wrong");
  assert.ok(!health.includes("SECRETKEY123456") && !health.includes("/v2/"), `health leaked the RPC URL: ${health}`);
  assert.ok(!h.app.wallet.deposits.lastError.includes("SECRETKEY123456"));
  await sleep(150);
  assert.ok(!logs.join("\n").includes("SECRETKEY123456"), "warnings do not carry the key either");
  } finally { rpc.close(); }
});

test("logging out (or being banned) ends live WebSocket sessions, not just future REST calls", async () => {
  const h = await boot();
  const a = await h.player();
  assert.ok(await a.client.request("ping"), "works while signed in");
  const closed = new Promise((r) => a.client.on("close", r));
  await a.client.api("POST", "/v1/auth/logout");
  await assert.rejects(a.client.joinQueue({ game: "aim", stake: String(mETH) }), { code: "SESSION_EXPIRED" }, "a revoked token cannot stake over an open socket");
  assert.equal((await closed).code, 4003);
  assert.equal(h.app.db.get("SELECT COUNT(*) AS n FROM tickets WHERE user_id = ?", a.id).n, 0, "nothing was staked");

  const b = await h.player();
  h.app.db.run("UPDATE users SET banned = 1 WHERE id = ?", b.id);
  await assert.rejects(b.client.joinQueue({ game: "aim", stake: "0" }), { code: "SESSION_EXPIRED" }, "a banned player is cut off on their live socket");
});
