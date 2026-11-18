/* Email accounts through Supabase Auth (https://supabase.com/docs/reference/api/auth). On when SUPABASE_URL and
   SUPABASE_SECRET_KEY are set; it then takes the place of the built-in email accounts (emailAuth.js) behind the same
   /v1/auth/email/* endpoints, so the page talks only to this server and the secret key never leaves it.

   - Sign-up creates the Supabase user already confirmed (admin API), so no confirmation email is sent and the player is
     signed in at once. The address is not proven: withdrawals still go only to a wallet linked by signature.
   - Sign-in checks the password with Supabase (password grant). Supabase's own tokens are dropped: PlayVault keeps its
     own sessions (auth.js), exactly as for a wallet sign-in.
   - "Forgot password" asks Supabase to email a recovery link (Supabase's mailer, or the SMTP set in its dashboard). The link
     comes back to PUBLIC_URL/#access_token=…&type=recovery; the page posts that token with the new password to /reset.
   - users.auth_id holds the Supabase user id. A PlayVault user with the same email and no auth_id yet (an older,
     unconfirmed built-in sign-up) is taken over on first use instead of failing on the unique email. */
import crypto from "node:crypto";
import { AppError, bad } from "./util/errors.js";
import { EmailAuth, normalizeEmail } from "./emailAuth.js";

function checkPassword(pw) {
  if (typeof pw !== "string" || pw.length < 10) throw bad("WEAK_PASSWORD", "Use at least 10 characters for your password.");
  if (pw.length > 72) throw bad("BAD_PASSWORD", "Passwords can be up to 72 characters."); // Supabase hashes with bcrypt
}

const unavailable = () => new AppError("AUTH_UNAVAILABLE", "Sign-in is not available just now. Try again in a minute.", 503);

export class SupabaseAuth extends EmailAuth {
  constructor({ supabase, fetchImpl = globalThis.fetch, log = null, ...rest }) {
    super(rest);
    this.url = String(supabase.url).replace(/\/+$/, "");
    this.key = supabase.secretKey;
    this.fetch = fetchImpl;
    this.log = log;
  }

  get enabled() { return true; }

  /* one call to Supabase Auth → { status, body }; network trouble and 5xx become AUTH_UNAVAILABLE */
  async #call(method, path, { body, bearer } = {}) {
    let res;
    try {
      res = await this.fetch(`${this.url}/auth/v1${path}`, {
        method,
        headers: { apikey: this.key, authorization: `Bearer ${bearer || this.key}`, "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(10000),
      });
    } catch (e) {
      this.log?.error("supabase auth unreachable", { path, error: e.message });
      throw unavailable();
    }
    const text = await res.text().catch(() => "");
    let out = {};
    try { out = text ? JSON.parse(text) : {}; } catch { /* not JSON */ }
    if (res.status >= 500 || res.status === 401 && !bearer) {
      // 401 with our own key means the key is wrong: an operator problem, never the player's
      this.log?.error("supabase auth error", { path, status: res.status, detail: text.slice(0, 300) });
      throw unavailable();
    }
    return { status: res.status, body: out };
  }

  static #code(body) { return String(body.error_code || body.code || body.error || ""); }

