/* Duel.gold SDK — shared by the platform and every game pack.
   Defines window.DG: the game registry, utilities, CSS injection and the match context (ctx).
   Loaded BEFORE any game pack. Do not put platform UI here. */
(function () {
  "use strict";
  const DG = (window.DG = window.DG || {});
  DG.version = "1.0.0";

  DG.CATEGORIES = [
    { id: "strategy", name: "Strategy" },
    { id: "puzzle", name: "Puzzle" },
    { id: "reflex", name: "Reflex" },
    { id: "precision", name: "Precision" },
    { id: "numbers", name: "Numbers" },
    { id: "builder", name: "Builder" },
    { id: "battle", name: "Battle" },
    { id: "cards", name: "Cards" },
    { id: "dice", name: "Dice" },
    { id: "knowledge", name: "Knowledge" },
    { id: "word", name: "Word" },
    { id: "social", name: "Social" },
  ];
  const CAT_IDS = DG.CATEGORIES.map((c) => c.id);
  const FORMATS = ["1v1", "2v2", "ffa", "tournament", "mix"];

  /* ---------------- utilities ---------------- */
  function mulberry32(a) {
    a = a >>> 0;
    return function () {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function hashSeed(x) {
    const s = String(x); let h = 2166136261 >>> 0;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  DG.util = {
    rng: (seed) => mulberry32(hashSeed(seed)),
    hashSeed,
    clamp,
    lerp: (a, b, t) => a + (b - a) * t,
    randInt: (rng, a, b) => a + Math.floor(rng() * (b - a + 1)),
    pick: (rng, arr) => arr[Math.floor(rng() * arr.length)],
    shuffle: (rng, arr) => { const a = arr.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; },
    gauss: (rng) => { let u = 0, v = 0; while (!u) u = rng(); while (!v) v = rng(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); },
    fmt: (n) => Math.round(n).toLocaleString("en-GB"),
    esc: (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])),
    skillFromRating: (r) => clamp((r - 800) / 1400, 0.05, 0.98),
    el(html) { const t = document.createElement("template"); t.innerHTML = String(html).trim(); return t.content.firstElementChild; },
  };

  /* ---------------- CSS injection ---------------- */
  DG.css = function (id, text) {
    if (document.getElementById("css-" + id)) return;
    const s = document.createElement("style");
    s.id = "css-" + id; s.textContent = text;
    document.head.appendChild(s);
  };

  /* ---------------- registry ---------------- */
  DG.games = [];
  DG.loadErrors = DG.loadErrors || [];
  DG.registerGame = function (def) {
    try { return registerGameStrict(def); }
    catch (e) {
      console.error("[DG] game not registered:", e);
      DG.loadErrors.push(String(e && e.message || e));
      return null;
    }
  };
  function registerGameStrict(def) {
    const need = ["id", "name", "category", "kind", "formats", "skill", "luck", "blurb", "rules", "play"];
    for (const k of need) if (def[k] == null) throw new Error("DG.registerGame(" + (def.id || "?") + "): missing '" + k + "'");
    if (!CAT_IDS.includes(def.category)) throw new Error(def.id + ": unknown category " + def.category);
    if (def.kind !== "race" && def.kind !== "versus") throw new Error(def.id + ": kind must be race|versus");
    if (def.kind === "race" && typeof def.bot !== "function") throw new Error(def.id + ": race games need bot()");
    for (const f of def.formats) if (!FORMATS.includes(f)) throw new Error(def.id + ": unknown format " + f);
    if (def.kind === "versus" && def.formats.some((f) => f === "2v2" || f === "ffa" || f === "mix"))
      throw new Error(def.id + ": versus games support only 1v1 and tournament");
    if (DG.games.some((g) => g.id === def.id)) throw new Error("duplicate game id " + def.id);
    const g = Object.assign({ duration: "", cashEligible: false, scoreLabel: "score", formatScore: (n) => DG.util.fmt(n), pack: "" }, def);
    g.cashEligible = !!def.cashEligible && def.luck <= 2;
    DG.games.push(g);
    return g;
  }
  DG.getGame = (id) => DG.games.find((g) => g.id === id);

  /* ---------------- match context ----------------
     o = { root, seed, mode:'full'|'mix', format, me, opponents, teammates, speed, options,
           onStatus(text), onProgress(score), onEnd(result), onError(err) }
     options: the values the player picked in the game's own setup section (def.setup), or {} */
  DG.createContext = function (o) {
    const timers = new Set(), rafs = new Set();
    let keyFns = [], cleanups = [];
    const speed = o.speed || 1;
    const t0 = performance.now();
    const safe = (fn) => function () {
      try { return fn.apply(this, arguments); }
      catch (e) { console.error("[DG game error]", e); if (o.onError) o.onError(e); }
    };
    const ctx = {
      root: o.root,
      seed: o.seed,
      rng: DG.util.rng(o.seed),
      mode: o.mode || "full",
      format: o.format || "1v1",
      me: o.me || { name: "You", rating: 1200 },
      opponents: o.opponents || [],
      teammates: o.teammates || [],
      options: Object.freeze(Object.assign({}, o.options && typeof o.options === "object" ? o.options : {})),
      speed,
      signal: { ended: false },
      reducedMotion: !!(window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches),
      now: () => (performance.now() - t0) * speed,
      timeout(fn, ms) {
        const id = setTimeout(() => { timers.delete(id); if (!ctx.signal.ended) safe(fn)(); }, Math.max(0, ms) / speed);
        timers.add(id); return id;
      },
      clearTimeout(id) { clearTimeout(id); timers.delete(id); },
      interval(fn, ms) {
        const id = setInterval(() => { if (!ctx.signal.ended) safe(fn)(); }, Math.max(4, ms / speed));
        timers.add(id); return id;
      },
      clearInterval(id) { clearInterval(id); timers.delete(id); },
      raf(fn) {
        const id = requestAnimationFrame(() => { rafs.delete(id); if (!ctx.signal.ended) safe(fn)(ctx.now()); });
        rafs.add(id); return id;
      },
      cancelRaf(id) { cancelAnimationFrame(id); rafs.delete(id); },
      /* run fn once when the match ends OR is aborted (disconnect observers, etc.) */
      onCleanup(fn) { if (ctx.signal.ended) { try { fn(); } catch (e) {} } else cleanups.push(fn); },
      onKey(fn) {
        const h = (e) => { if (!ctx.signal.ended) safe(fn)(e); };
        document.addEventListener("keydown", h); keyFns.push(h);
      },
      setStatus(t) { if (o.onStatus) o.onStatus(String(t)); },
      progress(score) { if (o.onProgress) o.onProgress(score); },
      end(result) {
        if (ctx.signal.ended) return;
        ctx.signal.ended = true; cleanup();
        if (o.onEnd) o.onEnd(result || {});
      },
    };
    function cleanup() {
      timers.forEach((id) => { clearTimeout(id); clearInterval(id); }); timers.clear();
      rafs.forEach((id) => cancelAnimationFrame(id)); rafs.clear();
      keyFns.forEach((h) => document.removeEventListener("keydown", h)); keyFns = [];
      const cs = cleanups; cleanups = [];
      cs.forEach((fn) => { try { fn(); } catch (e) { console.error("[DG cleanup]", e); } });
    }
    return {
      ctx,
      abort() { if (!ctx.signal.ended) { ctx.signal.ended = true; cleanup(); } },
    };
  };

  /* Start a game safely. Returns the handle from createContext. */
  DG.start = function (game, o) {
    const h = DG.createContext(o);
    o.root.innerHTML = "";
    try { game.play(h.ctx); }
    catch (e) { console.error("[DG play error]", e); if (o.onError) o.onError(e); }
    return h;
  };
})();
