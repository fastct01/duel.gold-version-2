/* Minimal structured logger. One JSON line per event; never pass secrets in `fields`. */
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

export function createLogger(level = "info", sink = (line) => process.stderr.write(line + "\n")) {
  const min = LEVELS[level] ?? LEVELS.info;
  const emit = (lvl, msg, fields) => {
    if (LEVELS[lvl] < min) return;
    let f = fields instanceof Error ? { err: f2(fields) } : fields || {};
    // an Error nested in the fields would serialise to {}; log its message (URLs redacted) instead
    if (f === fields) f = Object.fromEntries(Object.entries(f).map(([k, v]) => [k, v instanceof Error ? f2(v) : v]));
    sink(JSON.stringify({ t: new Date().toISOString(), level: lvl, msg, ...f }));
  };
  const redact = (t) => (t == null ? t : String(t).replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'`)\]]+/gi, "[url]")); // RPC URLs carry API keys
  const f2 = (e) => ({ message: redact(e.message), code: e.code, stack: redact(e.stack && e.stack.split("\n").slice(0, 4).join(" | ")) });
  return {
    debug: (m, f) => emit("debug", m, f),
    info: (m, f) => emit("info", m, f),
    warn: (m, f) => emit("warn", m, f),
    error: (m, f) => emit("error", m, f),
  };
}
