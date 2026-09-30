/* Game catalog, built from the same game packs the browser loads (src/core/sdk.js + src/games/*.js).

   The packs are first-party browser code. They are run once at startup inside a `vm` context with a do-nothing DOM
   stub — enough for them to call DG.registerGame(). Nothing here renders a game; the server only needs each game's
   metadata, its nominal length (to set submission deadlines) and its deterministic bot (to sanity-check scores).

   Player-vs-player play currently supports `race` games: both players get the same seed, each plays it on their own
   device and reports a score. `versus` games embed an AI opponent in the client, so a human-vs-human version needs a
   server-side rules referee per game — not built yet (listed as `pvp: false`).                                    */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const noop = () => {};
const domStub = () => new Proxy(function () {}, {
  get: (_t, k) => (k === "style" ? {} : k === "classList" ? { add: noop, remove: noop, toggle: noop } : k === "children" ? [] : noop),
  set: () => true,
  apply: () => domStub(),
});

function sandbox() {
  const document = {
    getElementById: () => null, createElement: domStub, head: { appendChild: noop }, body: { appendChild: noop },
    addEventListener: noop, removeEventListener: noop, querySelector: () => null, querySelectorAll: () => [],
  };
  const win = {
    document, performance, console: { log: noop, warn: noop, error: noop, info: noop, debug: noop },
    matchMedia: () => ({ matches: false }), requestAnimationFrame: noop, cancelAnimationFrame: noop,
    addEventListener: noop, removeEventListener: noop, Chess: class {},
  };
  win.window = win;
  return vm.createContext(win);
}

/* "3 min (mix 45 s)" → 180, "up to 6 min" → 360, "1–4 min" → 240, "30 s" → 30. Falls back to 5 minutes. */
export function parseDurationSeconds(text) {
  const full = String(text || "").replace(/\([^)]*\)/g, "");
  let best = 0;
  for (const m of full.matchAll(/(\d+(?:\.\d+)?)\s*(min|m|sec|s)\b/gi)) {
    const v = Number(m[1]) * (/^m/i.test(m[2]) ? 60 : 1);
    if (v > best) best = v;
  }
  return best || 300;
}

export class Catalog {
  constructor(games, DG) {
    this.DG = DG;
    this.byId = new Map(games.map((g) => [g.id, g]));
    this.botCache = new Map();
  }

  get(id) { return this.byId.get(id) || null; }
  list() { return [...this.byId.values()].map((g) => this.publicView(g)); }

  publicView(g) {
    return {
      id: g.id, name: g.name, category: g.category, kind: g.kind, pack: g.pack, blurb: g.blurb,
      skill: g.skill, luck: g.luck, cashEligible: g.cashEligible, duration: g.duration, scoreLabel: g.scoreLabel,
      pvp: g.pvp, maxSeconds: Math.round(g.maxMs / 1000), rules: g.rules,
    };
  }

  /* Top-skill bot score for this seed, or null if unavailable. Used only to flag implausible results for review. */
  botCeiling(game, seed) {
    const key = `${game.id}:${seed}`;
    if (this.botCache.has(key)) return this.botCache.get(key);
    let score = null;
    try {
      const r = game.raw.bot(seed, 0.98, this.DG.util.rng(`${seed}:audit`), "full");
      if (r && Number.isFinite(Number(r.score))) score = Number(r.score);
    } catch { /* a broken bot must never block a payout */ }
    this.botCache.set(key, score);
    if (this.botCache.size > 500) this.botCache.delete(this.botCache.keys().next().value);
    return score;
  }

  /* null if the score is believable, otherwise a short reason. Advisory only: it never changes who wins. */
  plausibility(game, seed, score) {
    const ceiling = this.botCeiling(game, seed);
    if (ceiling == null || ceiling <= 0) return null;
    const limit = Math.max(ceiling * 3, ceiling + 200);
    return score > limit ? `score ${score} is more than 3× the strongest bot (${Math.round(ceiling)})` : null;
  }
}

export function loadCatalog({ gamesDir, log }) {
  const ctx = sandbox();
  const files = ["core/sdk.js"];
  const gameDir = path.join(gamesDir, "games");
  if (fs.existsSync(gameDir)) {
    for (const f of fs.readdirSync(gameDir).sort()) if (f.endsWith(".js") && !f.startsWith("_")) files.push(`games/${f}`);
  }
  for (const rel of files) {
    const file = path.join(gamesDir, rel);
    if (!fs.existsSync(file)) { log.warn("game file missing", { file }); continue; }
    try { vm.runInContext(fs.readFileSync(file, "utf8"), ctx, { filename: rel, timeout: 5000 }); }
    catch (e) { log.warn("game pack failed to load", { file: rel, error: String(e.message || e) }); }
  }
  const DG = ctx.window.DG;
  if (!DG || !Array.isArray(DG.games)) throw new Error(`no games found under ${gamesDir} (expected core/sdk.js and games/*.js)`);
  const games = DG.games.map((def) => ({
    id: String(def.id), name: String(def.name), category: String(def.category), kind: def.kind === "versus" ? "versus" : "race",
    pack: String(def.pack || ""), blurb: String(def.blurb || ""), skill: Number(def.skill) || 0, luck: Number(def.luck) || 0,
    cashEligible: !!def.cashEligible, duration: String(def.duration || ""), scoreLabel: String(def.scoreLabel || "score"),
    rules: Array.isArray(def.rules) ? def.rules.map(String) : [],
    pvp: def.kind !== "versus" && typeof def.bot === "function",
    maxMs: Math.round(parseDurationSeconds(def.duration) * 1000),
    raw: def,
  }));
  for (const e of DG.loadErrors || []) log.warn("game did not register", { error: e });
  log.info("game catalog loaded", { games: games.length, pvp: games.filter((g) => g.pvp).length });
  return new Catalog(games, DG);
}
