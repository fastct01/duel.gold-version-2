/* WebSocket gateway at /v1/ws — real-time transport for queueing and matches.

   Client → server   { "type": "...", "id": <any>, ...fields }        every request may carry an `id`
   Server → client   { "type": "ack", "id", "ok": true, "result" }    reply to a request that had an id
                     { "type": "ack", "id", "ok": false, "error": { "code", "message" } }
                     plus pushed events: hello, auth.ok, sync, queue.joined/left/expired, match.found, match.opponent_ready,
                     match.start, match.opponent_progress, match.opponent_finished, match.result, match.void, wallet.updated

   The first message must be { "type": "auth", "token": "<bearer token from /v1/auth/login>" } within 5 seconds.
   Requests: queue.join {game, stake, code?} · queue.leave · match.ready {matchId} · match.progress {matchId, score}
             match.submit {matchId, score, detail?} · match.forfeit {matchId} · sync · ping                           */
import crypto from "node:crypto";
import { WebSocketServer } from "ws";
import { AppError } from "../util/errors.js";
import { RateLimiter } from "../http/ratelimit.js";

const PROTOCOL = 1;
const AUTH_TIMEOUT_MS = 5000;
const HEARTBEAT_MS = 20000;
const MAX_CONNS_PER_USER = 6;
export const WS_PATH = "/v1/ws";

