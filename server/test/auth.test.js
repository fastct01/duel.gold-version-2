import test from "node:test";
import assert from "node:assert/strict";
import { Wallet } from "ethers";
import { Db } from "../src/db/index.js";
import { Users } from "../src/users.js";
import { Auth } from "../src/auth.js";
import { loadConfig } from "../src/config.js";

function setup() {
  const clock = { t: 1_800_000_000_000 };
  const now = () => clock.t;
  const db = new Db(":memory:");
  const users = new Users(db, now);
  const config = loadConfig({ NODE_ENV: "test" }, { publicDomain: "duel.test" });
  const auth = new Auth({ db, users, config, chainId: () => 31337, now });
  return { clock, db, users, auth, config };
}
async function signIn(auth, wallet, opts = {}) {
  const { nonce, message } = auth.issueNonce(opts.claimAddress ?? wallet.address);
  const signature = await wallet.signMessage(message);
  return auth.login({ address: opts.claimAddress ?? wallet.address, nonce, signature, ip: "127.0.0.1" });
}

test("wallet signature opens a session; only the token hash is stored", async () => {
  const { auth, db } = setup();
  const w = Wallet.createRandom();
  const { token, user, created } = await signIn(auth, w);
  assert.equal(created, true);
  assert.equal(user.address, w.address.toLowerCase());
  assert.equal(auth.authenticate(token).id, user.id);
  const rows = db.all("SELECT token_hash FROM sessions");
  assert.equal(rows.length, 1);
  assert.notEqual(rows[0].token_hash, token);
  assert.ok(!JSON.stringify(db.all("SELECT * FROM sessions")).includes(token));
});

test("the sign-in message names the domain, chain and nonce (EIP-4361 shape)", () => {
  const { auth } = setup();
  const w = Wallet.createRandom();
  const { message, nonce } = auth.issueNonce(w.address);
  assert.match(message, /^duel\.test wants you to sign in with your Ethereum account:\n0x[0-9a-fA-F]{40}\n/);
  assert.ok(message.includes("Chain ID: 31337"));
  assert.ok(message.includes(`Nonce: ${nonce}`));
  assert.ok(message.includes("Expiration Time:"));
});

test("a signature from the wrong wallet is refused and does not burn the nonce", async () => {
  const { auth } = setup();
  const victim = Wallet.createRandom(), attacker = Wallet.createRandom();
  const { nonce, message } = auth.issueNonce(victim.address);
  const forged = await attacker.signMessage(message);
  assert.throws(() => auth.login({ address: victim.address, nonce, signature: forged }), { code: "BAD_SIGNATURE" });
  const good = await victim.signMessage(message);
  assert.ok(auth.login({ address: victim.address, nonce, signature: good }).token, "the victim can still sign in with the same nonce");
});

test("a nonce is single use", async () => {
  const { auth } = setup();
  const w = Wallet.createRandom();
  const { nonce, message } = auth.issueNonce(w.address);
  const signature = await w.signMessage(message);
  auth.login({ address: w.address, nonce, signature });
  assert.throws(() => auth.login({ address: w.address, nonce, signature }), { code: "BAD_NONCE" });
});

test("a nonce issued for one address cannot be used by another", async () => {
  const { auth } = setup();
  const a = Wallet.createRandom(), b = Wallet.createRandom();
  const { nonce, message } = auth.issueNonce(a.address);
  const sigB = await b.signMessage(message);
  assert.throws(() => auth.login({ address: b.address, nonce, signature: sigB }), { code: "BAD_NONCE" });
});

test("expired nonces and expired sessions are refused", async () => {
  const { auth, clock, config } = setup();
  const w = Wallet.createRandom();
  const { nonce, message } = auth.issueNonce(w.address);
  const signature = await w.signMessage(message);
  clock.t += config.auth.nonceTtlMs + 1;
  assert.throws(() => auth.login({ address: w.address, nonce, signature }), { code: "NONCE_EXPIRED" });

  const { token } = await signIn(auth, w);
  assert.ok(auth.authenticate(token));
  clock.t += config.auth.sessionTtlMs + 1;
  assert.equal(auth.authenticate(token), null);
});

test("malformed input is rejected before any crypto", () => {
  const { auth } = setup();
  const w = Wallet.createRandom();
  const { nonce } = auth.issueNonce(w.address);
  assert.throws(() => auth.issueNonce("not-an-address"), { code: "BAD_ADDRESS" });
  assert.throws(() => auth.login({ address: w.address, nonce: "zz", signature: "0x" + "00".repeat(65) }), { code: "BAD_NONCE" });
  assert.throws(() => auth.login({ address: w.address, nonce, signature: "0x1234" }), { code: "BAD_SIGNATURE" });
  assert.throws(() => auth.login({ address: w.address, nonce, signature: "0x" + "00".repeat(65) }), { code: "BAD_SIGNATURE" });
});

test("mixed-case address with a bad checksum is refused; lowercase and checksummed both work", () => {
  const { auth } = setup();
  const w = Wallet.createRandom();
  assert.ok(auth.issueNonce(w.address.toLowerCase()).nonce);
  assert.ok(auth.issueNonce(w.address).nonce);
  const broken = w.address.replace(/[a-f]/, (c) => c.toUpperCase()).replace(/[A-F]/, (c) => c.toLowerCase());
  if (broken !== w.address && broken !== w.address.toLowerCase()) assert.throws(() => auth.issueNonce(broken), { code: "BAD_ADDRESS" });
});

test("logout revokes the token; sessions per user are capped", async () => {
  const { auth, db } = setup();
  const w = Wallet.createRandom();
  const first = await signIn(auth, w);
  auth.logout(first.token);
  assert.equal(auth.authenticate(first.token), null);
  for (let i = 0; i < 14; i++) await signIn(auth, w);
  assert.equal(db.get("SELECT COUNT(*) AS n FROM sessions").n, 10);
});

test("banned accounts cannot sign in or use an existing session", async () => {
  const { auth, db } = setup();
  const w = Wallet.createRandom();
  const { token, user } = await signIn(auth, w);
  db.run("UPDATE users SET banned = 1 WHERE id = ?", user.id);
  assert.equal(auth.authenticate(token), null);
  await assert.rejects(signIn(auth, w), { code: "ACCOUNT_BANNED" });
});

test("pending nonces per address are capped so the table cannot be flooded", () => {
  const { auth, db } = setup();
  const w = Wallet.createRandom();
  for (let i = 0; i < 20; i++) auth.issueNonce(w.address);
  assert.equal(db.get("SELECT COUNT(*) AS n FROM auth_nonces").n, 5);
});

test("display names: validated, normalised and never address-shaped", async () => {
  const { auth, users } = setup();
  const { user } = await signIn(auth, Wallet.createRandom());
  assert.match(user.display_name, /^Player-/);
  assert.equal(users.setDisplayName(user.id, "  Mira   Kay  "), "Mira Kay");
  assert.equal(users.setDisplayName(user.id, "Ana_B-2.0"), "Ana_B-2.0");
  assert.equal(users.setDisplayName(user.id, "a\nb\tc"), "a b c", "line breaks and tabs collapse to one space");
  for (const bad of ["ab", "x".repeat(21), "<script>", "0xdeadbeefcafe", "   ", "..-", "_name", "name-", "a\u0000b", "ab‮cd", "a​b!"]) {
    assert.throws(() => users.setDisplayName(user.id, bad), { code: "BAD_NAME" }, JSON.stringify(bad));
  }
});