  /* the PlayVault user for a Supabase user: by auth_id, else take over an unlinked row with the same email, else create one */
  async #userFor(authUser) {
    const authId = String(authUser.id || "");
    if (!authId) throw unavailable();
    const email = normalizeEmail(authUser.email);
    return this.db.tx(async () => {
      const linked = await this.db.get("SELECT * FROM users WHERE auth_id = ?", authId);
      if (linked) return linked;
      const same = await this.byEmail(email);
      if (same) {
        if (same.auth_id) throw new AppError("EMAIL_TAKEN", "An account with this email already exists. Sign in instead.", 409);
        await this.db.run("UPDATE users SET auth_id = ?, password_hash = NULL WHERE id = ?", authId, same.id);
        return this.users.byId(same.id);
      }
      const name = `Player-${crypto.randomBytes(3).toString("hex")}`;
      const id = (await this.db.run("INSERT INTO users (address, email, auth_id, display_name, created_at) VALUES (NULL, ?, ?, ?, ?) RETURNING id",
        email, authId, name, this.now())).lastInsertRowid;
      return this.users.byId(Number(id));
    });
  }

  async #session(user, ip, created) {
    return { ...(await this.auth.openSession(user, ip)), user, created };
  }

  async signup({ email: rawEmail, password, ip = null }) {
    const email = normalizeEmail(rawEmail);
    checkPassword(password);
    const r = await this.#call("POST", "/admin/users", { body: { email, password, email_confirm: true } });
    if (r.status === 422 && /exists|registered/i.test(SupabaseAuth.#code(r.body) + " " + (r.body.msg || r.body.message || ""))) {
      throw new AppError("EMAIL_TAKEN", "An account with this email already exists. Sign in instead.", 409);
    }
    if (r.status === 422 && /weak_password/.test(SupabaseAuth.#code(r.body))) {
      throw bad("WEAK_PASSWORD", "Choose a stronger password: that one is too easy to guess.");
    }
    if (r.status !== 200 && r.status !== 201) {
      this.log?.error("supabase sign-up refused", { status: r.status, code: SupabaseAuth.#code(r.body) });
      throw unavailable();
    }
    return this.#session(await this.#userFor(r.body), ip, true);
  }

  async verify() {
    throw new AppError("BAD_LINK", "That link is not valid. Sign in with your email and password.", 400);
  }

  async login({ email: rawEmail, password, ip = null }) {
    let email;
    try { email = normalizeEmail(rawEmail); } catch { throw new AppError("BAD_CREDENTIALS", "Email or password is incorrect.", 401); }
    if (typeof password !== "string" || !password) throw new AppError("BAD_CREDENTIALS", "Email or password is incorrect.", 401);
    const r = await this.#call("POST", "/token?grant_type=password", { body: { email, password } });
    if (r.status === 429) throw new AppError("RATE_LIMITED", "Too many sign-in attempts. Wait a few minutes and try again.", 429);
    if (r.status !== 200 || !r.body.user) throw new AppError("BAD_CREDENTIALS", "Email or password is incorrect.", 401);
    return this.#session(await this.#userFor(r.body.user), ip, false);
  }

  async forgot({ email: rawEmail }) {
    const email = normalizeEmail(rawEmail);
    const r = await this.#call("POST", `/recover?redirect_to=${encodeURIComponent(this.baseUrl() + "/")}`, { body: { email } });
    if (r.status === 429) throw new AppError("RATE_LIMITED", "Too many reset emails were sent just now. Try again later.", 429);
    if (r.status >= 400) this.log?.warn("supabase recover refused", { status: r.status, code: SupabaseAuth.#code(r.body) });
    return { ok: true }; // same answer whether or not the email has an account
  }

  /* token = the access token from the recovery link; it proves the link reached the inbox */
  async reset({ token, password, ip = null }) {
    checkPassword(password);
    if (typeof token !== "string" || token.length < 20 || token.length > 4096) throw bad("BAD_LINK", "That link is not valid. Request a new one.");
    const me = await this.#call("GET", "/user", { bearer: token });
    if (me.status !== 200 || !me.body.id) throw new AppError("LINK_EXPIRED", "That link has expired or was already used. Request a new one.", 400);
    const r = await this.#call("PUT", `/admin/users/${encodeURIComponent(me.body.id)}`, { body: { password } });
    if (r.status === 422 && /weak_password/.test(SupabaseAuth.#code(r.body))) {
      throw bad("WEAK_PASSWORD", "Choose a stronger password: that one is too easy to guess.");
    }
    if (r.status !== 200) { this.log?.error("supabase password update refused", { status: r.status, code: SupabaseAuth.#code(r.body) }); throw unavailable(); }
    // Supabase ends every session of the user when an admin sets the password, the link's own included: it works once
    const user = await this.#userFor(me.body);
    await this.db.run("UPDATE users SET email_verified_at = COALESCE(email_verified_at, ?) WHERE id = ?", this.now(), user.id);
    await this.auth.endSessions(user.id);
    return this.#session(await this.users.byId(user.id), ip, false);
  }
}
