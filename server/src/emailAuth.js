/* Email accounts: sign up with an email and a password, confirm the address by a link, sign in, reset a forgotten password.

   Rules that keep money safe and accounts private:
   - Passwords are hashed with scrypt (random salt, N=2^14, r=8, p=1, 64-byte key) and compared in constant time. An unknown
     email still pays for one hash, so the response time does not reveal which emails have accounts.
   - Sign-up and "forgot password" answer the same way whether or not the email has an account; the inbox gets the news.
   - Links in emails are one-time random tokens; only their sha256 is stored. A reset ends every session of the account.
   - An email account has no wallet until one is linked by signature (once; never replaced from an email session). Withdrawals
     go only to that wallet, so a stolen password cannot send funds anywhere else. Linking sends a notice to the inbox. */
import crypto from "node:crypto";
import { promisify } from "node:util";
import { AppError, bad, forbidden } from "./util/errors.js";

const scrypt = promisify(crypto.scrypt);
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };
const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");
const EMAIL_RE = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]{2,}$/;

export function normalizeEmail(raw) {
  const email = String(raw ?? "").normalize("NFKC").trim().toLowerCase();
  if (email.length > 254 || !EMAIL_RE.test(email)) throw bad("BAD_EMAIL", "Enter a valid email address.");
  return email;
}

function checkPassword(pw) {
  if (typeof pw !== "string" || pw.length < 10) throw bad("WEAK_PASSWORD", "Use at least 10 characters for your password.");
  if (pw.length > 200) throw bad("BAD_PASSWORD", "Passwords can be up to 200 characters.");
}

export async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(pw, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return ["scrypt", SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString("base64url"), key.toString("base64url")].join("$");
}

/* a fixed hash to compare against when there is no account, so both paths cost the same */
const DUMMY = "scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA$" + "A".repeat(86);

