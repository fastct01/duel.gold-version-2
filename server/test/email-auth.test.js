/* Email accounts: sign up → confirm by link → sign in; private answers; password reset; linking a wallet (the only place
   withdrawals can go); the switch-off; and the users-table migration that lets an account exist without a wallet. */
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { Wallet } from "ethers";
import { DatabaseSync } from "node:sqlite";
import { startApp } from "./helpers/app.js";
import { DuelClient } from "../client/duel-client.js";
import { Db } from "../src/db/index.js";
import { MIGRATIONS } from "../src/db/schema.js";

const apps = [];
const boot = async (over) => { const h = await startApp(over); apps.push(h); return h; };
after(async () => { for (const h of apps) await h.close(); });

const call = async (h, method, path, body, token) => {
  const res = await fetch(h.url + path, {
    method,
    headers: { ...(body ? { "content-type": "application/json" } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => null) };
};
const outbox = (h) => h.app.mailer.outbox;
const lastTo = (h, to) => [...outbox(h)].reverse().find((m) => m.to === to);
const linkToken = (mail, kind) => (mail && mail.text.match(new RegExp(`[?&]${kind}=([A-Za-z0-9_-]+)`)) || [])[1];
const PW = "correct horse battery";

async function signUpAndVerify(h, email, password = PW) {
  assert.deepEqual((await call(h, "POST", "/v1/auth/email/signup", { email, password })).json, { ok: true });
  const token = linkToken(lastTo(h, email), "verify");
  assert.ok(token, "the confirmation email carries a verify link");
  const v = await call(h, "POST", "/v1/auth/email/verify", { token });
  assert.equal(v.status, 200);
  return v.json;
}

test("sign up, confirm by link, sign in; the account has an email and no wallet yet", async () => {
  const h = await boot();
  assert.equal((await call(h, "GET", "/v1/config")).json.auth.email, true);

  assert.deepEqual((await call(h, "POST", "/v1/auth/email/signup", { email: "Ada@Example.com", password: PW })).json, { ok: true });
  // not confirmed yet: the right password is refused and a fresh link is sent
  const early = await call(h, "POST", "/v1/auth/email/login", { email: "ada@example.com", password: PW });
  assert.equal(early.status, 403);
  assert.equal(early.json.error.code, "EMAIL_UNVERIFIED");

  const token = linkToken(lastTo(h, "ada@example.com"), "verify");
  const v = await call(h, "POST", "/v1/auth/email/verify", { token });
  assert.equal(v.status, 200);
  assert.match(v.json.token, /^dg_/);
  assert.equal(v.json.me.email, "ada@example.com");
  assert.equal(v.json.me.emailVerified, true);
  assert.equal(v.json.me.hasWallet, false);
  assert.equal(v.json.me.address, null);
  assert.equal((await call(h, "POST", "/v1/auth/email/verify", { token })).json.error.code, "BAD_LINK", "a link works once");

  const login = await call(h, "POST", "/v1/auth/email/login", { email: " ADA@example.com ", password: PW });
  assert.equal(login.status, 200);
  const me = await call(h, "GET", "/v1/me", null, login.json.token);
  assert.equal(me.json.email, "ada@example.com");

  // the same session token works for the realtime socket, like a wallet session
  const c = new DuelClient({ baseUrl: h.url, address: null, sign: () => { throw new Error("no wallet"); } });
  c.token = login.json.token;
  await c.connect();
  c.close();
});

test("answers never reveal whether an email has an account", async () => {
  const h = await boot();
  await signUpAndVerify(h, "bo@example.com");
  const wrong = await call(h, "POST", "/v1/auth/email/login", { email: "bo@example.com", password: "not the password" });
  const nobody = await call(h, "POST", "/v1/auth/email/login", { email: "nobody@example.com", password: "not the password" });
  assert.equal(wrong.status, 401);
  assert.deepEqual(wrong.json, nobody.json, "wrong password and unknown email answer identically");

  // signing up again with a confirmed email: same answer, no second account, the owner is told
  const before = outbox(h).length;
  assert.deepEqual((await call(h, "POST", "/v1/auth/email/signup", { email: "bo@example.com", password: "another password" })).json, { ok: true });
  assert.match(outbox(h)[before].subject, /tried to sign up/);
  assert.equal(h.app.db.get("SELECT COUNT(*) AS n FROM users WHERE email = ?", "bo@example.com").n, 1);
  assert.equal((await call(h, "POST", "/v1/auth/email/login", { email: "bo@example.com", password: "another password" })).status, 401, "the old password still holds");

  // forgot password for an unknown email: same answer, nothing sent
  const n = outbox(h).length;
  assert.deepEqual((await call(h, "POST", "/v1/auth/email/forgot", { email: "ghost@example.com" })).json, { ok: true });
  assert.equal(outbox(h).length, n);

  // input checks
  assert.equal((await call(h, "POST", "/v1/auth/email/signup", { email: "not-an-email", password: PW })).json.error.code, "BAD_EMAIL");
  assert.equal((await call(h, "POST", "/v1/auth/email/signup", { email: "c@example.com", password: "short" })).json.error.code, "WEAK_PASSWORD");
});

test("an unconfirmed sign-up by someone else cannot lock the owner out", async () => {
  const h = await boot();
  await call(h, "POST", "/v1/auth/email/signup", { email: "dee@example.com", password: "squatter password" });
  await signUpAndVerify(h, "dee@example.com", "owner password!");
  assert.equal((await call(h, "POST", "/v1/auth/email/login", { email: "dee@example.com", password: "owner password!" })).status, 200);
  assert.equal((await call(h, "POST", "/v1/auth/email/login", { email: "dee@example.com", password: "squatter password" })).status, 401);
});

test("password reset: one-time link, new password works, every other session ends", async () => {
  const h = await boot();
  const first = await signUpAndVerify(h, "eve@example.com");
  assert.deepEqual((await call(h, "POST", "/v1/auth/email/forgot", { email: "eve@example.com" })).json, { ok: true });
  const token = linkToken(lastTo(h, "eve@example.com"), "reset");
  assert.ok(token);
  assert.equal((await call(h, "POST", "/v1/auth/email/reset", { token, password: "short" })).json.error.code, "WEAK_PASSWORD");
  const r = await call(h, "POST", "/v1/auth/email/reset", { token, password: "a brand new password" });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal((await call(h, "GET", "/v1/me", null, first.token)).status, 401, "the old session ended");
  assert.equal((await call(h, "GET", "/v1/me", null, r.json.token)).status, 200);
  assert.equal((await call(h, "POST", "/v1/auth/email/login", { email: "eve@example.com", password: PW })).status, 401);
  assert.equal((await call(h, "POST", "/v1/auth/email/login", { email: "eve@example.com", password: "a brand new password" })).status, 200);
  assert.equal((await call(h, "POST", "/v1/auth/email/reset", { token, password: "yet another password" })).json.error.code, "BAD_LINK");
});

test("linking a wallet: proven by signature, once, never a wallet that has its own account; it then signs in to the same account", async () => {
  const h = await boot();
  const s = await signUpAndVerify(h, "fay@example.com");
  const w = Wallet.createRandom();
  const link = async (wallet, token) => {
    const n = await call(h, "POST", "/v1/auth/nonce", { address: wallet.address });
    return call(h, "POST", "/v1/me/wallet/link", { address: wallet.address, nonce: n.json.nonce, signature: await wallet.signMessage(n.json.message) }, token);
  };
  // a signature from a different wallet is refused
  const n = await call(h, "POST", "/v1/auth/nonce", { address: w.address });
  const forged = await call(h, "POST", "/v1/me/wallet/link", { address: w.address, nonce: n.json.nonce, signature: await Wallet.createRandom().signMessage(n.json.message) }, s.token);
  assert.equal(forged.status, 401);

  const ok = await link(w, s.token);
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.equal(ok.json.hasWallet, true);
  assert.equal(ok.json.address, w.address);
  assert.match(lastTo(h, "fay@example.com").subject, /wallet was linked/);
  assert.equal((await link(Wallet.createRandom(), s.token)).json.error.code, "WALLET_LINKED", "one wallet per account, never replaced");

  // the linked wallet signs in to the very same account
  const c = new DuelClient({ baseUrl: h.url, address: w.address, sign: (m) => w.signMessage(m) });
  await c.login();
  assert.equal(c.me.id, s.me.id);
  assert.equal(c.me.email, "fay@example.com");

  // a wallet that already has its own account cannot be linked to an email account
  const p = await h.player({ fund: 0n });
  const other = await signUpAndVerify(h, "gus@example.com");
  assert.equal((await link(p.wallet, other.token)).json.error.code, "WALLET_IN_USE");
});

test("email sign-in can be switched off (production without RESEND_API_KEY): the endpoints refuse and /v1/config says so", async () => {
  const h = await boot({ mail: { enabled: false } });
  assert.equal((await call(h, "GET", "/v1/config")).json.auth.email, false);
  const r = await call(h, "POST", "/v1/auth/email/signup", { email: "hal@example.com", password: PW });
  assert.equal(r.status, 403);
  assert.equal(r.json.error.code, "EMAIL_AUTH_OFF");
});

test("migration 7 keeps every user, session and reference, and lets an account exist without a wallet", () => {
  const raw = new DatabaseSync(":memory:");
  raw.exec("PRAGMA foreign_keys = ON");
  for (let v = 0; v < 6; v++) { // the schema as it was before email accounts
    if (typeof MIGRATIONS[v] === "function") MIGRATIONS[v](raw); else raw.exec(MIGRATIONS[v]);
  }
  raw.exec("PRAGMA user_version = 6");
  raw.prepare("INSERT INTO users (address, display_name, created_at, loss_limit) VALUES (?, ?, ?, ?)").run("0x" + "ab".repeat(20), "Old timer", 1, "5");
  raw.prepare("INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES ('h', 1, 1, 9)").run();
  // hand the same connection to Db by pointing it at the database: Db only takes a file, so migrate the raw handle the way Db does
  const db = Object.create(Db.prototype);
  db.raw = raw;
  db.migrate();
  assert.equal(raw.prepare("PRAGMA user_version").get().user_version, MIGRATIONS.length);
  const u = raw.prepare("SELECT * FROM users WHERE id = 1").get();
  assert.equal(u.address, "0x" + "ab".repeat(20));
  assert.equal(u.display_name, "Old timer");
  assert.equal(u.loss_limit, "5");
  assert.equal(u.email, null);
  assert.equal(raw.prepare("SELECT user_id FROM sessions").get().user_id, 1);
  raw.prepare("INSERT INTO users (address, email, display_name, created_at) VALUES (NULL, 'x@example.com', 'New', 2)").run();
  assert.equal(raw.prepare("PRAGMA foreign_key_check").all().length, 0);
  assert.equal(raw.prepare("PRAGMA foreign_keys").get().foreign_keys, 1, "foreign keys are back on");
  assert.throws(() => raw.prepare("INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES ('z', 999, 1, 9)").run(), /FOREIGN KEY/);
});
