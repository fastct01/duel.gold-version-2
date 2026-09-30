/* Static files: the reference browser client (server/public) at /play, its SDK and ethers under /play/sdk and /play/vendor,
   and the game packs it runs (repo src/core + src/games) at /game/. Read-only, no directory listing, no path escapes. */
import fs from "node:fs";
import path from "node:path";

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon" };

export function attachStatic(router, cfg) {
  /* most specific prefix first; `allow` restricts which files under `dir` can be reached */
  const roots = [
    { prefix: "/play/sdk", dir: cfg.clientDir, allow: /^duel-client\.js$/ },
    { prefix: "/play/vendor", dir: cfg.vendorDir, allow: /^ethers\.umd\.min\.js$/ },
    { prefix: "/play", dir: cfg.publicDir },
    { prefix: "/game", dir: cfg.gamesDir, allow: /^(core|games)\// }, // the game packs and base.css, nothing else under src/
  ];
  router.fallback = (req, res, url) => {
    if (req.method !== "GET" && req.method !== "HEAD") return false;
    for (const { prefix, dir, allow } of roots) {
      if (url.pathname !== prefix && !url.pathname.startsWith(prefix + "/")) continue;
      let rel = decodeSafe(url.pathname.slice(prefix.length)) ?? "";
      if (rel === "" || rel.endsWith("/")) rel += "index.html";
      rel = rel.replace(/^\/+/, "");
      const base = path.resolve(dir);
      const file = path.resolve(base, rel);
      if (!file.startsWith(base + path.sep)) return false; // path traversal
      if (allow && !allow.test(rel)) return false;
      let stat;
      try { stat = fs.statSync(file); } catch { return false; }
      if (!stat.isFile()) return false;
      res.writeHead(200, {
        "content-type": TYPES[path.extname(file)] || "application/octet-stream",
        "content-length": stat.size,
        "cache-control": "no-cache",
        "content-security-policy": "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; connect-src 'self' ws: wss:; img-src 'self' data:",
        "x-frame-options": "DENY",
      });
      if (req.method === "HEAD") res.end(); else fs.createReadStream(file).pipe(res);
      return true;
    }
    return false;
  };
}

function decodeSafe(s) {
  try { const d = decodeURIComponent(s); return d.includes("\0") ? null : d; } catch { return null; }
}
