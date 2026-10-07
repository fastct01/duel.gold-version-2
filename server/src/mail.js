/* Outgoing email: account verification, password resets and security notices.

   With RESEND_API_KEY set, mail goes through Resend's HTTP API (https://resend.com/docs/api-reference/emails/send-email) from
   MAIL_FROM, which must be an address on a domain verified in Resend. Without a key there is no delivery: in development every
   message is written to the log (so the link can be opened by hand) and kept in `outbox` for the tests; in production email
   accounts are switched off (config.mail.enabled is false), so nothing tries to send. */
export class Mailer {
  constructor({ cfg, log, fetchImpl = globalThis.fetch }) {
    this.cfg = cfg.mail;
    this.log = log;
    this.fetch = fetchImpl;
    this.outbox = []; // development / tests only: the last messages, newest last
  }

  get delivers() { return !!this.cfg.resendApiKey; }

  /* { to, subject, text } → resolves when the provider accepted it. Plain text only: no tracking pixels, no remote images. */
  async send({ to, subject, text }) {
    if (!this.delivers) {
      this.outbox.push({ to, subject, text, at: Date.now() });
      if (this.outbox.length > 50) this.outbox.shift();
      this.log.info("email (not sent: no RESEND_API_KEY)", { to, subject, text });
      return { id: null, logged: true };
    }
    const res = await this.fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${this.cfg.resendApiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ from: this.cfg.from, to: [to], subject, text }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      this.log.error("email send failed", { to, subject, status: res.status, detail: detail.slice(0, 300) });
      throw new Error(`email provider answered ${res.status}`);
    }
    const out = await res.json().catch(() => ({}));
    return { id: out.id || null };
  }
}