export class Gateway {
  constructor({ server, cfg, log, auth, hub, matches, meView, now = () => Date.now() }) {
    Object.assign(this, { cfg, log, auth, hub, matches, meView, now });
    this.wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });
    this.byUser = new Map(); // userId -> Set<conn>
    this.conns = new Set();
    this.limiter = new RateLimiter({ perMinute: cfg.rate.wsPerSec * 60, burst: cfg.rate.wsPerSec * 3, now });
    this.upgrades = new RateLimiter({ perMinute: 120, burst: 30, now }); // new connections per IP

    server.on("upgrade", (req, socket, head) => this.#upgrade(req, socket, head));
    hub.setSender((userId, msg, opts) => this.#send(userId, msg, opts));
    hub.setConnectionLister((userId) => [...(this.byUser.get(userId) || [])].filter((c) => c.ws.readyState === 1).map((c) => c.id));
    this.heartbeat = setInterval(() => this.#beat(), HEARTBEAT_MS);
    this.heartbeat.unref?.();
  }

  #upgrade(req, socket, head) {
    const url = new URL(req.url, "http://x");
    if (url.pathname !== WS_PATH) { socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n"); return socket.destroy(); }
    // Browsers always send Origin; when an allow-list is configured it must match. Non-browser clients send none.
    const allowed = this.cfg.allowedOrigins;
    const origin = req.headers.origin;
    if (origin && !allowed.includes("*") && !allowed.includes(origin)) {
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      return socket.destroy();
    }
    const ip = this.cfg.trustProxy ? String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket.remoteAddress : req.socket.remoteAddress;
    if (!this.upgrades.take(ip || "unknown")) { socket.write("HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n"); return socket.destroy(); }
    this.wss.handleUpgrade(req, socket, head, (ws) => this.#accept(ws, ip));
  }

  #accept(ws, ip) {
    const conn = { id: crypto.randomBytes(6).toString("hex"), ws, ip, userId: null, token: null, alive: true };
    this.conns.add(conn);
    ws.on("pong", () => { conn.alive = true; });
    ws.on("message", (data, isBinary) => this.#onMessage(conn, data, isBinary));
    ws.on("close", () => this.#onClose(conn));
    ws.on("error", (e) => this.log.debug("ws error", { conn: conn.id, error: String(e.message || e) }));
    conn.authTimer = setTimeout(() => { if (!conn.userId) ws.close(4001, "auth timeout"); }, AUTH_TIMEOUT_MS);
    conn.authTimer.unref?.();
    this.#raw(conn, { type: "hello", protocol: PROTOCOL, serverTime: this.now() });
  }

  #raw(conn, msg) {
    if (conn.ws.readyState === 1) conn.ws.send(JSON.stringify(msg));
  }

  /* Hub sender: deliver to a player's sockets. Returns how many received it. */
  #send(userId, msg, opts = {}) {
    let n = 0;
    for (const c of this.byUser.get(userId) || []) {
      if (c.ws.readyState !== 1) continue;
      if (opts.conn && c.id !== opts.conn) continue;
      if (opts.except && c.id === opts.except) continue;
      c.ws.send(JSON.stringify(msg));
      n++;
    }
    return n;
  }

  #onClose(conn) {
    clearTimeout(conn.authTimer);
    this.conns.delete(conn);
    if (conn.userId == null) return;
    const set = this.byUser.get(conn.userId);
    if (set) {
      set.delete(conn);
      if (!set.size) {
        this.byUser.delete(conn.userId);
        this.matches.userDisconnected(conn.userId);
      }
    }
  }

  #beat() {
    for (const c of this.conns) {
      if (!c.alive) { c.ws.terminate(); continue; }
      c.alive = false;
      try { c.ws.ping(); } catch { /* closing */ }
    }
  }

  #onMessage(conn, data, isBinary) {
    if (isBinary) return conn.ws.close(1003, "text only");
    if (!this.limiter.take(conn.id)) return conn.ws.close(4008, "rate limit");
    let msg;
    try { msg = JSON.parse(data.toString("utf8")); } catch { return this.#raw(conn, { type: "ack", ok: false, error: { code: "BAD_JSON", message: "Messages must be JSON." } }); }
    if (!msg || typeof msg !== "object" || typeof msg.type !== "string") {
      return this.#raw(conn, { type: "ack", ok: false, error: { code: "BAD_MESSAGE", message: "Every message needs a string `type`." } });
    }
    const reply = (ok, payload) => {
      if (msg.id === undefined) { if (!ok) this.#raw(conn, { type: "error", error: payload }); return; }
      this.#raw(conn, ok ? { type: "ack", id: msg.id, ok: true, result: payload ?? {} } : { type: "ack", id: msg.id, ok: false, error: payload });
    };
    try {
      if (msg.type === "auth") return this.#auth(conn, msg, reply);
      if (!conn.userId) throw new AppError("UNAUTHORIZED", "Send an auth message first.", 401);
      // re-check on every message: logging out, expiry and bans must end live sockets too, not only future REST calls
      const live = this.auth.authenticate(conn.token);
      if (!live || live.id !== conn.userId) { reply(false, { code: "SESSION_EXPIRED", message: "Your session ended. Sign in again." }); return conn.ws.close(4003, "session ended"); }
      reply(true, this.#dispatch(conn, msg));
    } catch (e) {
      if (e instanceof AppError) reply(false, { code: e.code, message: e.message, ...(e.extra || {}) });
      else { this.log.error("ws handler failed", { type: msg.type, error: e }); reply(false, { code: "INTERNAL", message: "Something went wrong on our side." }); }
    }
  }

  #auth(conn, msg, reply) {
    if (conn.userId) throw new AppError("ALREADY_AUTHENTICATED", "Already signed in on this connection.", 400);
    const token = typeof msg.token === "string" ? msg.token : "";
    const user = this.auth.authenticate(token);
    if (!user) { reply(false, { code: "UNAUTHORIZED", message: "Invalid or expired token." }); return conn.ws.close(4001, "unauthorized"); }
    const set = this.byUser.get(user.id) || new Set();
    if (set.size >= MAX_CONNS_PER_USER) { reply(false, { code: "TOO_MANY_CONNECTIONS", message: "Too many open connections for this account." }); return conn.ws.close(4009, "too many connections"); }
    clearTimeout(conn.authTimer);
    conn.userId = user.id;
    conn.token = token;
    set.add(conn);
    this.byUser.set(user.id, set);
    this.matches.userConnected(user.id);
    reply(true, { userId: user.id, connectionId: conn.id });
    this.#raw(conn, { type: "sync", me: this.meView(user) });
  }

  #dispatch(conn, msg) {
    const m = this.matches;
    const uid = conn.userId;
    switch (msg.type) {
      case "ping": return { t: msg.t ?? null, serverTime: this.now() };
      case "sync": return { me: this.meView(this.auth.users.require(uid)) };
      case "queue.join": return m.join(uid, { game: msg.game, stake: msg.stake, code: msg.code });
      case "queue.leave": return m.leave(uid);
      case "match.ready": return m.ready(uid, msg.matchId, conn.id);
      case "match.progress": m.progress(uid, msg.matchId, msg.score); return {};
      case "match.submit": return m.submit(uid, msg.matchId, { score: msg.score, detail: msg.detail });
      case "match.forfeit": return m.forfeit(uid, msg.matchId);
      default: throw new AppError("UNKNOWN_TYPE", `Unknown message type "${msg.type}".`, 400);
    }
  }

  close() {
    clearInterval(this.heartbeat);
    for (const c of this.conns) c.ws.close(1001, "server shutting down");
    this.wss.close();
  }
}
