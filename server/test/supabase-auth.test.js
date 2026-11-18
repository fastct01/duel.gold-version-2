/* Email accounts through Supabase Auth (src/supabaseAuth.js), against an in-memory stand-in for the Supabase Auth API:
   sign-up signs in at once with no email; sign-in checks the password with Supabase; a recovery link's token sets a new
   password and ends the other sessions; an older built-in sign-up with the same email is taken over; the key stays secret. */
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { startApp } from "./helpers/app.js";

const URL_ = "https://ref.supabase.test";
const KEY = "sb_secret_test_key";
const PW = "correct horse battery";

/* the parts of Supabase Auth the server uses, with its status codes and error shapes */
function fakeSupabase() {
  const users = new Map(); // email → { id, email, password }
  const tokens = new Map(); // access token → user id
  const calls = [];
  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const byId = (id) => [...users.values()].find((u) => u.id === id);
  const fetchImpl = async (url, init) => {
    const u = new URL(url);
    const path = u.pathname.replace(/^\/auth\/v1/, "");
    const body = init.body ? JSON.parse(init.body) : {};
    calls.push({ method: init.method, path, search: u.search, headers: init.headers, body });
    if (init.headers.apikey !== KEY) return json(401, { message: "Invalid API key" });
    const admin = init.headers.authorization === `Bearer ${KEY}`;
    if (init.method === "POST" && path === "/admin/users") {
      if (!admin) return json(403, { code: "not_admin" });
      if (users.has(body.email)) return json(422, { code: 422, error_code: "email_exists", msg: "A user with this email address has already been registered" });
      const user = { id: randomUUID(), email: body.email, password: body.password, confirmed: !!body.email_confirm };
      users.set(body.email, user);
      return json(200, { id: user.id, email: user.email });
    }
    if (init.method === "POST" && path === "/token" && u.searchParams.get("grant_type") === "password") {
      const user = users.get(body.email);
      if (!user || user.password !== body.password || !user.confirmed) return json(400, { code: 400, error_code: "invalid_credentials", msg: "Invalid login credentials" });
      return json(200, { access_token: "at", user: { id: user.id, email: user.email } });
    }
    if (init.method === "POST" && path === "/recover") {
      const user = users.get(body.email);
      if (user) { const t = `recovery-${randomUUID()}`; tokens.set(t, user.id); fake.lastRecovery = { email: body.email, token: t, redirect: u.searchParams.get("redirect_to") }; }
      return json(200, {});
    }
    const bearer = String(init.headers.authorization || "").replace(/^Bearer /, "");
    if (init.method === "GET" && path === "/user") {
      const id = tokens.get(bearer);
      return id ? json(200, { id, email: byId(id).email }) : json(403, { error_code: "session_not_found" });
    }
    const m = path.match(/^\/admin\/users\/(.+)$/);
    if (init.method === "PUT" && m && admin) { const user = byId(decodeURIComponent(m[1])); if (!user) return json(404, {}); user.password = body.password;
      for (const [t, id] of tokens) if (id === user.id) tokens.delete(t); // like Supabase: a new password ends every session
      return json(200, { id: user.id }); }
    return json(404, { msg: "not found" });
  };
  const fake = { users, calls, fetchImpl, lastRecovery: null };
  return fake;
}

const apps = [];
async function boot(fake = fakeSupabase(), over = {}) {
  const h = await startApp({ supabase: { url: URL_, secretKey: KEY }, mail: { publicUrl: "https://playvault.test" }, ...over }, { supabaseFetch: fake.fetchImpl });
  apps.push(h);
  return { h, fake };
}
after(async () => { for (const h of apps) await h.close(); });

