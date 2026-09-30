/* Sign-in with an Ethereum wallet (EIP-4361-style message, EIP-191 personal_sign).

     1. POST /auth/nonce  {address}                → server stores a one-time message and returns it
     2. wallet signs the message (no gas, no funds move)
     3. POST /auth/login  {address, nonce, signature} → server recovers the signer, opens a session

   The session token is a random bearer secret; only its SHA-256 is stored, so a database leak does not leak sessions.
   Contract wallets (EIP-1271) are not supported: signatures must recover to the address (an EOA). */
import crypto from "node:crypto";
import { verifyMessage, getAddress } from "ethers";
import { AppError, bad, forbidden } from "./util/errors.js";
import { normalizeAddress } from "./util/address.js";

const MAX_SESSIONS_PER_USER = 10;
const MAX_NONCES_PER_ADDRESS = 5;
const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");

export class Auth {
  constructor({ db, users, config, chainId = () => 0, now = () => Date.now() }) {
    this.db = db;
    this.users = users;
    this.cfg = config;
    this.chainId = chainId;
    this.now = now;
  }

  issueNonce(addressInput) {
    const address = normalizeAddress(addressInput);
    const nonce = crypto.randomBytes(16).toString("hex");
    const issued = new Date(this.now());
    const expiresAt = this.now() + this.cfg.auth.nonceTtlMs;
    const domain = this.cfg.publicDomain;
    const message = [
      `${domain} wants you to sign in with your Ethereum account:`,
      getAddress(address),
      "",
      "Sign in to Duel.gold. This request does not cost gas and cannot move funds.",
      "",
      `URI: https://${domain}`,
      "Version: 1",
      `Chain ID: ${this.chainId()}`,
      `Nonce: ${nonce}`,
      `Issued At: ${issued.toISOString()}`,
      `Expiration Time: ${new Date(expiresAt).toISOString()}`,
    ].join("\n");
    this.db.tx(() => {
      this.db.run("DELETE FROM auth_nonces WHERE expires_at < ?", this.now());
      // keep only the newest few pending nonces per address so the table cannot be flooded
      this.db.run(
        `DELETE FROM auth_nonces WHERE address = ? AND nonce NOT IN
           (SELECT nonce FROM auth_nonces WHERE address = ? ORDER BY expires_at DESC LIMIT ?)`,
        address, address, MAX_NONCES_PER_ADDRESS - 1);
      this.db.run("INSERT INTO auth_nonces (nonce, address, message, expires_at) VALUES (?, ?, ?, ?)", nonce, address, message, expiresAt);
    });
    return { nonce, message, expiresAt };
  }

  login({ address: addressInput, nonce, signature, ip = null }) {
    const address = normalizeAddress(addressInput);
    if (typeof nonce !== "string" || !/^[0-9a-f]{32}$/.test(nonce)) throw bad("BAD_NONCE", "Missing or malformed nonce.");
    if (typeof signature !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(signature)) throw bad("BAD_SIGNATURE", "Signature must be a 65-byte hex string.");

    const row = this.db.get("SELECT * FROM auth_nonces WHERE nonce = ?", nonce);
    if (!row || row.address !== address) throw new AppError("BAD_NONCE", "Unknown nonce. Request a new one.", 401);
    if (row.expires_at < this.now()) {
      this.db.run("DELETE FROM auth_nonces WHERE nonce = ?", nonce);
      throw new AppError("NONCE_EXPIRED", "That sign-in request expired. Request a new one.", 401);
    }
    let signer;
    try { signer = verifyMessage(row.message, signature).toLowerCase(); }
    catch { throw new AppError("BAD_SIGNATURE", "Signature could not be verified.", 401); }
    // a wrong signature does not consume the nonce, so nobody can burn another wallet's pending sign-in
    if (signer !== address) throw new AppError("BAD_SIGNATURE", "Signature does not match the address.", 401);

    return this.db.tx(() => {
      this.db.run("DELETE FROM auth_nonces WHERE nonce = ?", nonce); // single use
      const { user, created } = this.users.getOrCreate(address);
      if (user.banned) throw forbidden("ACCOUNT_BANNED", "This account is suspended.");
      const token = "dg_" + crypto.randomBytes(32).toString("base64url");
      const expiresAt = this.now() + this.cfg.auth.sessionTtlMs;
      this.db.run("INSERT INTO sessions (token_hash, user_id, created_at, expires_at, ip) VALUES (?, ?, ?, ?, ?)", sha256(token), user.id, this.now(), expiresAt, ip);
      this.db.run(
        `DELETE FROM sessions WHERE user_id = ? AND token_hash NOT IN
           (SELECT token_hash FROM sessions WHERE user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?)`,
        user.id, user.id, MAX_SESSIONS_PER_USER);
      return { token, expiresAt, user, created };
    });
  }

  /* bearer token → user row, or null */
  authenticate(token) {
    if (typeof token !== "string" || token.length < 20 || token.length > 100) return null;
    const s = this.db.get("SELECT user_id, expires_at FROM sessions WHERE token_hash = ?", sha256(token));
    if (!s) return null;
    if (s.expires_at < this.now()) {
      this.db.run("DELETE FROM sessions WHERE token_hash = ?", sha256(token));
      return null;
    }
    const user = this.users.byId(s.user_id);
    return user && !user.banned ? user : null;
  }

  logout(token) {
    this.db.run("DELETE FROM sessions WHERE token_hash = ?", sha256(String(token)));
  }

  purge() {
    this.db.run("DELETE FROM auth_nonces WHERE expires_at < ?", this.now());
    this.db.run("DELETE FROM sessions WHERE expires_at < ?", this.now());
  }
}
