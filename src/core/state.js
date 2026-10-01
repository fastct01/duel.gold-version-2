/* Duel.gold platform — state, persistence, economy, ratings, simulated world.
   Shared internal namespace: window.DGP (platform only; games never touch it). */
(function () {
  "use strict";
  const DG = window.DG;
  const U = DG.util;
  const P = (window.DGP = window.DGP || {});
  const KEY = "duelgold.v2";

  /* ---------------- clock (offset lets tests jump to "tomorrow") ---------------- */
  P.clock = { offset: 0, now() { return Date.now() + this.offset; } };
  const pad2 = (n) => String(n).padStart(2, "0");
  P.dayKey = function (t) {
    const d = new Date(t == null ? P.clock.now() : t);
    return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate());
  };
  P.weekKey = function () {
    const d = new Date(P.clock.now());
    const back = (d.getDay() + 6) % 7; // Monday = 0
    d.setDate(d.getDate() - back);
    return P.dayKey(d.getTime());
  };
  P.msToMidnight = function () {
    const n = new Date(P.clock.now()), m = new Date(n.getTime());
    m.setHours(24, 0, 0, 0);
    return m - n;
  };
  P.msToWeekEnd = function () {
    const n = new Date(P.clock.now()), m = new Date(n.getTime());
    const toMon = (8 - n.getDay()) % 7 || 7;
    m.setDate(n.getDate() + toMon); m.setHours(0, 0, 0, 0);
    return m - n;
  };
  P.msToHour = function () {
    const n = new Date(P.clock.now()), m = new Date(n.getTime());
    m.setMinutes(60, 0, 0);
    return m - n;
  };
  P.msToSeasonEnd = function () {
    const n = new Date(P.clock.now());
    const q = Math.floor(n.getMonth() / 3);
    const m = new Date(n.getFullYear(), q * 3 + 3, 1);
    return m - n;
  };
  P.countdown = function (ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
    if (d > 0) return d + "d " + pad2(h) + "h " + pad2(m) + "m";
    return pad2(h) + ":" + pad2(m) + ":" + pad2(x);
  };

  /* ---------------- names / simulated people ---------------- */
  P.NAMES = ["Mira", "Kofi", "Anya", "Tomasz", "Leila", "Dev", "Sven", "Yuki", "Ines", "Obi", "Marta", "Rafa", "Chloe",
    "Arjun", "Nadia", "Elio", "Hana", "Viktor", "Sade", "Jonah", "Priya", "Mateo", "Ayla", "Farid", "Greta", "Kenji",
    "Lucia", "Emeka", "Signe", "Tariq", "Noor", "Pavel", "Imani", "Bruno", "Mei", "Oskar", "Zara", "Diego", "Aiko", "Luca"];
  const FRIENDS = [["Mira", 1320], ["Kofi", 1245], ["Anya", 1410], ["Tomasz", 1180], ["Leila", 1290], ["Dev", 1515], ["Yuki", 1360], ["Obi", 1150]];

  /* ---------------- games (live view of the registry, sanitised) ---------------- */
  const FMT_ALL = ["1v1", "2v2", "ffa", "tournament", "mix"];
  const normCache = new WeakMap();
  function norm(g) {
    if (normCache.has(g)) return normCache.get(g);
    const num = (v, d) => { const n = Number(v); return isFinite(n) ? n : d; };
    const n = {
      raw: g,
      id: String(g.id),
      name: String(g.name),
      category: String(g.category),
      kind: g.kind === "versus" ? "versus" : "race",
      formats: Array.isArray(g.formats) ? g.formats.filter((f) => FMT_ALL.includes(f)) : [],
      skill: U.clamp(Math.round(num(g.skill, 0)), 0, 10),
      luck: U.clamp(Math.round(num(g.luck, 0)), 0, 10),
      cashEligible: !!g.cashEligible,
      duration: g.duration ? String(g.duration) : "",
      blurb: String(g.blurb || ""),
      rules: (Array.isArray(g.rules) ? g.rules : [g.rules]).filter((r) => r != null).map(String).slice(0, 12),
      scoreLabel: g.scoreLabel ? String(g.scoreLabel) : "score",
      hasSpectate: typeof g.spectate === "function",
    };
    n.fmtScore = function (v) {
      try { const s = g.formatScore ? g.formatScore(v) : U.fmt(v); return s == null ? String(v) : String(s); }
      catch (e) { return String(v); }
    };
    normCache.set(g, n);
    return n;
  }
  P.games = function () {
    const out = [];
    const seen = new Set();
    for (const g of DG.games || []) {
      try {
        if (!g || typeof g.play !== "function" || seen.has(g.id)) continue;
        seen.add(g.id);
        out.push(norm(g));
      } catch (e) { /* skip unusable entry */ }
    }
    return out;
  };
  P.game = (id) => P.games().find((g) => g.id === id) || null;
  P.catName = (id) => { const c = (DG.CATEGORIES || []).find((c) => c.id === id); return c ? c.name : id; };
  P.FORMATS = [
    { id: "1v1", name: "1v1" }, { id: "2v2", name: "2v2" }, { id: "ffa", name: "FFA" },
    { id: "tournament", name: "Tournament" }, { id: "mix", name: "Duel Mix" }];
  P.fmtName = (id) => (P.FORMATS.find((f) => f.id === id) || { name: id }).name;
  P.supports = (g, f) => f === "mix" ? g.kind === "race" && g.formats.includes("mix") : g.formats.includes(f);
  /* simulated "playing now" count: stable base per game, drifts every 10 s */
  P.playing = function (id) {
    const base = 180 + (U.hashSeed("pop:" + id) % 1400);
    const slot = Math.floor(P.clock.now() / 10000);
    const r = U.rng(id + ":" + slot)();
    return Math.max(12, Math.round(base * (0.9 + r * 0.2)));
  };

  /* ---------------- state ---------------- */
  function defaults() {
    return {
      v: 2,
      name: "You",
      gold: 10000,
      dp: 300,
      cashLocked: 0,
      tp: 0,
      games: {},
      rec: { w: 0, l: 0, d: 0, p: 0 },
      streak: 0, bestStreak: 0, lossRun: 0,
      history: [],
      favs: [],
      friends: FRIENDS.map(([name, rating]) => ({ name, rating, added: false })),
      club: null,
      ach: {},
      cos: { owned: [], frame: "", title: "", color: "" },
      limits: { loss: 0, remind: 0, pending: null },
      bonusDate: "",
      today: { date: "", played: 0, w: 0, l: 0, d: 0, net: 0 },
      week: { key: "", dp: 0 },
      tours: {},
      flags: { challenged: 0, mixWins: 0, tourWins: 0 },
      seq: 0,
      active: null,
    };
  }
  P.defaults = defaults;
  const isObj = (o) => o && typeof o === "object" && !Array.isArray(o);
  /* Every field is checked on its own: a bad value falls back to that field's default. */
  function sanitize(raw) {
    const d = defaults();
    if (!isObj(raw) || raw.v !== 2) return d;
    const int = (v, def) => (Number.isFinite(v) ? Math.max(0, Math.floor(v)) : def);
    const num = (v, def) => (Number.isFinite(v) ? v : def);
    const str = (v, def, max) => (typeof v === "string" ? v.slice(0, max || 200) : def);
    const obj = (v) => (isObj(v) ? v : {});
    const s = d;
    s.name = str(raw.name, d.name, 16).replace(/\s+/g, " ").trim() || "You";
    s.gold = int(raw.gold, 10000); s.dp = int(raw.dp, d.dp); s.tp = int(raw.tp, 0); s.cashLocked = 0;
    s.streak = int(raw.streak, 0); s.bestStreak = Math.max(int(raw.bestStreak, 0), s.streak); s.lossRun = int(raw.lossRun, 0); s.seq = int(raw.seq, 0);
    const rec = obj(raw.rec); s.rec = { w: int(rec.w, 0), l: int(rec.l, 0), d: int(rec.d, 0), p: int(rec.p, 0) };
    const td = obj(raw.today);
    s.today = { date: str(td.date, "", 10), played: int(td.played, 0), w: int(td.w, 0), l: int(td.l, 0), d: int(td.d, 0), net: Number.isFinite(td.net) ? Math.round(td.net) : 0 };
    const wk = obj(raw.week); s.week = { key: str(wk.key, "", 10), dp: int(wk.dp, 0) };
    const L = obj(raw.limits);
    s.limits = { loss: int(L.loss, 0), remind: [0, 15, 30, 60].includes(L.remind) ? L.remind : 0, pending: null };
    if (isObj(L.pending) && Number.isFinite(L.pending.loss) && Number.isFinite(L.pending.at)) s.limits.pending = { loss: int(L.pending.loss, 0), at: int(L.pending.at, 0) };
    const fl = obj(raw.flags); s.flags = { challenged: int(fl.challenged, 0), mixWins: int(fl.mixWins, 0), tourWins: int(fl.tourWins, 0) };
    const cos = obj(raw.cos);
    s.cos = { owned: Array.isArray(cos.owned) ? cos.owned.filter((x) => typeof x === "string") : [], frame: str(cos.frame, ""), title: str(cos.title, ""), color: str(cos.color, "") };
    s.tours = {};
    for (const k in obj(raw.tours)) { const t = raw.tours[k]; if (isObj(t)) s.tours[k] = { entered: typeof t.entered === "string" ? t.entered : undefined, best: Number.isInteger(t.best) && t.best >= 0 && t.best <= 3 ? t.best : null }; }
    s.ach = {};
    for (const k in obj(raw.ach)) if (Number.isFinite(raw.ach[k])) s.ach[k] = raw.ach[k];
    s.games = {};
    for (const id in obj(raw.games)) {
      const g = raw.games[id];
      if (!isObj(g)) continue;
      s.games[id] = { r: Number.isFinite(g.r) ? Math.round(g.r) : 1200, w: int(g.w, 0), l: int(g.l, 0), d: int(g.d, 0), best: Number.isFinite(g.best) ? g.best : null, beat: int(g.beat, 0) };
    }
    s.history = Array.isArray(raw.history) ? raw.history.filter(isObj).slice(0, 50) : [];
    s.favs = Array.isArray(raw.favs) ? raw.favs.filter((x) => typeof x === "string") : [];
    if (Array.isArray(raw.friends)) s.friends = raw.friends.filter((f) => isObj(f) && typeof f.name === "string" && f.name.trim()).map((f) => ({ name: f.name.slice(0, 20), rating: num(f.rating, 1200), added: !!f.added }));
    s.club = typeof raw.club === "string" ? raw.club : null;
    s.bonusDate = str(raw.bonusDate, "", 10);
    /* an unfinished match left behind by a reload/close (settled on boot by match.js) */
    const a = raw.active;
    s.active = isObj(a) && typeof a.game === "string" ? { game: a.game, gn: str(a.gn, a.game, 60), format: str(a.format, "1v1", 12), stake: int(a.stake, 0), escrow: int(a.escrow, 0), phase: str(a.phase, "mm", 12), opp: Number.isFinite(a.opp) ? a.opp : 1200, vs: str(a.vs, "", 80), unrated: a.unrated === true, tour: isObj(a.tour) ? { id: str(a.tour.id, ""), once: str(a.tour.once, "") } : null } : null;
    return s;
  }
  P.storage = { ok: true, error: "" };
  P.load = function () {
    let raw = null;
    try { raw = window.localStorage.getItem(KEY); }
    catch (e) { P.storage.ok = false; P.storage.error = String(e && e.message || e); }
    let parsed = null;
    if (raw) { try { parsed = JSON.parse(raw); } catch (e) { parsed = null; } }
    P.S = sanitize(parsed);
  };
  P.save = function () {
    try { window.localStorage.setItem(KEY, JSON.stringify(P.S)); P.storage.ok = true; }
    catch (e) { P.storage.ok = false; P.storage.error = String(e && e.message || e); }
  };
  const listeners = [];
  P.onChange = (fn) => listeners.push(fn);
  P.commit = function () {
    P.save();
    for (const fn of listeners) { try { fn(); } catch (e) { console.error("[Duel.gold] render error", e); } }
  };
  /* Reset clears progress but keeps the responsible-play limits (loss limit, pending change, reminder). */
  P.reset = function () {
    const keep = { limits: JSON.parse(JSON.stringify(P.S.limits)) };
    P.S = defaults();
    P.S.limits = keep.limits;
    P.commit();
  };
  P.load();

  /* ---------------- per-game records ---------------- */
  P.gs = function (id) {
    const S = P.S;
    if (!S.games[id]) S.games[id] = { r: 1200, w: 0, l: 0, d: 0, best: null, beat: 0 };
    return S.games[id];
  };
  P.rating = (id) => (P.S.games[id] ? P.S.games[id].r : 1200);
  P.overall = function () {
    const ids = Object.keys(P.S.games).filter((id) => { const g = P.S.games[id]; return g.w + g.l + g.d > 0; });
    if (!ids.length) return 1200;
    return Math.round(ids.reduce((a, id) => a + P.S.games[id].r, 0) / ids.length);
  };
  P.division = (r) => (r >= 1700 ? "Master" : r >= 1550 ? "Diamond" : r >= 1400 ? "Gold" : r >= 1250 ? "Silver" : "Bronze");
  P.mastered = (id) => { const g = P.S.games[id]; return !!g && (g.r >= 1400 || g.w >= 5); };
  /* rank against a simulated population of 5,000 players, ratings ~ N(1200, 180) */
  P.POP = 5000;
  P.rank = function (r) {
    const z = (r - 1200) / 180;
    const cdf = 0.5 * (1 + erf(z / Math.SQRT2));
    return Math.max(1, Math.min(P.POP, Math.round(P.POP * (1 - cdf)) + 1));
  };
  function erf(x) {
    const t = 1 / (1 + 0.3275911 * Math.abs(x));
    const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
    return x >= 0 ? y : -y;
  }

  /* ---------------- economy (all integer gold) ----------------
     1v1 / 2v2 / Duel Mix: winner receives floor(2 × stake × 0.9); draw refunds the stake.
     FFA: net pot = floor(4 × stake × 0.9); 1st floor(pot × 70%), 2nd floor(pot × 30%); tied places split (floored).
     Tournament: pool = floor(8 × entry × 0.9) + house-added; champion 60%, runner-up 25%, semi-finalists 7.5% each (floored). */
  const E = (P.econ = {});
  E.FEE_PCT = 10;
  E.winPay = (stake) => Math.floor((2 * stake * (100 - E.FEE_PCT)) / 100);
  E.ffaPot = (stake, n) => Math.floor(((n || 4) * stake * (100 - E.FEE_PCT)) / 100);
  E.ffaPrizes = (stake, n) => { const pot = E.ffaPot(stake, n); return [Math.floor((pot * 70) / 100), Math.floor((pot * 30) / 100)]; };
  /* scores: array (index 0 = you). Returns {places:[place per player 1-based], pay:[gold per player]} */
  E.ffaSplit = function (scores, prizes) {
    const order = scores.map((s, i) => i).sort((a, b) => scores[b] - scores[a]);
    const places = new Array(scores.length), pay = new Array(scores.length).fill(0);
    let pos = 0;
    while (pos < order.length) {
      let end = pos;
      while (end + 1 < order.length && scores[order[end + 1]] === scores[order[pos]]) end++;
      let total = 0;
      for (let k = pos; k <= end; k++) total += prizes[k] || 0;
      const each = Math.floor(total / (end - pos + 1));
      for (let k = pos; k <= end; k++) { places[order[k]] = pos + 1; pay[order[k]] = each; }
      pos = end + 1;
    }
    return { places, pay };
  };
  E.tourPool = (entry, added) => Math.floor((8 * entry * (100 - E.FEE_PCT)) / 100) + (added || 0);
  E.tourPrizes = function (entry, added) {
    const pool = E.tourPool(entry, added);
    return { pool, champion: Math.floor((pool * 60) / 100), runnerUp: Math.floor((pool * 25) / 100), semi: Math.floor((pool * 75) / 1000) };
  };
  /* Elo, K = 24 */
  E.K = 24;
  E.expect = (a, b) => 1 / (1 + Math.pow(10, (b - a) / 400));
  E.elo = (r, opp, s) => Math.round(E.K * (s - E.expect(r, opp)));
  /* FFA pairwise: each pair uses K/(n-1) so a full field moves about as much as one duel */
  E.eloFFA = function (ratings, scores, i) {
    const n = ratings.length; let d = 0;
    for (let j = 0; j < n; j++) {
      if (j === i) continue;
      const s = scores[i] > scores[j] ? 1 : scores[i] < scores[j] ? 0 : 0.5;
      d += (E.K / (n - 1)) * (s - E.expect(ratings[i], ratings[j]));
    }
    return Math.round(d);
  };
  /* duel points earned */
  E.dpFor = function (outcome, stake) {
    return 10 + (outcome === "win" ? 20 + Math.floor(stake / 100) * 5 : outcome === "draw" ? 5 : 0);
  };

  /* ---------------- responsible play ---------------- */
  P.ensureToday = function () {
    const k = P.dayKey();
    if (P.S.today.date !== k) P.S.today = { date: k, played: 0, w: 0, l: 0, d: 0, net: 0 };
    const w = P.weekKey();
    if (P.S.week.key !== w) P.S.week = { key: w, dp: 0 };
  };
  /* A lower limit applies at once; a higher limit (or switching it off) waits 24 h. */
  P.LIMIT_DELAY = 86400000;
  P.applyPending = function () {
    const L = P.S.limits;
    if (L.pending && L.pending.at <= P.clock.now()) { L.loss = L.pending.loss; L.pending = null; return true; }
    return false;
  };
  P.setLossLimit = function (v) {
    const L = P.S.limits;
    const stricter = v > 0 && (L.loss === 0 || v <= L.loss);
    if (stricter) { L.loss = v; L.pending = null; P.commit(); return { now: true }; }
    if (v === L.loss) { L.pending = null; P.commit(); return { now: true }; }
    L.pending = { loss: v, at: P.clock.now() + P.LIMIT_DELAY };
    P.commit();
    return { now: false, at: L.pending.at };
  };
  P.lossToday = () => { P.ensureToday(); return Math.max(0, -P.S.today.net); };
  P.lossRoom = function () {
    P.applyPending();
    const lim = P.S.limits.loss;
    return lim > 0 ? Math.max(0, lim - P.lossToday()) : Infinity;
  };
  /* reason staked play is blocked entirely, or "" */
  P.stakeBlock = function () {
    const S = P.S;
    if (S.limits.loss > 0 && P.lossRoom() <= 0) return "Daily loss limit reached. Free play only until midnight.";
    return "";
  };
  /* reason a specific stake cannot be used, or "" */
  P.stakeError = function (stake) {
    if (stake === 0) return "";
    if (!Number.isInteger(stake)) return "Enter a whole number of gold.";
    if (stake < 10) return "The minimum stake is 10 gold.";
    const b = P.stakeBlock(); if (b) return b;
    if (stake > P.S.gold) return "You have " + U.fmt(P.S.gold) + " gold. Lower the stake or top up.";
    const room = P.lossRoom();
    if (stake > room) return "That is above what is left of your daily loss limit (" + U.fmt(room) + ").";
    return "";
  };

  /* ---------------- achievements ---------------- */
  P.ACH = [
    { id: "first-win", name: "First win", desc: "Win any duel." },
    { id: "hat-trick", name: "Hat-trick", desc: "Win 3 duels in a row." },
    { id: "on-fire", name: "On fire", desc: "Win 5 duels in a row." },
    { id: "mix-master", name: "Mix master", desc: "Win a Duel Mix." },
    { id: "champion", name: "Tournament champion", desc: "Win an 8-player tournament." },
    { id: "polymath", name: "Polymath", desc: "Play 10 different games." },
    { id: "high-roller", name: "High roller", desc: "Win a duel staked at 1,000 or more." },
    { id: "comeback", name: "Comeback", desc: "Win right after losing 3 in a row." },
    { id: "giant-slayer", name: "Giant slayer", desc: "Beat a player rated 1600+." },
    { id: "team-player", name: "Team player", desc: "Win a 2v2." },
    { id: "last-standing", name: "Last one standing", desc: "Finish 1st in an FFA." },
    { id: "rival-call", name: "Called out", desc: "Challenge a friend." },
  ];
  const pendingAch = [];
  P.unlock = function (id) {
    if (P.S.ach[id]) return false;
    P.S.ach[id] = P.clock.now();
    const a = P.ACH.find((x) => x.id === id);
    if (a) {
      /* during a match the result screen lists them inline (P.matchAch); toasts only outside matches */
      if (P.matchAch) { P.matchAch.push(a.name); return true; }
      pendingAch.push(a.name);
      if (pendingAch.length === 1) setTimeout(() => {
        const names = pendingAch.splice(0);
        if (P.toast && names.length) P.toast((names.length > 1 ? "Achievements unlocked · " : "Achievement unlocked · ") + names.join(", "), "gold");
      }, 0);
    }
    return true;
  };

  /* ---------------- DP shop (cosmetic only) ---------------- */
  P.SHOP = [
    { id: "frame-gold", kind: "frame", name: "Gold ring frame", price: 300, val: "gold" },
    { id: "frame-rival", kind: "frame", name: "Coral frame", price: 300, val: "rival" },
    { id: "frame-ally", kind: "frame", name: "Harbour blue frame", price: 300, val: "ally" },
    { id: "title-sharp", kind: "title", name: "Title · Sharpshooter", price: 250, val: "Sharpshooter" },
    { id: "title-closer", kind: "title", name: "Title · The Closer", price: 600, val: "The Closer" },
    { id: "title-gm", kind: "title", name: "Title · Grandmaster", price: 1500, val: "Grandmaster" },
    { id: "color-gold", kind: "color", name: "Gold name", price: 400, val: "var(--gold)" },
    { id: "color-ice", kind: "color", name: "Ice name", price: 400, val: "#9FE3FF" },
    { id: "color-mint", kind: "color", name: "Mint name", price: 400, val: "var(--good)" },
  ];
  P.buy = function (id) {
    const it = P.SHOP.find((x) => x.id === id);
    if (!it) return "Unknown item.";
    if (P.S.cos.owned.includes(id)) return "You already own this.";
    if (P.S.dp < it.price) return "Not enough duel points.";
    P.S.dp -= it.price;
    P.S.cos.owned.push(id);
    P.S.cos[it.kind] = id;
    P.commit();
    return "";
  };
  P.equip = function (id) {
    const it = P.SHOP.find((x) => x.id === id);
    if (!it || !P.S.cos.owned.includes(id)) return;
    P.S.cos[it.kind] = P.S.cos[it.kind] === id ? "" : id;
    P.commit();
  };
  P.cosVal = (kind) => { const it = P.SHOP.find((x) => x.id === P.S.cos[kind]); return it ? it.val : ""; };

  /* ---------------- history + record ---------------- */
  P.addHistory = function (h) {
    P.S.seq = (P.S.seq || 0) + 1;
    h.id = P.S.seq; h.t = P.clock.now();
    P.S.history.unshift(h);
    if (P.S.history.length > 50) P.S.history.length = 50;
  };
  /* record one decided duel for global stats, streaks, today's numbers */
  P.recordDuel = function (outcome, net) {
    const S = P.S; P.ensureToday();
    S.today.played++; S.today.net += net;
    if (outcome === "win") {
      S.rec.w++; S.today.w++;
      if (S.lossRun >= 3) P.unlock("comeback");
      S.streak++; S.lossRun = 0;
      S.bestStreak = Math.max(S.bestStreak, S.streak);
      P.unlock("first-win");
      if (S.streak >= 3) P.unlock("hat-trick");
      if (S.streak >= 5) P.unlock("on-fire");
    } else if (outcome === "loss") {
      S.rec.l++; S.today.l++; S.streak = 0; S.lossRun++;
    } else if (outcome === "place") {
      /* a paid FFA placement (2nd): neither a win nor a loss, streak untouched */
      S.rec.p = (S.rec.p || 0) + 1;
    } else { S.rec.d++; S.today.d++; }
  };
  P.addDp = function (n) { P.ensureToday(); P.S.dp += n; P.S.week.dp += n; };
  P.checkPolymath = function () {
    const n = Object.keys(P.S.games).filter((id) => { const g = P.S.games[id]; return g.w + g.l + g.d > 0; }).length;
    if (n >= 10) P.unlock("polymath");
  };
})();