const call = async (h, method, path, body, token) => {
  const res = await fetch(h.url + path, {
    method,
    headers: { ...(body ? { "content-type": "application/json" } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => null) };
};

test("sign up signs in at once, with no email; sign in checks the password with Supabase", async () => {
  const { h, fake } = await boot();
  assert.equal((await call(h, "GET", "/v1/config")).json.auth.email, true);

  const up = await call(h, "POST", "/v1/auth/email/signup", { email: "Ada@Example.com", password: PW });
  assert.equal(up.status, 200);
  assert.ok(up.json.token);
  assert.equal(up.json.created, true);
  assert.equal(up.json.me.email, "ada@example.com");
  assert.equal(up.json.me.hasWallet, false);
  assert.equal(h.app.mailer.outbox.length, 0, "no email is sent");
  const created = fake.calls.find((c) => c.path === "/admin/users");
  assert.deepEqual(created.body, { email: "ada@example.com", password: PW, email_confirm: true });
  assert.equal((await call(h, "GET", "/v1/me", null, up.json.token)).json.email, "ada@example.com");
  const row = await h.app.db.get("SELECT auth_id, password_hash FROM users WHERE email = ?", "ada@example.com");
  assert.equal(row.auth_id, fake.users.get("ada@example.com").id);
  assert.equal(row.password_hash, null, "the password lives only in Supabase");

  const again = await call(h, "POST", "/v1/auth/email/signup", { email: "ada@example.com", password: PW });
  assert.equal(again.status, 409);
  assert.equal(again.json.error.code, "EMAIL_TAKEN");

  const wrong = await call(h, "POST", "/v1/auth/email/login", { email: "ada@example.com", password: "not the password" });
  assert.equal(wrong.status, 401);
  assert.equal(wrong.json.error.code, "BAD_CREDENTIALS");
  const nobody = await call(h, "POST", "/v1/auth/email/login", { email: "nobody@example.com", password: PW });
  assert.equal(nobody.json.error.code, "BAD_CREDENTIALS", "an unknown email answers exactly like a wrong password");

  const inn = await call(h, "POST", "/v1/auth/email/login", { email: " ADA@example.com ", password: PW });
  assert.equal(inn.status, 200);
  assert.equal(inn.json.me.id, up.json.me.id, "the same PlayVault account");
  assert.equal(inn.json.created, false);
});

test("weak passwords are refused before Supabase is asked", async () => {
  const { h, fake } = await boot();
  const r = await call(h, "POST", "/v1/auth/email/signup", { email: "short@example.com", password: "short" });
  assert.equal(r.json.error.code, "WEAK_PASSWORD");
  assert.equal(fake.calls.length, 0);
});

test("forgot password: Supabase emails the link; its token sets a new password and ends the other sessions", async () => {
  const { h, fake } = await boot();
  const up = await call(h, "POST", "/v1/auth/email/signup", { email: "bo@example.com", password: PW });

  assert.deepEqual((await call(h, "POST", "/v1/auth/email/forgot", { email: "bo@example.com" })).json, { ok: true });
  assert.deepEqual((await call(h, "POST", "/v1/auth/email/forgot", { email: "ghost@example.com" })).json, { ok: true }, "same answer with no account");
  assert.equal(fake.lastRecovery.email, "bo@example.com");
  assert.equal(fake.lastRecovery.redirect, "https://playvault.test/", "the link comes back to the site");

  const NEW = "a brand new passphrase";
  const bad = await call(h, "POST", "/v1/auth/email/reset", { token: "recovery-not-a-real-token-at-all", password: NEW });
  assert.equal(bad.json.error.code, "LINK_EXPIRED");

  const r = await call(h, "POST", "/v1/auth/email/reset", { token: fake.lastRecovery.token, password: NEW });
  assert.equal(r.status, 200);
  assert.equal(r.json.me.id, up.json.me.id);
  assert.equal(r.json.me.emailVerified, true, "the link reached the inbox");
  assert.equal((await call(h, "GET", "/v1/me", null, up.json.token)).status, 401, "the old session is gone");

  const reused = await call(h, "POST", "/v1/auth/email/reset", { token: fake.lastRecovery.token, password: "yet another passphrase" });
  assert.equal(reused.json.error.code, "LINK_EXPIRED", "the link works once");
  assert.equal((await call(h, "POST", "/v1/auth/email/login", { email: "bo@example.com", password: PW })).status, 401);
  assert.equal((await call(h, "POST", "/v1/auth/email/login", { email: "bo@example.com", password: NEW })).status, 200);
});

test("an older unconfirmed built-in sign-up with the same email is taken over, not duplicated", async () => {
  const { h, fake } = await boot();
  const id = (await h.app.db.run("INSERT INTO users (email, password_hash, display_name, created_at) VALUES (?, ?, ?, ?) RETURNING id",
    "cy@example.com", "scrypt$old", "Player-old", Date.now())).lastInsertRowid;
  const up = await call(h, "POST", "/v1/auth/email/signup", { email: "cy@example.com", password: PW });
  assert.equal(up.status, 200);
  assert.equal(up.json.me.id, id);
  const row = await h.app.db.get("SELECT auth_id, password_hash FROM users WHERE id = ?", id);
  assert.equal(row.auth_id, fake.users.get("cy@example.com").id);
  assert.equal(row.password_hash, null);
});

test("Supabase trouble is reported as unavailable, and the secret key never shows in the config", async () => {
  const fake = fakeSupabase();
  const broken = { ...fake, fetchImpl: async () => { throw new Error("ECONNREFUSED"); } };
  const { h } = await boot(broken);
  const r = await call(h, "POST", "/v1/auth/email/login", { email: "x@example.com", password: PW });
  assert.equal(r.status, 503);
  assert.equal(r.json.error.code, "AUTH_UNAVAILABLE");
  assert.equal(JSON.stringify(h.app.config, (k, v) => (typeof v === "bigint" ? String(v) : v)).includes(KEY), false);
  assert.equal(h.app.config.supabase.secretKey, KEY, "still readable by the server itself");
  assert.equal(JSON.stringify((await call(h, "GET", "/v1/config")).json).includes(KEY), false);

  const { h: h2 } = await boot(fakeSupabase(), { supabase: { url: URL_, secretKey: "sb_secret_wrong" } });
  const w = await call(h2, "POST", "/v1/auth/email/signup", { email: "y@example.com", password: PW });
  assert.equal(w.json.error.code, "AUTH_UNAVAILABLE", "a wrong key is the operator's problem, not a wrong password");
});

test("without SUPABASE_* the built-in email accounts stay in charge", async () => {
  const h = await startApp();
  apps.push(h);
  assert.equal(h.app.emailAuth.constructor.name, "EmailAuth");
});
