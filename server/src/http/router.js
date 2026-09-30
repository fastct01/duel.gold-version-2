/* A deliberately small HTTP layer on node:http: routing, JSON bodies with a size limit, CORS, security headers,
   rate limiting and uniform error bodies { "error": { "code", "message", ... } }. */
import crypto from "node:crypto";
import { AppError } from "../util/errors.js";
import { RateLimiter } from "./ratelimit.js";

const MAX_BODY = 32 * 1024;

export class Router {
  constructor({ cfg, log, auth, now = () => Date.now() }) {
    Object.assign(this, { cfg, log, auth });
    this.routes = [];
    this.authLimiter = new RateLimiter({ perMinute: cfg.rate.authPerMin, burst: cfg.rate.authPerMin, now });
    this.apiLimiter = new RateLimiter({ perMinute: cfg.rate.apiPerMin, burst: cfg.rate.apiPerMin, now });
    this.fallback = null; // (req, res, url) => boolean — static files etc.
  }

  /* opts: { auth: true | 'admin', limit: 'auth' } */
  add(method, pattern, opts, handler) {
    const keys = [];
    const re = new RegExp("^" + pattern.replace(/:([A-Za-z]+)/g, (_m, k) => (keys.push(k), "([^/]+)")) + "/?$");
    this.routes.push({ method, re, keys, opts: opts || {}, handler });
  }
  get(p, o, h) { this.add("GET", p, o, h); }
  post(p, o, h) { this.add("POST", p, o, h); }
  put(p, o, h) { this.add("PUT", p, o, h); }
  patch(p, o, h) { this.add("PATCH", p, o, h); }
  delete(p, o, h) { this.add("DELETE", p, o, h); }

  clientIp(req) {
    if (this.cfg.trustProxy) {
      const xff = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
      if (xff) return xff;
    }
    return req.socket.remoteAddress || "unknown";
  }

  #cors(req, res) {
    const origin = req.headers.origin;
    const allowed = this.cfg.allowedOrigins;
    if (allowed.includes("*")) res.setHeader("access-control-allow-origin", "*");
    else if (origin && allowed.includes(origin)) { res.setHeader("access-control-allow-origin", origin); res.setHeader("vary", "Origin"); }
    res.setHeader("access-control-allow-headers", "authorization, content-type, idempotency-key");
    res.setHeader("access-control-allow-methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
    res.setHeader("access-control-max-age", "600");
  }

  async #readJson(req) {
    if (req.method === "GET" || req.method === "DELETE" || req.method === "OPTIONS") return {};
    const declared = Number(req.headers["content-length"] || 0);
    if (declared > MAX_BODY) throw new AppError("BODY_TOO_LARGE", "Request body is too large.", 413);
    const chunks = [];
    let size = 0;
    for await (const c of req) {
      size += c.length;
      if (size > MAX_BODY) throw new AppError("BODY_TOO_LARGE", "Request body is too large.", 413);
      chunks.push(c);
    }
    if (!size) return {};
    if (!/^application\/json\b/i.test(req.headers["content-type"] || "")) throw new AppError("BAD_CONTENT_TYPE", "Send JSON with Content-Type: application/json.", 415);
    try {
      const v = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (v === null || typeof v !== "object" || Array.isArray(v)) throw new Error("not an object");
      return v;
    } catch { throw new AppError("BAD_JSON", "Request body must be a JSON object.", 400); }
  }

  #send(res, status, body, extraHeaders) {
    const data = JSON.stringify(body);
    res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(data), ...extraHeaders });
    res.end(data);
  }

  #adminOk(req) {
    const token = this.cfg.adminToken;
    if (!token) return null; // admin API disabled
    const given = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    const a = crypto.createHash("sha256").update(given).digest(), b = crypto.createHash("sha256").update(token).digest();
    return crypto.timingSafeEqual(a, b);
  }

  handler() {
    return async (req, res) => {
      const requestId = crypto.randomBytes(6).toString("hex");
      res.setHeader("x-request-id", requestId);
      res.setHeader("x-content-type-options", "nosniff");
      res.setHeader("referrer-policy", "no-referrer");
      res.setHeader("cache-control", "no-store");
      this.#cors(req, res);
      const started = Date.now();
      let status = 500;
      try {
        if (req.method === "OPTIONS") { status = 204; res.writeHead(204); return res.end(); }
        const url = new URL(req.url, "http://x");
        const route = this.#match(req.method, url.pathname);
        if (!route) {
          if (this.fallback && this.fallback(req, res, url)) { status = res.statusCode; return; }
          status = 404;
          return this.#send(res, 404, { error: { code: "NOT_FOUND", message: "No such endpoint." } });
        }
        const ip = this.clientIp(req);
        const { opts } = route.route;
        if (opts.limit === "auth" && !this.authLimiter.take(ip)) {
          throw new AppError("RATE_LIMITED", "Too many attempts. Slow down.", 429, { retryAfter: this.authLimiter.retryAfter(ip) });
        }
        let user = null;
        if (opts.auth === "admin") {
          const ok = this.#adminOk(req);
          if (ok === null) throw new AppError("NOT_FOUND", "No such endpoint.", 404);
          if (!ok) throw new AppError("UNAUTHORIZED", "Admin token required.", 401);
        } else {
          const token = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
          if (token) user = this.auth.authenticate(token);
          if (opts.auth && !user) throw new AppError("UNAUTHORIZED", "Sign in first.", 401);
        }
        const limitKey = user ? `u:${user.id}` : `ip:${ip}`;
        if (!this.apiLimiter.take(limitKey)) throw new AppError("RATE_LIMITED", "Too many requests. Slow down.", 429, { retryAfter: this.apiLimiter.retryAfter(limitKey) });

        const body = await this.#readJson(req);
        const ctx = { req, url, params: route.params, query: Object.fromEntries(url.searchParams), body, user, ip, token: String(req.headers.authorization || "").replace(/^Bearer\s+/i, "") };
        const out = await route.route.handler(ctx);
        status = out && out.status ? out.status : 200;
        this.#send(res, status, out && out.status ? out.body : out ?? {});
      } catch (e) {
        if (e instanceof AppError) {
          status = e.status;
          const headers = e.code === "RATE_LIMITED" && e.extra ? { "retry-after": String(e.extra.retryAfter) } : undefined;
          this.#send(res, e.status, { error: { code: e.code, message: e.message, ...(e.extra || {}) } }, headers);
        } else {
          this.log.error("unhandled request error", { requestId, method: req.method, path: req.url, error: e });
          status = 500;
          if (!res.headersSent) this.#send(res, 500, { error: { code: "INTERNAL", message: "Something went wrong on our side.", requestId } });
        }
      } finally {
        this.log.debug("request", { requestId, method: req.method, path: req.url, status, ms: Date.now() - started });
      }
    };
  }

  #match(method, pathname) {
    for (const r of this.routes) {
      if (r.method !== method) continue;
      const m = r.re.exec(pathname);
      if (!m) continue;
      try { return { route: r, params: Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])])) }; }
      catch { return null; } // malformed %-escape: treat as no such endpoint
    }
    return null;
  }
}
