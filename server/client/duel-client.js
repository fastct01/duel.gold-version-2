/* Duel.gold client SDK — works in Node 22+ and in browsers (uses only fetch and WebSocket).

     const c = new DuelClient({ baseUrl: "http://localhost:8787", address, sign: (msg) => wallet.signMessage(msg) });
     await c.login();          // wallet signature → session token
     await c.connect();        // WebSocket, authenticated
     await c.joinQueue({ game: "reaction", stake: "1000000000000000" });
     const found = await c.waitFor("match.found");
     await c.ready(found.match.id);
     const start = await c.waitFor("match.start");   // { seed, startAt, submitDeadline }
     ...play the game locally with start.seed...
     await c.submit(found.match.id, score);
     const result = await c.waitFor("match.result");

   Pushed events are buffered until you ask for them, so waitFor() never misses one that arrived early.        */

export class DuelError extends Error {
  constructor(code, message, status, extra) {
    super(message);
    this.name = "DuelError";
    this.code = code;
    this.status = status;
    this.extra = extra;
  }
}

export class DuelClient {
  constructor({ baseUrl, address, sign, WebSocketImpl = globalThis.WebSocket, fetchImpl = globalThis.fetch.bind(globalThis), bufferEvents = true }) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.address = address;
    this.sign = sign;
    this.WS = WebSocketImpl;
    this.fetch = fetchImpl;
    this.token = null;
    this.me = null;
    this.ws = null;
    this.connectionId = null;
    this.clockOffset = 0; // serverTime − localTime, from the hello message
    this.buffer = [];
    this.waiters = [];
    this.pending = new Map();
    this.nextId = 1;
    this.listeners = new Map();
    this.bufferEvents = bufferEvents; // false: pushed events go only to on() listeners and waitFor() waiters (no backlog)
    this.closed = false;
  }

  /* ------------------------------------------------------------ REST */

  async api(method, path, body, headers = {}) {
    const res = await this.fetch(this.baseUrl + path, {
      method,
      headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(this.token ? { authorization: `Bearer ${this.token}` } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    let data = null;
    try { data = await res.json(); } catch { /* empty body */ }
    if (!res.ok) {
      const e = data && data.error ? data.error : { code: "HTTP_" + res.status, message: res.statusText };
      const { code, message, ...extra } = e;
      throw new DuelError(code, message, res.status, extra);
    }
    return data;
  }

  /* nonce → wallet signature → session token */
  async login() {
    const { nonce, message } = await this.api("POST", "/v1/auth/nonce", { address: this.address });
    const signature = await this.sign(message);
    const out = await this.api("POST", "/v1/auth/login", { address: this.address, nonce, signature });
    this.token = out.token;
    this.me = out.me;
    return out;
  }

  /* ------------------------------------------------------------ WebSocket */

  serverNow() { return Date.now() + this.clockOffset; }

  /* open the socket and authenticate; resolves with the ack of the auth message */
  async connect() {
    if (!this.token) throw new Error("login() first");
    const url = this.baseUrl.replace(/^http/, "ws") + "/v1/ws";
    const ws = new this.WS(url);
    this.ws = ws;
    this.closed = false;
    await new Promise((resolve, reject) => {
      ws.addEventListener("open", resolve, { once: true });
      ws.addEventListener("error", () => reject(new Error("WebSocket connection failed")), { once: true });
    });
    ws.addEventListener("message", (ev) => this.#onMessage(ev.data));
    ws.addEventListener("close", (ev) => {
      this.closed = true;
      for (const [, p] of this.pending) p.reject(new DuelError("CONNECTION_CLOSED", `connection closed (${ev.code})`, 0));
      this.pending.clear();
      this.#emit("close", { code: ev.code, reason: ev.reason });
    });
    const res = await this.request("auth", { token: this.token });
    this.connectionId = res.connectionId;
    return res;
  }

  #onMessage(raw) {
    let msg;
    try { msg = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw)); } catch { return; }
    if (msg.type === "hello") this.clockOffset = msg.serverTime - Date.now();
    if (msg.type === "ack") {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.ok) p.resolve(msg.result);
      else { const { code, message, ...extra } = msg.error; p.reject(new DuelError(code, message, 0, extra)); }
      return;
    }
    this.#emit(msg.type, msg);
    const i = this.waiters.findIndex((w) => w.type === msg.type && (!w.pred || w.pred(msg)));
    if (i >= 0) { const [w] = this.waiters.splice(i, 1); clearTimeout(w.timer); w.resolve(msg); }
    else if (this.bufferEvents) this.buffer.push(msg);
  }

  /* send a request and resolve with its ack result (rejects with DuelError on failure) */
  request(type, fields = {}) {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== 1) return reject(new DuelError("NOT_CONNECTED", "WebSocket is not open", 0));
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ type, id, ...fields }));
    });
  }
  /* fire and forget (no ack) */
  send(type, fields = {}) { if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify({ type, ...fields })); }

  /* Next pushed event of `type` (optionally matching pred). Events that arrived earlier are returned first. */
  waitFor(type, pred, timeoutMs = 10000) {
    const i = this.buffer.findIndex((m) => m.type === type && (!pred || pred(m)));
    if (i >= 0) return Promise.resolve(this.buffer.splice(i, 1)[0]);
    return new Promise((resolve, reject) => {
      const w = { type, pred, resolve };
      w.timer = setTimeout(() => {
        this.waiters.splice(this.waiters.indexOf(w), 1);
        reject(new Error(`timed out waiting for "${type}" (buffered: ${this.buffer.map((m) => m.type).join(", ") || "none"})`));
      }, timeoutMs);
      this.waiters.push(w);
    });
  }
  /* events already received and not yet consumed */
  peek(type) { return this.buffer.filter((m) => !type || m.type === type); }
  clearBuffer() { this.buffer.length = 0; }

  on(type, fn) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type).add(fn); return () => this.listeners.get(type).delete(fn); }
  #emit(type, msg) { for (const fn of this.listeners.get(type) || []) { try { fn(msg); } catch { /* listener bugs must not break the socket */ } } }

  /* ------------------------------------------------------------ game helpers */

  joinQueue({ game, stake = "0", code } = {}) { return this.request("queue.join", { game, stake, code }); }
  leaveQueue() { return this.request("queue.leave"); }
  ready(matchId) { return this.request("match.ready", { matchId }); }
  progress(matchId, score) { this.send("match.progress", { matchId, score }); }
  submit(matchId, score, detail) { return this.request("match.submit", { matchId, score, detail }); }
  forfeit(matchId) { return this.request("match.forfeit", { matchId }); }
  sync() { return this.request("sync"); }

  close() {
    this.closed = true;
    for (const w of this.waiters) clearTimeout(w.timer);
    this.waiters.length = 0;
    if (this.ws) this.ws.close(1000, "client closing");
  }
}