export async function verifyPassword(pw, stored) {
  const [alg, N, r, p, saltB64, keyB64] = String(stored || DUMMY).split("$");
  if (alg !== "scrypt") return false;
  const want = Buffer.from(keyB64, "base64url");
  const got = await scrypt(String(pw ?? ""), Buffer.from(saltB64, "base64url"), want.length, { N: Number(N), r: Number(r), p: Number(p) });
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

export class EmailAuth {
  constructor({ db, users, auth, mailer, config, now = () => Date.now(), baseUrl = () => config.mail.publicUrl }) {
    this.db = db;
    this.users = users;
    this.auth = auth;
    this.mailer = mailer;
    this.cfg = config;
    this.now = now;
    this.baseUrl = baseUrl; // where links in emails point (config.mail.publicUrl, or this server's own address in development)
    this.sent = new Map(); // userId → send times in the last hour (in memory: a restart only resets the throttle)
  }

  get enabled() { return this.cfg.mail.enabled; }
  #requireOn() { if (!this.enabled) throw forbidden("EMAIL_AUTH_OFF", "Email sign-in is not available on this server. Connect a wallet instead."); }

  byEmail(email) { return this.db.get("SELECT * FROM users WHERE email = ?", email) || null; }

  /* ------------------------------------------------------------ links and mail */

  #newToken(userId, kind, ttlMs) {
    const token = crypto.randomBytes(32).toString("base64url");
    this.db.tx(() => {
      this.db.run("DELETE FROM email_tokens WHERE user_id = ? AND kind = ?", userId, kind); // only the newest link works
      this.db.run("DELETE FROM email_tokens WHERE expires_at < ?", this.now());
      this.db.run("INSERT INTO email_tokens (token_hash, user_id, kind, created_at, expires_at) VALUES (?, ?, ?, ?, ?)",
        sha256(token), userId, kind, this.now(), this.now() + ttlMs);
    });
    return token;
  }

  #takeToken(token, kind) {
    if (typeof token !== "string" || !/^[A-Za-z0-9_-]{40,60}$/.test(token)) throw bad("BAD_LINK", "That link is not valid. Request a new one.");
    const row = this.db.get("SELECT * FROM email_tokens WHERE token_hash = ? AND kind = ?", sha256(token), kind);
    if (!row) throw new AppError("BAD_LINK", "That link was already used or replaced by a newer one. Request a new one.", 400);
    this.db.run("DELETE FROM email_tokens WHERE token_hash = ?", row.token_hash); // single use
    if (row.expires_at < this.now()) throw new AppError("LINK_EXPIRED", "That link has expired. Request a new one.", 400);
    return this.users.require(row.user_id);
  }

  /* at most cfg.auth.emailsPerHour messages per account; past that the request still answers normally, it just sends nothing */
  #mayMail(userId) {
    const hourAgo = this.now() - 3600000;
    const times = (this.sent.get(userId) || []).filter((t) => t > hourAgo);
    if (times.length >= this.cfg.auth.emailsPerHour) return false;
    times.push(this.now());
    this.sent.set(userId, times);
    return true;
  }

  async #mail(user, subject, lines) {
    if (!this.#mayMail(user.id)) return;
    try { await this.mailer.send({ to: user.email, subject, text: lines.join("\n") }); }
    catch { throw new AppError("MAIL_FAILED", "We could not send the email just now. Try again in a minute.", 503); }
  }

  #link(param, token) { return `${this.baseUrl()}/?${param}=${token}`; }

  async #sendVerify(user) {
    const token = this.#newToken(user.id, "verify", this.cfg.auth.verifyTtlMs);
    await this.#mail(user, "Confirm your email for Duel.gold", [
      "Confirm your email to finish creating your Duel.gold account:", "", this.#link("verify", token), "",
      "The link works once and expires in 24 hours. If you did not sign up, ignore this email: no account is created without it.",
    ]);
  }

  /* ------------------------------------------------------------ flows */

  async signup({ email: rawEmail, password }) {
    this.#requireOn();
    const email = normalizeEmail(rawEmail);
    checkPassword(password);
    const hash = await hashPassword(password);
    const existing = this.byEmail(email);
    if (existing && existing.email_verified_at) {
      // the address already has an account: say nothing here, tell the inbox
      await this.#mail(existing, "Someone tried to sign up with your email", [
        "Someone (maybe you) tried to create a Duel.gold account with this email, but you already have one.", "",
        `Sign in at ${this.baseUrl()}/ or, if you forgot your password, use "Forgot password" there.`, "",
        "If this was not you, nothing has changed and you can ignore this email.",
      ]);
      return { ok: true };
    }
    let user = existing;
    if (user) {
      // an unconfirmed sign-up (maybe by someone else): the newest password wins, the link goes to the real inbox
      this.db.run("UPDATE users SET password_hash = ? WHERE id = ?", hash, user.id);
    } else {
      const name = `Player-${crypto.randomBytes(3).toString("hex")}`;
      const id = this.db.run("INSERT INTO users (address, email, password_hash, display_name, created_at) VALUES (NULL, ?, ?, ?, ?)",
        email, hash, name, this.now()).lastInsertRowid;
      user = this.users.byId(Number(id));
    }
    await this.#sendVerify(this.users.byId(user.id));
    return { ok: true };
  }

  /* the link in the confirmation email: confirms the address and signs in */
  verify({ token, ip = null }) {
    this.#requireOn();
    return this.db.tx(() => {
      const user = this.#takeToken(token, "verify");
      if (!user.email_verified_at) this.db.run("UPDATE users SET email_verified_at = ? WHERE id = ?", this.now(), user.id);
      const fresh = this.users.byId(user.id);
      return { ...this.auth.openSession(fresh, ip), user: fresh, created: true };
    });
  }

  async login({ email: rawEmail, password, ip = null }) {
    this.#requireOn();
    let email;
    try { email = normalizeEmail(rawEmail); } catch { email = null; }
    const user = email ? this.byEmail(email) : null;
    const ok = await verifyPassword(password, user && user.password_hash); // always one hash, account or not
    if (!user || !user.password_hash || !ok) throw new AppError("BAD_CREDENTIALS", "Email or password is incorrect.", 401);
    if (!user.email_verified_at) {
      await this.#sendVerify(user);
      throw new AppError("EMAIL_UNVERIFIED", `Confirm your email first: we sent a new link to ${user.email}.`, 403);
    }
    return { ...this.auth.openSession(user, ip), user, created: false };
  }

  async forgot({ email: rawEmail }) {
    this.#requireOn();
    const email = normalizeEmail(rawEmail);
    const user = this.byEmail(email);
    if (user && user.password_hash) {
      const token = this.#newToken(user.id, "reset", this.cfg.auth.resetTtlMs);
      await this.#mail(user, "Reset your Duel.gold password", [
        "Choose a new password for your Duel.gold account:", "", this.#link("reset", token), "",
        "The link works once and expires in 1 hour. Setting a new password signs you out everywhere else.",
        "If you did not ask for this, ignore this email: your password stays the same.",
      ]);
    }
    return { ok: true }; // same answer either way
  }

  async reset({ token, password, ip = null }) {
    this.#requireOn();
    checkPassword(password);
    const hash = await hashPassword(password);
    return this.db.tx(() => {
      const user = this.#takeToken(token, "reset");
      // the link reached the inbox, so the address is confirmed too
      this.db.run("UPDATE users SET password_hash = ?, email_verified_at = COALESCE(email_verified_at, ?) WHERE id = ?", hash, this.now(), user.id);
      this.auth.endSessions(user.id);
      const fresh = this.users.byId(user.id);
      return { ...this.auth.openSession(fresh, ip), user: fresh, created: false };
    });
  }

  /* An email account proves it owns a wallet by signing a nonce (POST /v1/auth/nonce first). Once linked, the wallet can also
     sign in to this account, and withdrawals go only there. One wallet per account and one account per wallet. */
  async linkWallet(user, { address, nonce, signature }) {
    if (user.address) throw new AppError("WALLET_LINKED", "This account already has a wallet linked.", 409);
    const linked = this.db.tx(() => {
      const signer = this.auth.checkSignature({ address, nonce, signature });
      const other = this.users.byAddress(signer);
      if (other) throw new AppError("WALLET_IN_USE", "That wallet already has its own Duel.gold account. Sign in with the wallet instead.", 409);
      this.db.run("UPDATE users SET address = ? WHERE id = ? AND address IS NULL", signer, user.id);
      return this.users.byId(user.id);
    });
    if (linked.email) {
      await this.#mail(linked, "A wallet was linked to your Duel.gold account", [
        `The wallet ${linked.address} is now linked to your Duel.gold account. Withdrawals can only go to this wallet.`, "",
        "If this was not you, reset your password now and contact support before making any withdrawal.",
      ]).catch(() => {}); // the link stands even if the notice could not be sent
    }
    return linked;
  }
}
