/* Duel.gold — Pack D: BUILDER & BATTLE
   Games: base (Base Duel), city (City Duel), restaurant (Restaurant Duel). All kind 'race'.
   Each game has a pure, DOM-free engine ("lab") shared by play() and bot(); the lab is also exposed on the
   game definition as `_lab` for automated balance tests. */
(function () {
  "use strict";
  const U = DG.util;
  const clamp = U.clamp;
  const FORMATS = ["1v1", "2v2", "ffa", "tournament", "mix"];

  /* ------------------------------------------------------------------ shared helpers */
  function mmss(ms) {
    const s = Math.max(0, Math.ceil(ms / 1000));
    return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
  }
  function money(n) {
    const v = Math.round(n);
    return (v < 0 ? "−$" : "$") + Math.abs(v).toLocaleString("en-GB");
  }
  /* A canvas that fills its container width, keeps an aspect ratio and handles devicePixelRatio. */
  function makeCanvas(ctx, host, aspect, draw, maxH) {
    const cv = document.createElement("canvas");
    cv.style.display = "block";
    cv.style.margin = "0 auto";
    cv.style.touchAction = "none";
    host.appendChild(cv);
    const g = cv.getContext("2d");
    const st = { cv, g, w: 0, h: 0, dpr: 1 };
    function fit() {
      let w = Math.max(200, Math.min(860, host.clientWidth || 320));
      const mh = maxH ? maxH() : 1e9;
      if (w / aspect > mh) w = Math.max(200, Math.floor(mh * aspect));
      const h = Math.round(w / aspect);
      cv.style.width = w + "px";
      const dpr = Math.min(3, window.devicePixelRatio || 1);
      if (w === st.w && h === st.h && dpr === st.dpr) return;
      st.w = w; st.h = h; st.dpr = dpr;
      cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
      cv.style.height = h + "px";
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      if (!ctx.signal.ended && st.ready) draw();
    }
    fit();
    st.ready = true;
    let ro = null;
    if (window.ResizeObserver) {
      ro = new ResizeObserver(() => { if (ctx.signal.ended) { ro.disconnect(); return; } fit(); });
      ro.observe(host);
    }
    const onWin = () => { if (!ctx.signal.ended) fit(); };
    window.addEventListener("resize", onWin);
    st.fit = fit;
    st.stop = () => { if (ro) ro.disconnect(); ro = null; window.removeEventListener("resize", onWin); };
    if (ctx.onCleanup) ctx.onCleanup(st.stop); else onEndWatch(ctx, st.stop);
    return st;
  }
  /* Watches ctx.signal.ended so observers/listeners die with the match even on abort. */
  function onEndWatch(ctx, fn) {
    const tick = () => { if (ctx.signal.ended) { fn(); return; } setTimeout(tick, 500); };
    setTimeout(tick, 500);
  }

  /* ====================================================================================
     BASE DUEL — engine
     ==================================================================================== */
  const BW = 12, BH = 9;
  const DT = 0.05; // fixed sim step (s)
  const TOWERS = {
    wall:   { name: "Wall",   short: "Wall",   cost: 10, hp: 120, block: true,  desc: "Blocks the path. Zombies walk around it; Brutes smash it." },
    arrow:  { name: "Arrow tower", short: "Arrow", cost: 50, hp: 60, block: true, range: 2.6, dmg: 5, cd: 0.5, desc: "Fast single-target shots (5 dmg). Weak against armoured Brutes. Range 2.6." },
    cannon: { name: "Cannon", short: "Cannon", cost: 90, hp: 80, block: true, range: 2.3, dmg: 22, cd: 1.8, splash: 0.9, desc: "Slow heavy shells (22 dmg) that splash a whole group. Range 2.3." },
    frost:  { name: "Frost tower", short: "Frost", cost: 60, hp: 50, block: true, range: 2.0, dps: 4, slow: 0.45, desc: "Slows every zombie in range to under half speed and chills them. Range 2." },
    spike:  { name: "Spike trap", short: "Spikes", cost: 30, hp: 0, block: false, dps: 12, desc: "Built on the path. Hurts zombies walking over it (12 dmg/s); great under Frost." },
    mine:   { name: "Gold mine", short: "Mine", cost: 60, hp: 40, block: true, income: 1, desc: "Earns 1 gold per second while waves run. Pays off after about 3 waves." },
  };
  const TOWER_ORDER = ["wall", "arrow", "cannon", "frost", "spike", "mine"];
  const ENEMIES = {
    walker:  { name: "Walker",  hp: 30,  spd: 1.3,  dmg: 5,  bounty: 4,  r: 0.22, armor: 1 },
    runner:  { name: "Runner",  hp: 14,  spd: 2.4,  dmg: 3,  bounty: 3,  r: 0.17 },
    brute:   { name: "Brute",   hp: 110, spd: 0.75, dmg: 15, bounty: 12, r: 0.3, wallDps: 30, armor: 4 },
    spitter: { name: "Spitter", hp: 40,  spd: 1.0,  dmg: 6,  bounty: 8,  r: 0.22, range: 2.4, dps: 8 },
  };
  const ENEMY_ORDER = ["walker", "runner", "brute", "spitter"];
  const BASE_HP = 100;

  function baseConfig(mode) {
    return mode === "mix"
      ? { waves: 3, buildMs: 20000, gold: 260, bombs: 2, windowMs: 2000, scale: 3.2, accelMs: 4500, capS: 36, diffs: [2, 3.5, 5] }
      : { waves: 8, buildMs: 60000, gold: 300, bombs: 3, windowMs: 5000, scale: 2, accelMs: 10000, capS: 90, diffs: [1, 2, 3, 4, 5, 6, 7, 8] };
  }
  /* Playback: sim seconds shown per real ms. Presentation only — the sim itself is tick-based. After accelMs of a
     wave, playback runs 3x faster so long waves never drag (keeps mix under 45 s). */
  function baseSimAt(cfg, realMs) {
    const a = cfg.accelMs;
    return (realMs <= a ? realMs * cfg.scale : a * cfg.scale + (realMs - a) * cfg.scale * 3) / 1000;
  }
  function baseRealFor(cfg, simS) {
    const a = cfg.accelMs, simA = a * cfg.scale / 1000;
    return simS <= simA ? simS * 1000 / cfg.scale : a + (simS - simA) * 1000 / (cfg.scale * 3);
  }

  function baseMap(seed, mode) {
    const rng = U.rng("base-map:" + seed);
    for (let attempt = 0; attempt < 50; attempt++) {
      const grid = new Array(BW * BH).fill(0); // 0 free, 1 rock
      const base = { x: BW - 2, y: U.randInt(rng, 2, BH - 3) };
      const nSpawn = rng() < 0.5 ? 2 : 3;
      const spawns = [];
      const cands = [];
      for (let y = 0; y < BH; y++) cands.push({ x: 0, y });
      for (let x = 1; x <= 4; x++) { cands.push({ x, y: 0 }); cands.push({ x, y: BH - 1 }); }
      const sh = U.shuffle(rng, cands);
      for (const c of sh) {
        if (spawns.length >= nSpawn) break;
        if (spawns.every((s) => Math.abs(s.x - c.x) + Math.abs(s.y - c.y) >= 4)) spawns.push(c);
      }
      const nRock = U.randInt(rng, 7, 11);
      let tries = 0;
      while (tries++ < 200 && grid.reduce((a, b) => a + b, 0) < nRock) {
        const x = U.randInt(rng, 1, BW - 1), y = U.randInt(rng, 0, BH - 1);
        if (Math.abs(x - base.x) + Math.abs(y - base.y) <= 1) continue;
        if (spawns.some((s) => Math.abs(s.x - x) + Math.abs(s.y - y) <= 1)) continue;
        grid[y * BW + x] = 1;
      }
      const map = { seed, grid, base, spawns };
      const f = bfsField(map, (i) => grid[i] === 1);
      if (spawns.every((s) => f[s.y * BW + s.x] < 1e9)) {
        // every free tile must be reachable (no sealed pockets)
        let ok = true;
        for (let i = 0; i < BW * BH; i++) if (!grid[i] && f[i] >= 1e9) { grid[i] = 1; }
        if (ok) return map;
      }
    }
    throw new Error("base map generation failed");
  }

  function bfsField(map, blocked) {
    const N = BW * BH, f = new Float64Array(N).fill(1e9);
    const b = map.base.y * BW + map.base.x;
    f[b] = 0;
    const q = new Int16Array(N);
    let tail = 0; q[tail++] = b;
    const visit = (j, v) => { if (f[j] < 1e9 || blocked(j)) return; f[j] = v; q[tail++] = j; };
    for (let h = 0; h < tail; h++) {
      const i = q[h], x = i % BW, y = (i / BW) | 0, v = f[i] + 1;
      if (x < BW - 1) visit(i + 1, v);
      if (x > 0) visit(i - 1, v);
      if (y < BH - 1) visit(i + BW, v);
      if (y > 0) visit(i - BW, v);
    }
    return f;
  }
  /* Dijkstra for Brutes: walls are passable at extra cost (they smash through). */
  function bruteField(map, structs) {
    const N = BW * BH, f = new Float64Array(N).fill(1e9), done = new Uint8Array(N);
    const b = map.base.y * BW + map.base.x;
    f[b] = 0;
    const relax = (i, j) => {
      if (done[j] || map.grid[j]) return;
      const s = structs[j];
      let c = 1;
      if (s) { if (s.type === "wall") c = 1 + s.hp / ENEMIES.brute.wallDps * ENEMIES.brute.spd; else if (TOWERS[s.type].block) return; }
      if (f[i] + c < f[j]) f[j] = f[i] + c;
    };
    for (;;) {
      let i = -1, best = 1e9;
      for (let k = 0; k < N; k++) if (!done[k] && f[k] < best) { best = f[k]; i = k; }
      if (i < 0) break;
      done[i] = 1;
      const x = i % BW, y = (i / BW) | 0;
      if (x < BW - 1) relax(i, i + 1);
      if (x > 0) relax(i, i - 1);
      if (y < BH - 1) relax(i, i + BW);
      if (y > 0) relax(i, i - BW);
    }
    return f;
  }

  function baseWaves(seed, mode) {
    const cfg = baseConfig(mode);
    const rng = U.rng("base-waves:" + seed + ":" + mode);
    const map = baseMap(seed, mode);
    const waves = [];
    cfg.diffs.forEach((d, wi) => {
      const pts = 8 + d * 4.2;
      const pool = ["walker", "walker", "runner"];
      if (d >= 2) pool.push("runner");
      if (d >= 3) pool.push("brute");
      if (d >= 4) pool.push("spitter", "walker");
      if (d >= 6) pool.push("brute", "spitter");
      const cost = { walker: 1, runner: 0.7, brute: 4, spitter: 2 };
      const list = [];
      let left = pts;
      if (d >= 3) { list.push("brute"); left -= cost.brute; }
      if (d >= 4) { list.push("spitter"); left -= cost.spitter; }
      let guard = 0;
      while (left > 0.6 && guard++ < 100) {
        const t = U.pick(rng, pool);
        if (cost[t] > left + 0.5) continue;
        list.push(t); left -= cost[t];
      }
      const order = U.shuffle(rng, list);
      const hpMul = 1 + 0.08 * (d - 1);
      const gap = mode === "mix" ? 0.4 : 0.65;
      let t = 0;
      const spawns = order.map((type) => {
        const e = { t: Math.round(t / DT), type, spawn: Math.floor(rng() * map.spawns.length), hpMul };
        t += gap * (0.6 + rng() * 0.8) * (type === "brute" ? 1.6 : 1);
        return e;
      });
      waves.push({ d, spawns, counts: ENEMY_ORDER.map((k) => [k, list.filter((x) => x === k).length]).filter((c) => c[1]) });
    });
    return { map, waves, cfg };
  }

  /* The simulation. Owns structures, enemies, gold, base HP. Deterministic given the same calls at the same ticks. */
  function BaseSim(seed, mode) {
    const W = baseWaves(seed, mode);
    const S = {
      seed, mode, map: W.map, waves: W.waves, cfg: W.cfg,
      structs: new Array(BW * BH).fill(null),
      enemies: [], fx: [], gold: W.cfg.gold, kills: 0, baseHp: BASE_HP,
      bombs: W.cfg.bombs, bombCd: 0, wave: 0, survived: 0, inWave: false, tick: 0, waveTick: 0,
      over: false, dead: false, spent: 0, nextId: 1, mineAcc: 0, leaks: 0,
      field: null,
      // presentation only: never read by the rules. stats = damage/kills per source; events = queue for the renderer
      stats: { dmg: {}, kills: {} }, events: [],
      dt: DT, tickScale: 1, // bots may use a coarser step: setStep(0.1)
    };
    S.setStep = function (dt) { S.dt = dt; S.tickScale = dt / DT; };
    const idx = (x, y) => y * BW + x;
    const isBlockedFor = (structs) => (i) => S.map.grid[i] === 1 || (structs[i] && TOWERS[structs[i].type].block);
    function refreshFields() {
      S.list = S.structs.filter(Boolean);
      S.field = bfsField(S.map, isBlockedFor(S.structs));
      S._bf = null;
    }
    Object.defineProperty(S, "bfield", { get() { if (!S._bf) S._bf = S.list.some((q) => q.type === "wall") ? bruteField(S.map, S.structs) : S.field; return S._bf; } });
    refreshFields();

    S.canPlace = function (type, x, y) {
      if (x < 0 || y < 0 || x >= BW || y >= BH) return "Off the map";
      const i = idx(x, y);
      if (S.map.grid[i]) return "Rock";
      if (S.structs[i]) return "Occupied";
      if (x === S.map.base.x && y === S.map.base.y) return "That is your base";
      if (S.map.spawns.some((s) => s.x === x && s.y === y)) return "Spawn point";
      if (TOWERS[type].cost > S.gold) return "Not enough gold";
      if (S.inWave) return "Wait for the wave to end";
      if (type === "spike" && !S.onPath(i)) return "Spikes go on a zombie path";
      if (TOWERS[type].block) {
        const tmp = S.structs.slice(); tmp[i] = { type };
        const f = bfsField(S.map, isBlockedFor(tmp));
        if (!S.map.spawns.every((s) => f[idx(s.x, s.y)] < 1e9)) return "Zombies need a path";
      }
      return "";
    };
    S.place = function (type, x, y) {
      const why = S.canPlace(type, x, y);
      if (why) return why;
      const T = TOWERS[type];
      S.structs[idx(x, y)] = { id: S.nextId++, type, x, y, hp: T.hp, maxHp: T.hp, cd: 0, paid: T.cost, flash: 0 };
      S.gold -= T.cost; S.spent += T.cost;
      refreshFields();
      if (S.onAct) S.onAct("place", [type, x, y]);
      return "";
    };
    S.sell = function (x, y) {
      const i = idx(x, y), s = S.structs[i];
      if (!s) return "Nothing to sell";
      if (S.wave > 0 || S.inWave) return "You can only sell during the build phase";
      S.structs[i] = null; S.gold += s.paid; S.spent -= s.paid;
      refreshFields();
      if (S.onAct) S.onAct("sell", [x, y]);
      return "";
    };
    S.repairCost = (s) => (s && s.hp > 0 && s.maxHp > 0 && s.hp < s.maxHp ? Math.max(1, Math.ceil((1 - s.hp / s.maxHp) * TOWERS[s.type].cost * 0.6)) : 0);
    S.repair = function (x, y) {
      const s = S.structs[idx(x, y)];
      if (!s) return "Tap a damaged structure";
      const c = S.repairCost(s);
      if (!c) return "Not damaged";
      if (c > S.gold) return "Repair costs " + c + " gold";
      S.gold -= c; s.hp = s.maxHp; s.flash = 0.4;
      if (S.onAct) S.onAct("repair", [x, y]);
      return "";
    };
    S.bombRadius = 1.25;
    const BOMB_SRC = { type: "bomb" };
    S.bombDamage = () => 35 + 5 * (S.waves[Math.min(S.wave, S.waves.length - 1)] || { d: 1 }).d;
    S.bomb = function (x, y) {
      if (!S.inWave) return "Firebombs work during waves";
      if (S.bombs <= 0) return "No firebombs left";
      if (S.bombCd > 0) return "Firebomb cooling down";
      S.bombs--; S.bombCd = 5;
      const dmg = S.bombDamage();
      for (const e of S.enemies) if (Math.hypot(e.x - x, e.y - y) <= S.bombRadius + ENEMIES[e.type].r) hurt(e, dmg, true, BOMB_SRC);
      S.fx.push({ k: "bomb", x, y, t: 0.6, r: S.bombRadius });
      if (!S.headless) S.events.push({ k: "bomb", x, y, r: S.bombRadius });
      if (S.onAct) S.onAct("bomb", [x, y]);
      return "";
    };
    S.startWave = function () {
      if (S.inWave || S.over) return false;
      S.inWave = true; S.waveTick = 0; S.spawnIdx = 0;
      return true;
    };
    function hurt(e, d, hit, src) {
      if (e.hp <= 0) return;
      if (hit) d = Math.max(1, d - (ENEMIES[e.type].armor || 0)); // armour blunts single hits (arrows, shells, bombs)
      const k = src && src.type, st = S.stats;
      if (k) { const dealt = Math.min(d, e.hp); st.dmg[k] = (st.dmg[k] || 0) + dealt; src.dmg = (src.dmg || 0) + dealt; }
      e.hp -= d;
      if (e.hp <= 0) {
        S.kills++; S.gold += ENEMIES[e.type].bounty;
        if (k) { st.kills[k] = (st.kills[k] || 0) + 1; src.kills = (src.kills || 0) + 1; }
        if (!S.headless) S.events.push({ k: "die", id: e.id, type: e.type, x: e.x, y: e.y, v: ENEMIES[e.type].bounty });
      }
    }
    function destroy(s) {
      S.structs[idx(s.x, s.y)] = null;
      if (!S.headless) { S.fx.push({ k: "boom", x: s.x + 0.5, y: s.y + 0.5, t: 0.4 }); S.events.push({ k: "destroy", type: s.type, x: s.x + 0.5, y: s.y + 0.5 }); }
      refreshFields();
    }
    function progressOf(e) { return (e.type === "brute" ? S.bfield : S.field)[e.ti] || 0; }
    function nextTile(e) {
      const f = e.type === "brute" ? S.bfield : S.field;
      const i = e.ti, x = i % BW, y = (i / BW) | 0;
      let best = -1, bv = f[i];
      if (x < BW - 1 && f[i + 1] < bv) { bv = f[i + 1]; best = i + 1; }
      if (y < BH - 1 && f[i + BW] < bv) { bv = f[i + BW]; best = i + BW; }
      if (x > 0 && f[i - 1] < bv) { bv = f[i - 1]; best = i - 1; }
      if (y > 0 && f[i - BW] < bv) { bv = f[i - BW]; best = i - BW; }
      return best;
    }
    const d2 = (ax, ay, bx, by) => (ax - bx) * (ax - bx) + (ay - by) * (ay - by);
    S.step = function () {
      const DT = S.dt;
      if (S.over) return;
      S.tick++;
      if (!S.headless) {
        for (const f of S.fx) f.t -= DT;
        if (S.fx.length) S.fx = S.fx.filter((f) => f.t > 0);
        for (const s of S.list) if (s.flash > 0) s.flash -= DT;
      }
      if (!S.inWave) return;
      const wv = S.waves[S.wave];
      if (S.bombCd > 0) S.bombCd = Math.max(0, S.bombCd - DT);
      // spawns
      while (S.spawnIdx < wv.spawns.length && wv.spawns[S.spawnIdx].t <= S.waveTick * S.tickScale + 1e-9) {
        const sp = wv.spawns[S.spawnIdx++], E = ENEMIES[sp.type], p = S.map.spawns[sp.spawn];
        const hp = Math.round(E.hp * sp.hpMul);
        S.enemies.push({ id: S.nextId++, type: sp.type, x: p.x + 0.5, y: p.y + 0.5, ti: idx(p.x, p.y), to: -1, hp, maxHp: hp, slow: 1, busy: 0 });
      }
      S.waveTick++;
      // mines
      for (const s of S.list) if (s.type === "mine" && s.hp > 0) S.mineAcc += TOWERS.mine.income * DT;
      if (S.mineAcc >= 1) { const g = Math.floor(S.mineAcc); S.gold += g; S.mineAcc -= g; }
      // frost aura + spikes
      for (const e of S.enemies) e.slow = 1;
      for (const s of S.list) {
        if (s.type === "frost") {
          const cx = s.x + 0.5, cy = s.y + 0.5, R2 = TOWERS.frost.range * TOWERS.frost.range;
          for (const e of S.enemies) if (e.hp > 0 && d2(e.x, e.y, cx, cy) <= R2) { e.slow = TOWERS.frost.slow; hurt(e, TOWERS.frost.dps * DT, false, s); }
        } else if (s.type === "spike") {
          for (const e of S.enemies) if (e.hp > 0 && Math.floor(e.x) === s.x && Math.floor(e.y) === s.y) hurt(e, TOWERS.spike.dps * DT, false, s);
        }
      }
      // towers fire
      for (const s of S.list) {
        if (s.hp <= 0 || (s.type !== "arrow" && s.type !== "cannon")) continue;
        if (s.cd > 0) s.cd -= DT;
        if (s.cd > 1e-9) continue;
        const T = TOWERS[s.type], cx = s.x + 0.5, cy = s.y + 0.5, R2 = T.range * T.range;
        let tgt = null, tp = 1e9;
        for (const e of S.enemies) {
          if (e.hp <= 0 || d2(e.x, e.y, cx, cy) > R2) continue;
          const p = progressOf(e);
          if (p < tp || (p === tp && e.id < tgt.id)) { tp = p; tgt = e; }
        }
        if (!tgt) continue;
        s.cd += T.cd;
        if (!S.headless) { s.aim = Math.atan2(tgt.y - cy, tgt.x - cx); s.shot = S.tick; }
        if (s.type === "arrow") { hurt(tgt, T.dmg, true, s); if (!S.headless) S.fx.push({ k: "shot", x: cx, y: cy, x2: tgt.x, y2: tgt.y, t: 0.12 }); }
        else {
          const tx0 = tgt.x, ty0 = tgt.y, SP2 = T.splash * T.splash;
          for (const e of S.enemies) if (e.hp > 0 && d2(e.x, e.y, tx0, ty0) <= SP2) hurt(e, T.dmg, true, s);
          if (!S.headless) { S.fx.push({ k: "splash", x: tgt.x, y: tgt.y, t: 0.3, r: T.splash, x0: cx, y0: cy }); S.events.push({ k: "blast", x: tx0, y: ty0, r: T.splash }); }
        }
      }
      // enemies act
      for (const e of S.enemies) {
        if (e.hp <= 0) continue;
        const E = ENEMIES[e.type];
        if (e.type === "spitter") {
          let tgt = null, td = 1e9;
          for (const s of S.list) {
            if (s.hp <= 0 || s.type === "wall" || s.type === "spike") continue;
            const d = d2(s.x + 0.5, s.y + 0.5, e.x, e.y);
            if (d <= E.range * E.range && (d < td || (d === td && s.id < tgt.id))) { td = d; tgt = s; }
          }
          if (tgt) {
            tgt.hp -= E.dps * DT; tgt.flash = 0.1;
            if (!S.headless && S.tick % 8 === 0) S.fx.push({ k: "spit", x: e.x, y: e.y, x2: tgt.x + 0.5, y2: tgt.y + 0.5, t: 0.2 });
            if (tgt.hp <= 0) destroy(tgt);
            continue;
          }
        }
        if (e.to < 0) {
          if (e.ti === idx(S.map.base.x, S.map.base.y)) {
            S.baseHp -= E.dmg; e.hp = 0; e.leaked = true; S.leaks++;
            if (!S.headless) { S.fx.push({ k: "hit", x: S.map.base.x + 0.5, y: S.map.base.y + 0.5, t: 0.35 }); S.events.push({ k: "leak", type: e.type, v: E.dmg }); }
            continue;
          }
          const n = nextTile(e);
          if (n < 0) continue;
          const s = S.structs[n];
          if (s && TOWERS[s.type].block) {
            if (e.type === "brute" && s.type === "wall") {
              s.hp -= E.wallDps * DT; s.flash = 0.1;
              if (s.hp <= 0) destroy(s);
            }
            continue;
          }
          e.to = n;
        }
        const tx = (e.to % BW) + 0.5, ty = ((e.to / BW) | 0) + 0.5;
        const sp = E.spd * e.slow * DT;
        const dx = tx - e.x, dy = ty - e.y, d = Math.hypot(dx, dy);
        if (d <= sp) { e.x = tx; e.y = ty; e.ti = e.to; e.to = -1; }
        else { e.x += (dx / d) * sp; e.y += (dy / d) * sp; }
      }
      let dead = 0;
      for (const e of S.enemies) if (e.hp <= 0) dead++;
      if (dead) S.enemies = S.enemies.filter((e) => e.hp > 0);
      if (S.baseHp <= 0) {
        S.baseHp = 0; S.inWave = false; S.over = true; S.dead = true;
        return;
      }
      const capTicks = Math.round(S.cfg.capS / DT);
      if (S.over) return;
      if (S.spawnIdx >= wv.spawns.length && (S.enemies.length === 0 || S.waveTick > capTicks)) {
        for (const e of S.enemies) { S.baseHp -= ENEMIES[e.type].dmg; S.leaks++; if (!S.headless) S.events.push({ k: "leak", type: e.type, v: ENEMIES[e.type].dmg }); }
        S.enemies = [];
        S.inWave = false;
        if (S.baseHp <= 0) { S.baseHp = 0; S.over = true; S.dead = true; return; }
        S.survived++; S.wave++;
        if (S.wave >= S.waves.length) S.over = true;
      }
    };
    S.score = function () {
      return 1000 * S.survived + Math.max(0, Math.round(S.baseHp)) * 5 + 10 * S.kills + Math.floor(S.gold / 10);
    };
    S.path = function (sp) {
      const out = [];
      let i = idx(sp.x, sp.y), guard = 0;
      out.push(i);
      while (S.field[i] > 0 && guard++ < 200) {
        const x = i % BW, y = (i / BW) | 0;
        let best = -1, bv = S.field[i];
        for (const j of [x < BW - 1 ? i + 1 : -1, y < BH - 1 ? i + BW : -1, x > 0 ? i - 1 : -1, y > 0 ? i - BW : -1])
          if (j >= 0 && S.field[j] < bv) { bv = S.field[j]; best = j; }
        if (best < 0) break;
        i = best; out.push(i);
      }
      return out;
    };
    S.onPath = function (i) {
      if (!S._pathSet || S._pathFor !== S.field) {
        S._pathSet = new Set(); S._pathFor = S.field;
        for (const sp of S.map.spawns) for (const k of S.path(sp)) S._pathSet.add(k);
      }
      return S._pathSet.has(i);
    };
    /* Paths the zombies would take if `type` were built at (x,y) — used for the placement preview. */
    S.previewPaths = function (type, x, y) {
      const saved = S.field, i = idx(x, y);
      if (type && TOWERS[type].block && !S.structs[i] && !S.map.grid[i]) {
        const tmp = S.structs.slice(); tmp[i] = { type };
        S.field = bfsField(S.map, isBlockedFor(tmp));
      }
      const out = S.map.spawns.map((sp) => (S.field[idx(sp.x, sp.y)] < 1e9 ? S.path(sp) : []));
      S.field = saved;
      return out;
    };
    S.idx = idx;
    return S;
  }

  /* ---- Base Duel AI: shared by the bot and the ctx.test.placeAI hook ---- */
  function baseTileScores(S, type) {
    // traffic-weighted coverage of each tile over the current paths
    const traffic = new Float32Array(BW * BH);
    for (const sp of S.map.spawns) for (const i of S.path(sp)) traffic[i] += 1;
    const out = [];
    const hot = [];
    for (let j = 0; j < BW * BH; j++) if (traffic[j]) hot.push(j);
    const R = type === "spike" ? 0 : (TOWERS[type].range || 1.5), R2 = R * R;
    const hx = hot.map((j) => j % BW), hy = hot.map((j) => (j / BW) | 0);
    const hw = hot.map((j) => traffic[j] * (1 + 0.08 * (S.field[j] < 6 ? 6 - S.field[j] : 0)));
    for (let y = 0; y < BH; y++) for (let x = 0; x < BW; x++) {
      const i = y * BW + x;
      if (S.map.grid[i] || S.structs[i]) continue;
      if (type === "spike") { if (traffic[i] > 0) out.push({ x, y, v: traffic[i] * (1 + 0.3 * nearFrost(S, x, y)) }); continue; }
      if (traffic[i] > 0 && type !== "wall") { /* towers on the path block it; allowed but reroutes */ }
      let v = 0;
      for (let k = 0; k < hot.length; k++) {
        const dx = hx[k] - x, dy = hy[k] - y;
        if (dx * dx + dy * dy <= R2) v += hw[k];
      }
      if (traffic[i] > 0) v *= 0.8;
      out.push({ x, y, v });
    }
    return out;
  }
  function nearFrost(S, x, y) {
    let n = 0;
    for (const s of S.structs) if (s && s.type === "frost" && Math.hypot(s.x - x, s.y - y) <= TOWERS.frost.range) n = 1;
    return n;
  }
  function pathLen(S) { let t = 0; for (const sp of S.map.spawns) t += S.field[sp.y * BW + sp.x]; return t; }

  /* Place walls that lengthen the path the most (mazing). Strong bots maze well; weak ones barely. */
  /* The Base Duel AI is driven by explicit knobs so its strength is measurable:
       maze   share of starting gold spent on path-lengthening walls
       search share of candidate tiles evaluated for each wall / tower
       noise  multiplicative noise on tile values (bad reads of the map)
       sloppy chance a tower goes on a random legal tile
       comp   'smart' (frost + arrows + cannons + spikes in proportion) or 'random'
       bomb   firebomb policy: 0 = random throws, 1 = waits for clusters near the base
       repair whether it repairs damaged towers between/during waves */
  function aiParams(skill, rng) {
    const j = () => 0.85 + 0.3 * rng();
    const orders = [["frost", "spike", "spike", "cannon"], ["frost", "spike", "cannon", "spike"], ["cannon", "frost", "spike", "spike"]];
    return {
      maze: clamp((0.55 - skill) * 0.35 * j(), 0, 0.3), // weak bots waste gold on walls that do not form a maze
      search: clamp(0.1 + 0.9 * skill, 0.1, 1),
      noise: (1 - skill) * 0.9,
      sloppy: clamp(0.95 - skill * 1.15, 0, 0.85),
      comp: skill > 0.65 ? U.pick(rng, orders) : skill > 0.35 ? "smart" : "random",
      bomb: skill > 0.4 ? 1 : 0,
      bombNeed: 120 + 90 * skill,
      repair: skill > 0.55,
      hold: Math.round((1 - skill) * 40),
      mine: skill > 0.6 && skill < 0.8 && rng() < 0.5,
    };
  }
  function aiWalls(S, rng, P, budget) {
    let spentW = 0, guard = 0;
    while (spentW + TOWERS.wall.cost <= budget && S.gold >= TOWERS.wall.cost && guard++ < 30) {
      const base = pathLen(S);
      let best = null, bv = 0;
      const cands = [];
      for (let y = 0; y < BH; y++) for (let x = 0; x < BW; x++) {
        const i = y * BW + x;
        if (S.map.grid[i] || S.structs[i]) continue;
        if (Math.abs(x - S.map.base.x) + Math.abs(y - S.map.base.y) <= 1) continue;
        cands.push([x, y]);
      }
      const n = Math.min(40, Math.max(6, Math.round(cands.length * P.search)));
      const pickFrom = U.shuffle(rng, cands).slice(0, n);
      for (const [x, y] of pickFrom) {
        const i = y * BW + x;
        S.structs[i] = { type: "wall" };
        const f = bfsField(S.map, (k) => S.map.grid[k] === 1 || (S.structs[k] && TOWERS[S.structs[k].type].block));
        S.structs[i] = null;
        let len = 0; for (const sp of S.map.spawns) len += f[sp.y * BW + sp.x];
        if (len >= 1e9) continue; // would seal the path
        const gain = len - base + U.gauss(rng) * P.noise * 2;
        if (gain > bv) { bv = gain; best = [x, y]; }
      }
      if (!best || bv < 0.9) break;
      if (S.place("wall", best[0], best[1])) break;
      spentW += TOWERS.wall.cost;
    }
  }
  function aiPickTile(S, rng, P, type) {
    const sc = baseTileScores(S, type);
    if (!sc.length) return null;
    const ok = (c) => !S.canPlace(type, c.x, c.y);
    if (rng() < P.sloppy) { // sloppy placement: any legal tile
      const sh = U.shuffle(rng, sc);
      for (const c of sh.slice(0, 12)) if (ok(c)) return c;
      return null;
    }
    const pool = P.search >= 1 ? sc : U.shuffle(rng, sc).slice(0, Math.max(4, Math.round(sc.length * P.search)));
    for (const c of pool) c.nv = c.v * (1 + U.gauss(rng) * P.noise * 0.6);
    pool.sort((a, b) => b.nv - a.nv || a.y - b.y || a.x - b.x);
    for (const c of pool.slice(0, 12)) if (ok(c)) return c;
    return null;
  }
  function aiBuild(S, rng, P, phase) {
    if (typeof P === "number") P = aiParams(P, rng);
    if (phase === "build") {
      aiWalls(S, rng, P, Math.floor(S.gold * P.maze / 10) * 10);
      if (S.mode === "full" && P.mine) { const t = aiPickTile(S, rng, { sloppy: 0, search: 1, noise: 0.3 }, "wall"); if (t) S.place("mine", t.x, t.y); }
    }
    let guard = 0;
    while (guard++ < 20) {
      let type;
      const counts = {}; for (const s of S.list) counts[s.type] = (counts[s.type] || 0) + 1;
      if (Array.isArray(P.comp)) {
        type = P.comp[(S.list.filter((q) => q.type !== "wall").length) % P.comp.length];
      } else if (P.comp === "smart") {
        if (!counts.frost && S.gold >= 60) type = "frost";
        else if ((counts.cannon || 0) < ((counts.arrow || 0) + 1) / 2 && S.gold >= 90) type = "cannon";
        else if (S.gold < 50 && S.gold >= 30 && (counts.spike || 0) < 3) type = "spike";
        else type = "arrow";
      } else {
        type = U.pick(rng, ["arrow", "arrow", "cannon", "frost", "spike", "wall", "mine"]);
      }
      if (TOWERS[type].cost > S.gold) {
        type = ["arrow", "spike"].find((t) => TOWERS[t].cost <= S.gold);
        if (!type) break;
      }
      const hold = phase === "window" ? P.hold : 0;
      if (S.gold - TOWERS[type].cost < hold) break;
      const t = aiPickTile(S, rng, P, type);
      if (!t) break;
      if (S.place(type, t.x, t.y)) break;
    }
  }
  /* In-wave decision policy for the bot: firebomb timing + repairs. Called every 10 ticks. */
  function aiAct(S, rng, P) {
    if (typeof P === "number") P = aiParams(P, rng);
    if (S.bombs > 0 && S.bombCd <= 0 && S.enemies.length) {
      const R2 = S.bombRadius * S.bombRadius, dmg = S.bombDamage();
      if (P.bomb) {
        let best = null, bv = 0;
        for (const e of S.enemies) {
          let v = 0;
          for (const o of S.enemies) if ((o.x - e.x) * (o.x - e.x) + (o.y - e.y) * (o.y - e.y) <= R2) v += Math.min(o.hp, dmg) * (1 + 0.15 * Math.max(0, 6 - S.field[o.ti]));
          if (v > bv) { bv = v; best = e; }
        }
        const wavesLeft = S.waves.length - S.wave;
        const need = P.bombNeed * (wavesLeft > S.bombs ? 1.25 : 0.8);
        if (best && bv >= need) S.bomb(best.x + U.gauss(rng) * P.noise * 0.4, best.y + U.gauss(rng) * P.noise * 0.4);
      } else if (rng() < 0.05) {
        const e = U.pick(rng, S.enemies);
        S.bomb(e.x + U.gauss(rng) * 0.8, e.y + U.gauss(rng) * 0.8);
      }
    }
    if (P.repair) {
      for (const s of S.list) {
        if (!s.maxHp || s.hp > s.maxHp * 0.45) continue;
        const c = S.repairCost(s);
        if (c && c <= S.gold - 10) S.repair(s.x, s.y);
      }
    }
  }
  function baseWaveSeconds(S) { return S.waveTick * S.dt; }
  const BOT_DT = 0.1;
  function baseBot(seed, skill, rng, mode, params) {
    const S = BaseSim(seed, mode);
    S.headless = true;
    S.setStep(BOT_DT); // coarser fixed step for the headless bot only (documented; ~2x faster, same rules)
    const cfg = S.cfg;
    const P = params || aiParams(skill, rng);
    aiBuild(S, rng, P, "build");
    const timeline = [];
    let t = cfg.buildMs / 1000 * (0.55 + 0.45 * rng());
    timeline.push([Math.round(t * 10) / 10, 0]);
    while (!S.over) {
      if (S.wave > 0) { aiBuild(S, rng, P, "window"); t += cfg.windowMs / 1000; }
      S.startWave();
      while (S.inWave && !S.over) {
        if (S.waveTick % Math.round(0.5 / S.dt) === 0) aiAct(S, rng, P);
        S.step();
      }
      t += baseRealFor(cfg, baseWaveSeconds(S)) / 1000;
      timeline.push([Math.round(t * 10) / 10, S.score()]);
    }
    const score = S.score();
    timeline[timeline.length - 1][1] = score;
    return { score, timeline };
  }

  /* Re-run a recorded game headlessly: log entries are [wave, waveTick (-1 = before the wave), op, ...args]. */
  function baseReplay(seed, mode, log) {
    const S = BaseSim(seed, mode);
    S.headless = true;
    let li = 0;
    const apply = (en) => {
      const op = en[2], a = en[3], b = en[4], c = en[5];
      if (op === "place") S.place(a, b, c); else if (op === "sell") S.sell(a, b); else if (op === "repair") S.repair(a, b); else if (op === "bomb") S.bomb(a, b);
    };
    while (!S.over) {
      while (li < log.length && log[li][0] === S.wave && log[li][1] === -1) apply(log[li++]);
      S.startWave();
      while (S.inWave && !S.over) {
        while (li < log.length && log[li][0] === S.wave && log[li][1] === S.waveTick) apply(log[li++]);
        S.step();
      }
    }
    return { score: S.score(), survived: S.survived, hp: S.baseHp, kills: S.kills, gold: S.gold };
  }
  const BASE_LAB = { baseReplay, aiParams, baseSimAt, baseRealFor, BaseSim, baseMap, baseWaves, baseConfig, aiBuild, aiAct, baseBot, TOWERS, ENEMIES, BW, BH, DT };

  /* ====================================================================================
     CITY DUEL — engine
     ==================================================================================== */
  // use: energy/water consumption; traf: trips generated; crime; pol: pollution emitted (felt within radius 2)
  const BLD = {
    res:  { name: "Residential", short: "Homes", tile: "Home", key: "R", cost: 500,  col: "#5AD690", house: 150, energy: 1, water: 1, traf: 1, crime: 1,
            desc: "Houses 150 people. Needs jobs, power and water. Likes parks and services; hates pollution." },
    com:  { name: "Commercial", short: "Shops", tile: "Shop", key: "C", cost: 700,  col: "#6FC3FF", jobs: 50, energy: 1, water: 0.5, traf: 2, crime: 1.5,
            desc: "50 jobs. Homes within 2 tiles get +6 happiness. Sells to up to 300 residents." },
    ind:  { name: "Industrial", short: "Factory", tile: "Fact", key: "I", cost: 700, col: "#C9A26B", jobs: 110, energy: 2, water: 1, traf: 2, crime: 0.5, pol: 3,
            desc: "110 jobs and $220 output. Pollutes homes within 2 tiles (−8 happiness per point)." },
    park: { name: "Park", short: "Park", tile: "Park", key: "P", cost: 250, col: "#2FA36B", energy: 0, water: 0.5, clean: 1,
            desc: "+7 happiness for homes within 2 tiles (2 parks max). Cancels 1 pollution next to it." },
    power:{ name: "Power plant", short: "Power", tile: "Power", key: "E", cost: 1100, col: "#FFB35C", jobs: 20, gen: 9, water: 0.5, traf: 1, pol: 2,
            desc: "+9 energy for the whole city. Pollutes within 2 tiles." },
    transit:{ name: "Transit stop", short: "Transit", tile: "Bus", key: "T", cost: 400, col: "#B48CFF", energy: 0.5, jobs: 5, radius: 2,
            desc: "Halves traffic from buildings within 2 tiles. Stacks do not help." },
    hosp: { name: "Hospital", short: "Hospital", tile: "Hosp", key: "H", cost: 1200, col: "#FF8FA3", jobs: 45, energy: 1, water: 1, traf: 1, radius: 3,
            desc: "+14 happiness for homes within 3 tiles. 45 jobs." },
    school:{ name: "School", short: "School", tile: "Schl", key: "S", cost: 900, col: "#F2C14E", jobs: 30, energy: 1, water: 0.5, traf: 1, radius: 2,
            desc: "+9 happiness and faster growth for homes within 2 tiles. 30 jobs." },
    police:{ name: "Police", short: "Police", tile: "Cops", key: "X", cost: 800, col: "#8FB3FF", jobs: 20, energy: 0.5, water: 0.5, radius: 3,
            desc: "Cuts crime by 70% within 3 tiles; +5 happiness for homes there. 20 jobs." },
    water: { name: "Water tower", short: "Water", tile: "Water", key: "W", cost: 600, col: "#4FC3D9", wgen: 8, energy: 0.5,
            desc: "+8 water for the whole city." },
    stadium:{ name: "Stadium", short: "Stadium", tile: "Arena", key: "D", cost: 2200, col: "#E06CE0", jobs: 50, energy: 2, water: 1, traf: 4, crime: 2,
            desc: "+6 happiness city-wide (once), $250 ticket income, 50 jobs. Heavy traffic." },
  };
  const BLD_ORDER = ["res", "com", "ind", "park", "power", "water", "transit", "hosp", "school", "police", "stadium"];
  const OUTSIDE = { energy: 3, water: 3 };

  function cityConfig(mode) {
    return mode === "mix" ? { n: 5, budget: 6000, buildMs: 35000, cap: 18 } : { n: 7, budget: 10000, buildMs: 90000, cap: 30 };
  }
  function cityMap(seed, mode) {
    const c = cityConfig(mode), rng = U.rng("city-map:" + seed + ":" + mode);
    const tiles = new Array(c.n * c.n).fill(0); // 0 land, 1 water, 2 rock
    const nW = mode === "mix" ? U.randInt(rng, 2, 3) : U.randInt(rng, 3, 5);
    const nR = mode === "mix" ? U.randInt(rng, 1, 2) : U.randInt(rng, 2, 3);
    // water as a small lake cluster on an edge
    let x = rng() < 0.5 ? 0 : c.n - 1, y = U.randInt(rng, 0, c.n - 1);
    if (rng() < 0.5) [x, y] = [y, x];
    for (let k = 0, guard = 0; k < nW && guard < 50; guard++) {
      if (!tiles[y * c.n + x]) { tiles[y * c.n + x] = 1; k++; }
      const d = U.pick(rng, [[1, 0], [-1, 0], [0, 1], [0, -1]]);
      x = clamp(x + d[0], 0, c.n - 1); y = clamp(y + d[1], 0, c.n - 1);
    }
    for (let k = 0, guard = 0; k < nR && guard < 50; guard++) {
      const i = U.randInt(rng, 0, c.n * c.n - 1);
      if (!tiles[i]) { tiles[i] = 2; k++; }
    }
    return { n: c.n, tiles, budget: c.budget, cap: c.cap };
  }
  /* Evaluate a city. plan = array (n*n) of building keys or null. Pure, fast.
     Each home's happiness depends on what it can reach (coverage radii, Chebyshev distance) and on city-wide
     problems (jobs, utilities, traffic, crime, pollution). Population = housing scaled by happiness. */
  function cityEval(map, plan) {
    const n = map.n, list = [];
    let spent = 0;
    for (let i = 0; i < plan.length; i++) if (plan[i]) { list.push({ t: plan[i], x: i % n, y: (i / n) | 0, B: BLD[plan[i]] }); spent += BLD[plan[i]].cost; }
    const dist = (a, b) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
    let eUse = 0, eGen = OUTSIDE.energy, wUse = 0, wGen = OUTSIDE.water;
    for (const b of list) { eUse += b.B.energy || 0; eGen += b.B.gen || 0; wUse += b.B.water || 0; wGen += b.B.wgen || 0; }
    const pRatio = eUse ? Math.min(1, eGen / eUse) : 1, wRatio = wUse ? Math.min(1, wGen / wUse) : 1;
    const util = Math.min(pRatio, wRatio);
    const by = (t) => list.filter((b) => b.t === t);
    const homes = by("res"), transits = by("transit"), polices = by("police");
    let traf = 0, crime = 0;
    for (const b of list) {
      if (b.B.traf) traf += b.B.traf * (transits.some((t) => dist(t, b) <= 2) ? 0.5 : 1);
      if (b.B.crime) crime += b.B.crime * (polices.some((p) => dist(p, b) <= 3) ? 0.3 : 1);
    }
    const trafficPct = clamp(100 * traf / map.cap, 0, 100);
    const crimePct = clamp(100 * crime / (map.cap * 0.5), 0, 100);
    let housing = 0, jobs = 0;
    for (const b of list) { housing += b.B.house || 0; jobs += b.B.jobs || 0; }
    housing *= util; jobs *= util;
    const hasStadium = list.some((b) => b.t === "stadium");
    const workers = housing * 0.5;
    const employed = Math.min(workers, jobs);
    const employment = workers > 0 ? employed / workers : 0;
    const jobFill = jobs > 0 ? employed / jobs : 0;
    let happy = 0, polSum = 0, schoolCov = 0;
    const homeHap = {};
    for (const h of homes) {
      let pol = 0, parks = 0, hosp = false, school = false, police = false, shop = false;
      for (const b of list) {
        const d = dist(b, h);
        if (b.B.pol && d <= 2) pol += b.B.pol * (d <= 1 ? 1 : 0.5);
        if (b.t === "park" && d <= 1) pol -= 1;
        if (b.t === "park" && d <= 2) parks++;
        if (b.t === "hosp" && d <= 3) hosp = true;
        if (b.t === "school" && d <= 2) school = true;
        if (b.t === "police" && d <= 3) police = true;
        if (b.t === "com" && d <= 2) shop = true;
      }
      pol = Math.max(0, pol); polSum += pol;
      if (school) schoolCov++;
      const hh = 44 + Math.min(2, parks) * 7 + (hosp ? 14 : 0) + (school ? 9 : 0) + (police ? 5 : 0) + (shop ? 6 : 0) + (hasStadium ? 6 : 0)
        - pol * 8 - crimePct * 0.25 - trafficPct * 0.2 - (1 - employment) * 30 - (1 - util) * 60;
      happy += clamp(hh, 0, 100);
      homeHap[h.y * n + h.x] = Math.round(clamp(hh, 0, 100));
    }
    const happiness = homes.length ? happy / homes.length : 0;
    const population = housing * (0.4 + 0.6 * happiness / 100);
    const shops = by("com").length, facts = by("ind").length;
    const taxes = employed * 1.5;
    const sales = Math.min(shops * 300, population) * 0.9 * Math.min(1, jobFill * 1.25);
    const output = facts * 220 * util * Math.min(1, jobFill * 1.25);
    const tickets = hasStadium ? 250 * util : 0;
    const upkeep = spent * 0.04;
    const revenue = taxes + sales + output + tickets - upkeep;
    const pollutionPct = homes.length ? clamp(polSum / homes.length * 20, 0, 100) : 0;
    const growth = homes.length ? clamp((happiness - 45) / 5 * employment * (0.5 + 0.5 * schoolCov / homes.length), -10, 10) : 0;
    const content = population * (15 + happiness) / 115;
    const parts = { people: content / 6, money: Math.max(-40, revenue / 40), growth: growth >= 0 ? growth * 3 : growth };
    const scoreRaw = parts.people + parts.money + parts.growth;
    const score10 = Math.max(0, Math.round(scoreRaw * 10));
    return {
      spent, left: map.budget - spent, population, happiness, revenue, trafficPct, crimePct, pollutionPct,
      energy: [eGen, eUse], water: [wGen, wUse], util, employment, jobs, housing, growth, content, parts,
      score10, count: list.length, homeHap,
    };
  }
  /* Allocation-free score-only twin of cityEval for the planner. Same formulas, same summation order, so
     cityScore(map, plan) === cityEval(map, plan).score10 exactly (asserted by the tests). */
  const BIDX = {}; BLD_ORDER.forEach((k, i) => (BIDX[k] = i));
  const CB = BLD_ORDER.map((k) => BLD[k]);
  const _cx = new Int8Array(64), _cy = new Int8Array(64), _ct = new Int8Array(64);
  function cityScore(map, plan) {
    const n = map.n;
    let m = 0, spent = 0;
    for (let i = 0; i < plan.length; i++) { const k = plan[i]; if (k) { _ct[m] = BIDX[k]; _cx[m] = i % n; _cy[m] = (i / n) | 0; m++; spent += BLD[k].cost; } }
    let eUse = 0, eGen = OUTSIDE.energy, wUse = 0, wGen = OUTSIDE.water;
    for (let a = 0; a < m; a++) { const B = CB[_ct[a]]; eUse += B.energy || 0; eGen += B.gen || 0; wUse += B.water || 0; wGen += B.wgen || 0; }
    const pRatio = eUse ? Math.min(1, eGen / eUse) : 1, wRatio = wUse ? Math.min(1, wGen / wUse) : 1;
    const util = Math.min(pRatio, wRatio);
    const T_RES = BIDX.res, T_TR = BIDX.transit, T_PO = BIDX.police, T_PARK = BIDX.park, T_HOSP = BIDX.hosp, T_SCH = BIDX.school, T_COM = BIDX.com, T_IND = BIDX.ind, T_ST = BIDX.stadium;
    const dist = (a, b) => Math.max(Math.abs(_cx[a] - _cx[b]), Math.abs(_cy[a] - _cy[b]));
    let traf = 0, crime = 0;
    for (let a = 0; a < m; a++) {
      const B = CB[_ct[a]];
      if (B.traf) { let near = false; for (let b = 0; b < m && !near; b++) if (_ct[b] === T_TR && dist(b, a) <= 2) near = true; traf += B.traf * (near ? 0.5 : 1); }
      if (B.crime) { let near = false; for (let b = 0; b < m && !near; b++) if (_ct[b] === T_PO && dist(b, a) <= 3) near = true; crime += B.crime * (near ? 0.3 : 1); }
    }
    const trafficPct = clamp(100 * traf / map.cap, 0, 100);
    const crimePct = clamp(100 * crime / (map.cap * 0.5), 0, 100);
    let housing = 0, jobs = 0, hasStadium = false, nHomes = 0, shops = 0, facts = 0;
    for (let a = 0; a < m; a++) {
      const t = _ct[a], B = CB[t]; housing += B.house || 0; jobs += B.jobs || 0;
      if (t === T_ST) hasStadium = true; else if (t === T_RES) nHomes++; else if (t === T_COM) shops++; else if (t === T_IND) facts++;
    }
    housing *= util; jobs *= util;
    const workers = housing * 0.5;
    const employed = Math.min(workers, jobs);
    const employment = workers > 0 ? employed / workers : 0;
    const jobFill = jobs > 0 ? employed / jobs : 0;
    let happy = 0, schoolCov = 0;
    for (let h = 0; h < m; h++) {
      if (_ct[h] !== T_RES) continue;
      let pol = 0, parks = 0, hosp = false, school = false, police = false, shop = false;
      for (let b = 0; b < m; b++) {
        const t = _ct[b], B = CB[t], d = dist(b, h);
        if (B.pol && d <= 2) pol += B.pol * (d <= 1 ? 1 : 0.5);
        if (t === T_PARK && d <= 1) pol -= 1;
        if (t === T_PARK && d <= 2) parks++;
        if (t === T_HOSP && d <= 3) hosp = true;
        if (t === T_SCH && d <= 2) school = true;
        if (t === T_PO && d <= 3) police = true;
        if (t === T_COM && d <= 2) shop = true;
      }
      pol = Math.max(0, pol);
      if (school) schoolCov++;
      const hh = 44 + Math.min(2, parks) * 7 + (hosp ? 14 : 0) + (school ? 9 : 0) + (police ? 5 : 0) + (shop ? 6 : 0) + (hasStadium ? 6 : 0)
        - pol * 8 - crimePct * 0.25 - trafficPct * 0.2 - (1 - employment) * 30 - (1 - util) * 60;
      happy += clamp(hh, 0, 100);
    }
    const happiness = nHomes ? happy / nHomes : 0;
    const population = housing * (0.4 + 0.6 * happiness / 100);
    const taxes = employed * 1.5;
    const sales = Math.min(shops * 300, population) * 0.9 * Math.min(1, jobFill * 1.25);
    const output = facts * 220 * util * Math.min(1, jobFill * 1.25);
    const tickets = hasStadium ? 250 * util : 0;
    const upkeep = spent * 0.04;
    const revenue = taxes + sales + output + tickets - upkeep;
    const growth = nHomes ? clamp((happiness - 45) / 5 * employment * (0.5 + 0.5 * schoolCov / nHomes), -10, 10) : 0;
    const content = population * (15 + happiness) / 115;
    const scoreRaw = content / 6 + Math.max(-40, revenue / 40) + (growth >= 0 ? growth * 3 : growth);
    return Math.max(0, Math.round(scoreRaw * 10));
  }
  function cityCanPlace(map, plan, i, t) {
    if (map.tiles[i]) return map.tiles[i] === 1 ? "Water" : "Rock";
    if (plan[i]) return "Occupied";
    let spent = 0; for (const k of plan) if (k) spent += BLD[k].cost;
    if (spent + BLD[t].cost > map.budget) return "Over budget";
    return "";
  }
  /* Planner: simulated annealing over the same scoring function. The iteration budget (search effort) and a
     noisy acceptance scale with skill; snapshots of the best-so-far give the bot's build timeline. */
  function cityPlan(map, rng, skill, itersOverride) {
    const N = map.n * map.n, plan = new Array(N).fill(null);
    const full = map.n >= 7;
    const iters = itersOverride || Math.round((full ? 200 : 120) + (full ? 3200 : 2000) * Math.pow(skill, 2.2));
    const T0 = full ? 120 : 60;
    let cur = cityScore(map, plan), best = cur, bp = plan.slice(), spent = 0;
    const free = [];
    for (let i = 0; i < N; i++) if (!map.tiles[i]) free.push(i);
    const snaps = [];
    const every = Math.max(1, Math.floor(iters / 12));
    for (let k = 0; k < iters; k++) {
      const T = T0 * (1 - k / iters) + 0.5;
      const i = free[Math.floor(rng() * free.length)], old = plan[i];
      const nt = old && rng() < 0.3 ? null : BLD_ORDER[Math.floor(rng() * BLD_ORDER.length)];
      const ns = spent - (old ? BLD[old].cost : 0) + (nt ? BLD[nt].cost : 0);
      if (ns > map.budget) { if (k % every === every - 1) snaps.push(best); continue; }
      plan[i] = nt;
      const sc = cityScore(map, plan);
      if (sc >= cur || rng() < Math.exp((sc - cur) / T)) { cur = sc; spent = ns; if (sc > best) { best = sc; bp = plan.slice(); } }
      else plan[i] = old;
      if (k % every === every - 1) snaps.push(best);
    }
    return { plan: bp, score10: best, snaps };
  }
  function cityBot(seed, skill, rng, mode) {
    const map = cityMap(seed, mode), cfg = cityConfig(mode);
    const res = cityPlan(map, rng, skill);
    const T = cfg.buildMs / 1000 * (0.6 + 0.35 * rng());
    const timeline = [];
    res.snaps.forEach((v, k) => timeline.push([Math.round(T * (k + 1) / res.snaps.length * 10) / 10, v / 10]));
    const score = res.score10 / 10;
    timeline.push([Math.round((cfg.buildMs / 1000 + 3) * 10) / 10, score]);
    return { score, timeline };
  }
  const CITY_LAB = { cityScore, BLD, BLD_ORDER, cityConfig, cityMap, cityEval, cityCanPlace, cityPlan, cityBot };

  /* ====================================================================================
     RESTAURANT DUEL — engine
     ==================================================================================== */
  const CTYPES = {
    family:   { name: "Families",  budget: 22, sens: 1.0, patience: [15, 30], size: [3, 6], stay: 45 },
    business: { name: "Business",  budget: 40, sens: 0.35, patience: [8, 18], size: [1, 3], stay: 35 },
    student:  { name: "Students",  budget: 14, sens: 1.6, patience: [15, 35], size: [2, 4], stay: 40 },
    foodie:   { name: "Foodies",   budget: 38, sens: 0.45, patience: [20, 40], size: [1, 3], stay: 55 },
    tourist:  { name: "Tourists",  budget: 28, sens: 0.8, patience: [10, 25], size: [2, 4], stay: 45 },
  };
  const CT_ORDER = ["family", "business", "student", "foodie", "tourist"];
  // cost = ingredients per plate; prep = chef minutes; pop by customer type
  const DISHES = {
    burger:  { name: "Burger",        cost: 5,  price: 16, prep: 7,  pop: { family: 0.9, business: 0.45, student: 1.0, foodie: 0.25, tourist: 0.7 } },
    pizza:   { name: "Pizza",         cost: 4,  price: 18, prep: 10, pop: { family: 1.0, business: 0.4, student: 0.9, foodie: 0.35, tourist: 0.75 } },
    salad:   { name: "Salad bowl",    cost: 3,  price: 13, prep: 4,  pop: { family: 0.35, business: 0.8, student: 0.45, foodie: 0.5, tourist: 0.45 } },
    pasta:   { name: "Fresh pasta",   cost: 4,  price: 20, prep: 9,  pop: { family: 0.8, business: 0.65, student: 0.6, foodie: 0.7, tourist: 0.85 } },
    steak:   { name: "Steak frites",  cost: 14, price: 38, prep: 14, pop: { family: 0.45, business: 1.0, student: 0.1, foodie: 0.8, tourist: 0.7 } },
    sushi:   { name: "Sushi set",     cost: 11, price: 32, prep: 12, pop: { family: 0.3, business: 0.8, student: 0.3, foodie: 1.0, tourist: 0.85 } },
    curry:   { name: "Curry",         cost: 4,  price: 17, prep: 8,  pop: { family: 0.6, business: 0.5, student: 0.8, foodie: 0.75, tourist: 0.6 } },
    tacos:   { name: "Tacos",         cost: 3,  price: 12, prep: 5,  pop: { family: 0.75, business: 0.35, student: 0.95, foodie: 0.45, tourist: 0.65 } },
    soup:    { name: "Soup & bread",  cost: 2,  price: 9,  prep: 3,  pop: { family: 0.5, business: 0.45, student: 0.6, foodie: 0.3, tourist: 0.4 } },
    seafood: { name: "Seafood platter", cost: 20, price: 52, prep: 18, pop: { family: 0.25, business: 0.75, student: 0.05, foodie: 1.0, tourist: 1.0 } },
  };
  const DISH_ORDER = ["burger", "pizza", "salad", "pasta", "steak", "sushi", "curry", "tacos", "soup", "seafood"];
  const KITCHEN = [
    { name: "Basic", cost: 0, speed: 1.0, maxChefs: 2, quality: 0 },
    { name: "Pro", cost: 900, speed: 1.3, maxChefs: 4, quality: 0.03 },
    { name: "Elite", cost: 2600, speed: 1.6, maxChefs: 6, quality: 0.07 },
  ];
  const RCOST = { table: 120, chef: 300, waiter: 180, dish: 150 };
  const DRINK = { price: 5, cost: 1.5 };
  const DEPR = 0.35; // kitchen + tables are assets: one day is charged 35% of their cost
  const DAY_OPEN = 11 * 60, DAY_MIN = 12 * 60; // 11:00 – 23:00

  function restConfig(mode) {
    return mode === "mix" ? { budget: 10000, planMs: 30000, simMs: 3000 } : { budget: 10000, planMs: 60000, simMs: 4000 };
  }
  function restDay(seed) {
    const rng = U.rng("rest-day:" + seed);
    // type mix shifts per seed so the best menu differs by day
    const w = CT_ORDER.map(() => 0.4 + rng());
    const tw = w.reduce((a, b) => a + b, 0);
    const parties = [];
    for (let k = 0; k < 100; k++) {
      let r = rng() * tw, ti = 0;
      while (r > w[ti]) { r -= w[ti]; ti++; }
      const type = CT_ORDER[Math.min(ti, 4)], C = CTYPES[type];
      // arrival: lunch peak, dinner peak, or spread
      const z = rng();
      let t;
      if (z < 0.36) t = 60 + U.gauss(rng) * 45;         // ~12:00
      else if (z < 0.8) t = 480 + U.gauss(rng) * 60;   // ~19:00
      else t = rng() * DAY_MIN;
      t = Math.round(clamp(t, 0, DAY_MIN - 60));
      const jit = {};
      for (const d of DISH_ORDER) jit[d] = (rng() - 0.5) * 0.3;
      parties.push({
        id: k, type, t, size: U.randInt(rng, C.size[0], C.size[1]),
        patience: U.randInt(rng, C.patience[0], C.patience[1]),
        budget: C.budget * (0.8 + rng() * 0.45), sens: C.sens * (0.8 + rng() * 0.4),
        th: rng(), jit,
      });
    }
    parties.sort((a, b) => a.t - b.t || a.id - b.id);
    return { seed, parties, mix: CT_ORDER.map((k, i) => [k, Math.round(100 * w[i] / tw)]) };
  }
  function restDefaultPlan() {
    return { kitchen: 0, tables: 8, chefs: 2, waiters: 2, menu: ["burger", "pizza", "pasta"], price: 1.0, marketing: 500 };
  }
  function restSpend(plan) {
    return KITCHEN[plan.kitchen].cost + plan.tables * RCOST.table + plan.chefs * RCOST.chef + plan.waiters * RCOST.waiter + plan.menu.length * RCOST.dish + plan.marketing;
  }
  function restValid(plan, budget) {
    if (plan.menu.length < 3) return "Pick at least 3 dishes";
    if (plan.menu.length > 5) return "Pick at most 5 dishes";
    if (plan.chefs > KITCHEN[plan.kitchen].maxChefs) return KITCHEN[plan.kitchen].name + " kitchen fits " + KITCHEN[plan.kitchen].maxChefs + " chefs";
    if (restSpend(plan) > budget) return "Over budget";
    return "";
  }
  /* Simulate the day. Returns totals, P&L, reputation and a per-10-minute trace for the animation. */
  function restSim(day, plan, withTrace) {
    const K = KITCHEN[plan.kitchen];
    const chefs = Math.min(plan.chefs, K.maxChefs);
    const complexity = 1 + 0.07 * Math.max(0, plan.menu.length - 3);
    const mkt = 1 - Math.exp(-plan.marketing / 1000);
    const pm = plan.price;
    // per-party order: each guest picks the dish with best utility; utility < 0.1 -> orders nothing
    const orders = [];
    let visitors = 0;
    for (const p of day.parties) {
      let bestD = null, bu = -9, fitSum = 0;
      for (const d of plan.menu) {
        const D = DISHES[d];
        const price = D.price * pm;
        const u = D.pop[p.type] + p.jit[d] + K.quality - p.sens * Math.max(0, price - p.budget) / p.budget * 1.6 - 0.1 * (pm - 1);
        if (u > bu) { bu = u; bestD = d; }
        fitSum += Math.max(0, u);
      }
      const appeal = 0.3 + 0.5 * mkt + 0.3 * clamp(bu, 0, 1) + 0.04 * Math.min(1, fitSum / 2) - 0.55 * Math.max(0, pm - 1) * p.sens + 0.25 * Math.max(0, 1 - pm) * p.sens;
      orders.push({ p, come: appeal >= p.th, dish: bu >= 0.1 ? bestD : null, u: bu });
      if (appeal >= p.th) visitors++;
    }
    const tables = new Array(plan.tables).fill(0); // free-at minute
    const chefFree = new Array(chefs).fill(0), waiterFree = new Array(plan.waiters).fill(0);
    let revenue = 0, cogs = 0, served = 0, unhappy = 0, satSum = 0, guests = 0, walked = 0, lostWait = 0, lostMenu = 0;
    const queue = []; // {o, t}
    const out = [];
    const events = []; // for animation: [minute, kind, size]
    function tryServe(o, now) {
      const need = Math.ceil(o.p.size / 4);
      const free = [];
      for (let i = 0; i < tables.length && free.length < need; i++) if (tables[i] <= now) free.push(i);
      if (free.length < need) return false;
      const waited = now - o.p.t;
      // waiter takes the order (2 min per party + 0.5 per guest)
      let wi = 0; for (let i = 1; i < waiterFree.length; i++) if (waiterFree[i] < waiterFree[wi]) wi = i;
      const orderAt = Math.max(now, waiterFree[wi]);
      waiterFree[wi] = orderAt + 3 + 1.2 * o.p.size; // take order, carry plates, bill
      // kitchen: each plate on the chef that frees first
      const D = DISHES[o.dish];
      // one chef cooks the party's order as a batch: first plate takes full prep, extra plates 30% each
      const prep = D.prep * (1 + 0.3 * (o.p.size - 1)) * complexity / K.speed;
      let ci = 0; for (let i = 1; i < chefFree.length; i++) if (chefFree[i] < chefFree[ci]) ci = i;
      const st = Math.max(orderAt + 2, chefFree[ci]);
      chefFree[ci] = st + prep;
      const ready = st + prep;
      const leaveAt = ready + CTYPES[o.p.type].stay;
      for (const i of free) tables[i] = leaveAt + 3;
      const foodWait = ready - o.p.t;
      const price = D.price * pm;
      const sat = clamp(0.55 + 0.35 * clamp(o.u, 0, 1.2) - 0.015 * Math.max(0, foodWait - 20) - 0.012 * waited - 0.25 * Math.max(0, pm - 1) * o.p.sens + K.quality, 0, 1);
      revenue += (price + DRINK.price * pm) * o.p.size * (1 + 0.12 * sat); // drinks + tips that scale with happiness
      cogs += (D.cost + DRINK.cost) * o.p.size;
      served++; guests += o.p.size; satSum += sat;
      out.push({ id: o.p.id, r: "served", seat: now, ready, leave: leaveAt, sat });
      events.push([now, "seat", o.p.size], [leaveAt, "leave", o.p.size]);
      return true;
    }
    let oi = 0;
    for (let now = 0; now <= DAY_MIN + 120; now++) {
      if (!queue.length) { // nothing waits: jump straight to the next arrival (exactly equivalent, much faster)
        if (oi >= orders.length) break;
        if (orders[oi].p.t > now) now = orders[oi].p.t;
      }
      while (oi < orders.length && orders[oi].p.t <= now) {
        const o = orders[oi++];
        if (!o.come) { walked++; continue; }
        if (!o.dish) { unhappy++; lostMenu++; out.push({ id: o.p.id, r: "menu" }); events.push([now, "left", o.p.size]); continue; }
        queue.push(o);
        events.push([now, "arrive", o.p.size]);
      }
      for (let q = 0; q < queue.length; q++) {
        const o = queue[q];
        if (now - o.p.t > o.p.patience) { queue.splice(q--, 1); unhappy++; lostWait++; out.push({ id: o.p.id, r: "wait" }); events.push([now, "left", o.p.size]); continue; }
        if (tryServe(o, now)) queue.splice(q--, 1);
      }
      if (now > DAY_MIN && !queue.length && oi >= orders.length) break;
    }
    const spend = restSpend(plan);
    const equip = KITCHEN[plan.kitchen].cost + plan.tables * RCOST.table;
    const depreciation = Math.round(equip * DEPR);
    const wages = plan.chefs * RCOST.chef + plan.waiters * RCOST.waiter;
    const menuCost = plan.menu.length * RCOST.dish;
    const reviews = served + unhappy;
    const stars = reviews ? 1 + 4 * (satSum / reviews) : 3;
    const repBonus = Math.round((stars - 3) * 900);
    const profit = Math.round(revenue - cogs - depreciation - wages - menuCost - plan.marketing);
    const score = Math.max(0, 5000 + profit + repBonus);
    const res = { visitors, served, unhappy, walked, guests, lostWait, lostMenu, revenue: Math.round(revenue), cogs: Math.round(cogs), spend, depreciation, wages, menuCost, marketing: plan.marketing, profit, stars, repBonus, score };
    if (withTrace) {
      res.out = out;
      // per-10-min trace of seated guests, queue, served & left totals
      events.sort((a, b) => a[0] - b[0]);
      const trace = [];
      let seated = 0, qn = 0, sv = 0, lf = 0, ei = 0;
      const arrivals = orders.filter((o) => o.come && o.dish);
      for (let m = 0; m <= DAY_MIN; m += 10) {
        while (ei < events.length && events[ei][0] <= m) {
          const [, k, n] = events[ei++];
          if (k === "seat") seated += n; else if (k === "leave") { seated -= n; sv++; } else if (k === "left") lf++;
        }
        qn = 0;
        for (const o of arrivals) {
          const r = out.find((x) => x.id === o.p.id);
          if (o.p.t <= m && r && ((r.r === "served" && r.seat > m) || (r.r === "wait" && o.p.t + o.p.patience >= m))) qn++;
        }
        trace.push({ m, seated: Math.max(0, seated), queue: qn, served: sv, left: lf });
      }
      res.trace = trace;
    }
    return res;
  }
  /* Optimiser used by the bot: random-restart hill climbing with a skill-scaled evaluation budget. */
  function restNeighbor(plan, rng) {
    const q = JSON.parse(JSON.stringify(plan));
    const r = Math.floor(rng() * 7);
    const step = rng() < 0.5 ? -1 : 1;
    if (r === 0) q.kitchen = clamp(q.kitchen + step, 0, 2);
    else if (r === 1) q.tables = clamp(q.tables + step * (1 + Math.floor(rng() * 3)), 2, 24);
    else if (r === 2) q.chefs = clamp(q.chefs + step, 1, 6);
    else if (r === 3) q.waiters = clamp(q.waiters + step, 1, 6);
    else if (r === 4) {
      const off = DISH_ORDER.filter((d) => !q.menu.includes(d));
      const mv = rng();
      if (mv < 0.5 && q.menu.length > 0) q.menu[Math.floor(rng() * q.menu.length)] = U.pick(rng, off);
      else if (mv < 0.75 && q.menu.length < 5) q.menu.push(U.pick(rng, off));
      else if (q.menu.length > 3) q.menu.splice(Math.floor(rng() * q.menu.length), 1);
    } else if (r === 5) q.price = Math.round(clamp(q.price + step * 0.05 * (1 + Math.floor(rng() * 2)), 0.7, 1.6) * 100) / 100;
    else q.marketing = clamp(q.marketing + step * 250, 0, 3000);
    if (q.chefs > KITCHEN[q.kitchen].maxChefs) q.chefs = KITCHEN[q.kitchen].maxChefs;
    return q;
  }
  function restRandomPlan(rng) {
    const k = Math.floor(rng() * 3);
    return {
      kitchen: k, tables: U.randInt(rng, 4, 16), chefs: U.randInt(rng, 1, KITCHEN[k].maxChefs), waiters: U.randInt(rng, 1, 4),
      menu: U.shuffle(rng, DISH_ORDER).slice(0, U.randInt(rng, 3, 5)),
      price: Math.round((0.8 + rng() * 0.6) * 20) / 20, marketing: 250 * U.randInt(rng, 0, 8),
    };
  }
  function restOptimise(day, rng, skill, evals) {
    const budget = 10000;
    let cur = restDefaultPlan();
    if (rng() > skill) cur = restRandomPlan(rng);
    while (restValid(cur, budget)) cur = restRandomPlan(rng);
    const noise = (1 - skill) * 700;
    let bestTrue = restSim(day, cur).score, cv = bestTrue + U.gauss(rng) * noise, best = cur;
    const snaps = [];
    const every = Math.max(1, Math.floor(evals / 10));
    for (let k = 0; k < evals; k++) {
      const q = restNeighbor(cur, rng);
      if (!restValid(q, budget)) {
        const tv = restSim(day, q).score;
        const v = tv + U.gauss(rng) * noise; // noisy judgement of the real simulation
        if (v >= cv) { cur = q; cv = v; best = q; bestTrue = tv; } // commits to what it believes is better
      }
      if (k % every === every - 1) snaps.push(bestTrue);
    }
    return { plan: best, score: bestTrue, snaps };
  }
  function restBot(seed, skill, rng, mode) {
    const day = restDay(seed), cfg = restConfig(mode);
    const evals = Math.round((mode === "mix" ? 8 : 12) + (mode === "mix" ? 90 : 160) * skill * skill);
    const r = restOptimise(day, rng, skill, evals);
    const T = cfg.planMs / 1000 * (0.6 + 0.35 * rng());
    const timeline = [];
    r.snaps.forEach((v, k) => timeline.push([Math.round(T * (k + 1) / Math.max(1, r.snaps.length) * 10) / 10, v]));
    timeline.push([Math.round((cfg.planMs + cfg.simMs) / 100) / 10, r.score]);
    return { score: r.score, timeline };
  }
  const REST_LAB = { CTYPES, CT_ORDER, DISHES, DISH_ORDER, KITCHEN, RCOST, restConfig, restDay, restDefaultPlan, restSpend, restValid, restSim, restOptimise, restRandomPlan, restNeighbor, restBot };

  /* ====================================================================================
     Shared UI styles (one block per game id, same structure)
     ==================================================================================== */
  function packCss(P) {
    return `
    .${P}{display:grid;gap:12px;container-type:inline-size;min-width:0}
    .${P} *{min-width:0}
    .${P}-hud{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}
    @container (min-width:520px){.${P}-hud{grid-template-columns:repeat(auto-fit,minmax(96px,1fr))}}
    .${P}-stat{background:var(--panel);border:1px solid var(--line);border-radius:var(--r-md);padding:6px 10px}
    .${P}-stat span{display:block;font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:var(--muted);font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .${P}-stat b{display:block;font-family:var(--f-mono);font-size:18px;font-variant-numeric:tabular-nums;white-space:nowrap}
    .${P}-stat.me{border-color:color-mix(in srgb,var(--gold) 55%,var(--line))}
    .${P}-stat.me b{color:var(--gold)}
    .${P}-main{display:grid;gap:12px;grid-template-columns:1fr}
    @container (min-width:700px){.${P}-main{grid-template-columns:minmax(0,1fr) var(--side,260px)}}
    .${P}-col{display:grid;gap:10px;align-content:start}
    .${P}-bar{display:flex;flex-wrap:wrap;gap:8px;align-items:center;justify-content:space-between}
    .${P}-phase{font-size:14px;font-weight:600}
    .${P}-msg{min-height:20px;font-size:13px;color:var(--muted)}
    .${P}-msg.bad{color:var(--bad)} .${P}-msg.good{color:var(--good)}
    .${P}-pal{display:flex;flex-wrap:wrap;gap:6px}
    .${P}-tool{display:flex;align-items:center;gap:8px;min-height:44px;padding:5px 10px 5px 8px;background:var(--panel-2);border:1px solid var(--line);border-radius:var(--r-sm);text-align:left;line-height:1.15;flex:1 1 104px}
    .${P}-tool:hover:not(:disabled){background:var(--panel-3)}
    .${P}-tool .sw{flex:none;width:14px;height:14px;border-radius:4px}
    .${P}-tool .tx{display:grid}
    .${P}-tool b{font-size:13px;font-weight:700}
    .${P}-tool small{font-family:var(--f-mono);font-size:12px;color:var(--gold)}
    .${P}-tool.poor small{color:var(--muted)}
    .${P}-tool[aria-pressed="true"]{border-color:var(--gold);background:color-mix(in srgb,var(--gold) 14%,var(--panel-2))}
    .${P}-tool:disabled{opacity:.4;cursor:not-allowed}
    .${P}-info{font-size:13px;color:var(--muted);background:var(--panel);border:1px solid var(--line);border-radius:var(--r-md);padding:8px 10px}
    .${P}-info b{color:var(--fg)}
    .${P} details{background:var(--panel);border:1px solid var(--line);border-radius:var(--r-md);padding:8px 10px;font-size:13px}
    .${P} summary{cursor:pointer;font-weight:600;min-height:28px}
    .${P}-rules{margin:6px 0 0;padding-left:18px;color:var(--muted)}
    .${P}-rules li{margin:2px 0}
    .${P}-res{background:var(--panel);border:1px solid color-mix(in srgb,var(--gold) 45%,var(--line));border-radius:var(--r-lg);padding:14px 16px;display:grid;gap:10px}
    .${P}-big{font-family:var(--f-display);font-size:44px;line-height:1;color:var(--gold);text-transform:uppercase}
    .${P}-big small{display:block;font-family:var(--f-body);font-size:14px;line-height:1.35;color:var(--muted);text-transform:none;margin-top:6px}
    .${P} .dg-table td,.${P} .dg-table th{padding:5px 6px}
    .${P} .tot td{font-weight:700;border-top:2px solid var(--line)}
    .${P} .dg-table .num{white-space:nowrap}
    `;
  }
  function stat(P, label, test, me) {
    return `<div class="${P}-stat${me ? " me" : ""}"><span>${label}</span><b data-test="${test}">–</b></div>`;
  }
  function makeSay(el, P) {
    return (t, kind) => { el.textContent = t || ""; el.className = P + "-msg" + (kind ? " " + kind : ""); };
  }
  function cssVar(el, k, d) {
    try { const v = getComputedStyle(el).getPropertyValue(k).trim(); return v || d; } catch (e) { return d; }
  }

  /* ====================================================================================
     BASE DUEL — art. Canvas painters shared by the map, the tool bar icons and the bestiary.
     Presentation only: they draw what they are handed and never touch the rules.
     ==================================================================================== */
  const ECOL = { walker: "#8FBF6A", runner: "#D8E36B", brute: "#B07CD8", spitter: "#4FD1B8" };
  const TCOL = { wall: "#A3A6B8", arrow: "#F2C14E", cannon: "#FFB35C", frost: "#6FC3FF", spike: "#C9C6DD", mine: "#E8D27A", bomb: "#FF6275" };
  const ZSKIN = {
    walker:  { skin: "#8FBF6A", cloth: "#4A5A3C", dark: "#1B2416", eye: "#FF5A4E", goo: "#4E7A2E" },
    runner:  { skin: "#D8E36B", cloth: "#6E6230", dark: "#26220F", eye: "#FF9A3C", goo: "#86892C" },
    brute:   { skin: "#B07CD8", cloth: "#4B2F68", dark: "#1C1230", eye: "#FF4F6E", goo: "#5D2F80" },
    spitter: { skin: "#4FD1B8", cloth: "#2B5A52", dark: "#0E2B26", eye: "#E8FF6A", goo: "#1F8C74" },
  };
  const ENEMY_DESC = {
    walker: "Steady and common. Light armour (−1 per hit).",
    runner: "Twice as fast, very fragile.",
    brute: "Slow, 110+ HP, armour −4 per hit, smashes through walls.",
    spitter: "Stops to spit at towers within 2.4 tiles (not walls).",
  };
  const ENEMY_TIP = {
    runner: "Runners are fast but fragile. Arrow towers and Spikes shred them.",
    brute: "Brutes shrug off arrows and smash walls. Bring Cannons and Frost.",
    spitter: "Spitters stop to melt towers from 2.4 tiles. Keep gold for Repair.",
  };
  const PI2 = Math.PI * 2;
  function hash2(a, b) { const s = Math.sin(a * 127.1 + b * 311.7) * 43758.5453; return s - Math.floor(s); }
  function rrect(g, x, y, w, h, r) {
    r = Math.max(0, Math.min(r, w / 2, h / 2));
    g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r);
    g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath();
  }
  function disc(g, x, y, r, fill) { g.beginPath(); g.arc(x, y, Math.max(0.1, r), 0, PI2); if (fill) { g.fillStyle = fill; g.fill(); } }
  function softGlow(g, x, y, r, col, a) {
    if (a <= 0 || r <= 0) return;
    const gr = g.createRadialGradient(x, y, 0, x, y, r);
    gr.addColorStop(0, col); gr.addColorStop(1, "rgba(0,0,0,0)");
    g.save(); g.globalAlpha *= Math.min(1, a); g.fillStyle = gr; g.beginPath(); g.arc(x, y, r, 0, PI2); g.fill(); g.restore();
  }
  function line(g, x0, y0, x1, y1) { g.beginPath(); g.moveTo(x0, y0); g.lineTo(x1, y1); g.stroke(); }

  /* Static ground: soil tiles, moss patches, speckles, grass, bones and the boulders. Painted once per canvas size. */
  function paintGround(g, map, w, h) {
    const ts = w / BW;
    for (let y = 0; y < BH; y++) for (let x = 0; x < BW; x++) {
      const n = hash2(x, y), m = hash2(x + 31, y * 7);
      g.fillStyle = `rgb(${(21 + n * 7) | 0},${(25 + n * 8 + m * 3) | 0},${(19 + n * 5) | 0})`;
      g.fillRect(x * ts, y * ts, ts + 0.5, ts + 0.5);
    }
    for (let k = 0; k < 20; k++) softGlow(g, hash2(k, 3) * w, hash2(k, 9) * h, ts * (0.7 + hash2(k, 5) * 1.3), k % 3 ? "#0A0C08" : "#34472A", 0.4);
    g.lineCap = "round";
    for (let y = 0; y < BH; y++) for (let x = 0; x < BW; x++) {
      if (map.grid[y * BW + x]) continue;
      const ox = x * ts, oy = y * ts;
      for (let k = 0; k < 6; k++) {
        disc(g, ox + hash2(x * 13 + k, y * 17) * ts, oy + hash2(x * 7, y * 29 + k) * ts, ts * (0.012 + 0.022 * hash2(k, x + y)),
          k % 2 ? "rgba(255,255,255,.04)" : "rgba(0,0,0,.25)");
      }
      if (hash2(x, y * 3) < 0.55) {
        const gx = ox + ts * (0.2 + 0.6 * hash2(y, x)), gy = oy + ts * (0.3 + 0.55 * hash2(x * 5, y));
        g.strokeStyle = "rgba(84,112,58,.6)"; g.lineWidth = Math.max(1, ts * 0.025);
        for (let k = -1; k <= 1; k++) line(g, gx + k * ts * 0.035, gy, gx + k * ts * 0.075, gy - ts * (k ? 0.08 : 0.12));
      }
      if (hash2(x * 3, y * 11) < 0.07) {
        const bx = ox + ts * (0.3 + 0.4 * hash2(x, 2)), by = oy + ts * (0.3 + 0.4 * hash2(3, y)), a = hash2(x, y) * 3;
        const dx = Math.cos(a) * ts * 0.09, dy = Math.sin(a) * ts * 0.09;
        g.strokeStyle = "rgba(214,204,182,.22)"; g.lineWidth = Math.max(1, ts * 0.03);
        line(g, bx - dx, by - dy, bx + dx, by + dy);
        for (const s of [-1, 1]) disc(g, bx + s * dx, by + s * dy, ts * 0.025, "rgba(214,204,182,.22)");
      }
    }
    g.strokeStyle = "rgba(255,255,255,.028)"; g.lineWidth = 1; g.beginPath();
    for (let x = 1; x < BW; x++) { g.moveTo(Math.round(x * ts) + 0.5, 0); g.lineTo(Math.round(x * ts) + 0.5, h); }
    for (let y = 1; y < BH; y++) { g.moveTo(0, Math.round(y * ts) + 0.5); g.lineTo(w, Math.round(y * ts) + 0.5); }
    g.stroke();
    for (let i = 0; i < BW * BH; i++) if (map.grid[i]) drawBoulder(g, i % BW, (i / BW) | 0, ts, i);
  }
  function drawBoulder(g, x, y, ts, i) {
    const cx = x * ts + ts / 2, cy = y * ts + ts / 2, r = ts * 0.44, pts = [];
    for (let k = 0; k < 9; k++) { const a = (k / 9) * PI2 + i, rr = r * (0.76 + 0.24 * Math.abs(Math.sin(i * 7 + k * 3))); pts.push([cx + Math.cos(a) * rr, cy + Math.sin(a) * rr * 0.88]); }
    const path = (dx, dy) => { g.beginPath(); pts.forEach((p, k) => (k ? g.lineTo(p[0] + dx, p[1] + dy) : g.moveTo(p[0] + dx, p[1] + dy))); g.closePath(); };
    g.fillStyle = "rgba(0,0,0,.5)"; path(ts * 0.05, ts * 0.08); g.fill();
    const gr = g.createLinearGradient(cx - r, cy - r, cx + r * 0.6, cy + r);
    gr.addColorStop(0, "#77737F"); gr.addColorStop(0.5, "#45424D"); gr.addColorStop(1, "#23212A");
    g.fillStyle = gr; path(0, 0); g.fill();
    g.strokeStyle = "#141318"; g.lineWidth = Math.max(1, ts * 0.03); g.stroke();
    g.strokeStyle = "rgba(255,255,255,.14)"; g.lineWidth = Math.max(1, ts * 0.025);
    g.beginPath(); g.moveTo(cx - r * 0.55, cy - r * 0.05); g.lineTo(cx - r * 0.15, cy - r * 0.4); g.lineTo(cx + r * 0.3, cy - r * 0.45); g.stroke();
    g.strokeStyle = "rgba(0,0,0,.45)";
    g.beginPath(); g.moveTo(cx + r * 0.05, cy - r * 0.1); g.lineTo(cx + r * 0.25, cy + r * 0.18); g.lineTo(cx + r * 0.15, cy + r * 0.45); g.stroke();
    for (let k = 0; k < 3; k++) disc(g, cx + (hash2(i, k) - 0.65) * r, cy + (hash2(k, i) - 0.1) * r * 0.7, ts * (0.03 + 0.03 * hash2(i + k, 2)), "rgba(96,134,64,.6)");
  }
  /* Worn dirt trails under the zombie routes, with marching dashes toward the core. */
  function paintPaths(g, paths, ts, t, strong) {
    const trace = (p) => { g.beginPath(); p.forEach((i, k) => { const x = (i % BW + 0.5) * ts, y = (((i / BW) | 0) + 0.5) * ts; if (k) g.lineTo(x, y); else g.moveTo(x, y); }); };
    g.save(); g.lineJoin = "round"; g.lineCap = "round";
    g.strokeStyle = "rgba(92,70,44,.34)"; g.lineWidth = ts * 0.6; for (const p of paths) { trace(p); g.stroke(); }
    g.strokeStyle = "rgba(132,104,68,.16)"; g.lineWidth = ts * 0.26; for (const p of paths) { trace(p); g.stroke(); }
    g.setLineDash([ts * 0.1, ts * 0.22]); g.lineDashOffset = -t * ts * 0.9;
    g.strokeStyle = strong ? "rgba(255,98,117,.72)" : "rgba(255,98,117,.28)"; g.lineWidth = Math.max(1.5, ts * 0.055);
    for (const p of paths) { trace(p); g.stroke(); }
    g.restore();
  }
  function tomb(g, x, y, w, h) {
    g.fillStyle = "rgba(0,0,0,.45)"; g.fillRect(x - w / 2 + 2, y + h / 2 - 2, w, 3);
    const gr = g.createLinearGradient(x - w / 2, y, x + w / 2, y); gr.addColorStop(0, "#7A7884"); gr.addColorStop(1, "#3E3C46");
    g.fillStyle = gr; g.beginPath(); g.moveTo(x - w / 2, y + h / 2); g.lineTo(x - w / 2, y - h / 2 + w / 2);
    g.arc(x, y - h / 2 + w / 2, w / 2, Math.PI, 0); g.lineTo(x + w / 2, y + h / 2); g.closePath(); g.fill();
    g.strokeStyle = "rgba(0,0,0,.55)"; g.lineWidth = Math.max(1, w * 0.1); g.stroke();
    line(g, x, y - h * 0.22, x, y + h * 0.18); line(g, x - w * 0.22, y - h * 0.08, x + w * 0.22, y - h * 0.08);
  }
  function drawSpawn(g, sp, ts, t, hot) {
    const cx = (sp.x + 0.5) * ts, cy = (sp.y + 0.5) * ts, pu = 0.5 + 0.5 * Math.sin(t * (hot ? 5 : 2.4) + sp.y * 1.7);
    const bx = sp.x === 0 ? -1 : 0, by = sp.x === 0 ? 0 : sp.y === 0 ? -1 : 1;
    softGlow(g, cx, cy, ts * (0.85 + 0.1 * pu), "#FF3B55", (hot ? 0.5 : 0.3) + 0.2 * pu);
    const px = cx - bx * ts * 0.05, py = cy - by * ts * 0.05;
    g.fillStyle = "#3A2A20"; g.beginPath(); g.ellipse(px, py, ts * 0.36, ts * 0.3, 0, 0, PI2); g.fill();
    g.fillStyle = "#060405"; g.beginPath(); g.ellipse(px, py, ts * 0.29, ts * 0.23, 0, 0, PI2); g.fill();
    g.strokeStyle = `rgba(255,98,117,${0.4 + 0.4 * pu})`; g.lineWidth = Math.max(1.5, ts * 0.04); g.stroke();
    softGlow(g, px, py, ts * 0.22, "#8CFF9E", 0.12 + 0.14 * pu);
    g.strokeStyle = "rgba(0,0,0,.5)"; g.lineWidth = Math.max(1, ts * 0.02);
    for (let k = 0; k < 5; k++) { const a = k * 1.3 + sp.y, r0 = ts * 0.34; line(g, px + Math.cos(a) * r0, py + Math.sin(a) * r0 * 0.8, px + Math.cos(a + 0.2) * ts * 0.47, py + Math.sin(a + 0.2) * ts * 0.4); }
    tomb(g, cx + bx * ts * 0.32 + (by ? ts * 0.22 : 0), cy + by * ts * 0.3 + (bx ? -ts * 0.24 : 0), ts * 0.22, ts * 0.28);
  }
  function drawCore(g, b, ts, t, hpFrac, hit) {
    const cx = (b.x + 0.5) * ts, cy = (b.y + 0.5) * ts, s = ts * 0.33;
    softGlow(g, cx, cy, ts * 1.15, "#F5C94A", 0.2 + 0.06 * Math.sin(t * 2));
    if (hit > 0) softGlow(g, cx, cy, ts * 1.1, "#FF3B55", hit);
    g.fillStyle = "rgba(0,0,0,.5)"; rrect(g, cx - s + ts * 0.05, cy - s + ts * 0.08, s * 2, s * 2, ts * 0.08); g.fill();
    const gr = g.createLinearGradient(cx - s, cy - s, cx + s, cy + s); gr.addColorStop(0, "#8A857A"); gr.addColorStop(1, "#3A3731");
    g.fillStyle = gr; rrect(g, cx - s, cy - s, s * 2, s * 2, ts * 0.07); g.fill();
    g.strokeStyle = "#16140F"; g.lineWidth = Math.max(1, ts * 0.03); g.stroke();
    g.fillStyle = "#26221C"; rrect(g, cx - s * 0.62, cy - s * 0.62, s * 1.24, s * 1.24, ts * 0.04); g.fill();
    for (const [dx, dy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      const tx = cx + dx * s * 0.92, ty = cy + dy * s * 0.92;
      disc(g, tx, ty, ts * 0.11, "#66615A"); g.strokeStyle = "#16140F"; g.stroke();
      disc(g, tx, ty, ts * 0.055, "#F5C94A");
    }
    const pu = 1 + 0.07 * Math.sin(t * 3), R = ts * 0.16 * pu;
    softGlow(g, cx, cy, ts * 0.3, "#FFE08A", 0.5);
    const cg = g.createLinearGradient(cx - R, cy - R, cx + R, cy + R); cg.addColorStop(0, "#FFF3C4"); cg.addColorStop(0.5, "#F5C94A"); cg.addColorStop(1, "#A17A18");
    g.fillStyle = cg; g.beginPath(); g.moveTo(cx, cy - R); g.lineTo(cx + R * 0.82, cy); g.lineTo(cx, cy + R); g.lineTo(cx - R * 0.82, cy); g.closePath(); g.fill();
    g.strokeStyle = "rgba(60,40,5,.7)"; g.lineWidth = 1; g.stroke();
    // banner on the north-east turret
    const fx = cx + s * 0.92, fy = cy - s * 0.92, wv = Math.sin(t * 6) * ts * 0.025;
    g.strokeStyle = "#D8D2C4"; g.lineWidth = Math.max(1, ts * 0.025); line(g, fx, fy, fx, fy - ts * 0.34);
    g.fillStyle = "#F5C94A"; g.beginPath(); g.moveTo(fx, fy - ts * 0.34); g.quadraticCurveTo(fx + ts * 0.12, fy - ts * 0.33 + wv, fx + ts * 0.22, fy - ts * 0.3 + wv);
    g.lineTo(fx, fy - ts * 0.22); g.closePath(); g.fill();
    // HP ring
    g.lineCap = "round"; g.lineWidth = Math.max(3, ts * 0.065);
    g.strokeStyle = "rgba(255,255,255,.1)"; g.beginPath(); g.arc(cx, cy, ts * 0.52, 0, PI2); g.stroke();
    if (hpFrac > 0) {
      g.strokeStyle = hpFrac > 0.5 ? "#5AD690" : hpFrac > 0.25 ? "#FFB35C" : "#FF6275";
      g.beginPath(); g.arc(cx, cy, ts * 0.52, -Math.PI / 2, -Math.PI / 2 + PI2 * hpFrac); g.stroke();
    }
    g.lineCap = "butt";
  }
  function plinth(g, cx, cy, ts, col) {
    const w = ts * 0.8, r = ts * 0.16;
    g.fillStyle = "rgba(0,0,0,.5)"; rrect(g, cx - w / 2 + ts * 0.04, cy - w / 2 + ts * 0.07, w, w, r); g.fill();
    const gr = g.createLinearGradient(cx - w / 2, cy - w / 2, cx + w / 2, cy + w / 2);
    gr.addColorStop(0, "#4B4C57"); gr.addColorStop(1, "#1B1C21");
    g.fillStyle = gr; rrect(g, cx - w / 2, cy - w / 2, w, w, r); g.fill();
    g.strokeStyle = "rgba(0,0,0,.65)"; g.lineWidth = Math.max(1, ts * 0.025); g.stroke();
    g.save(); g.globalAlpha *= 0.85; g.strokeStyle = col; g.lineWidth = Math.max(1, ts * 0.035);
    rrect(g, cx - w / 2 + ts * 0.065, cy - w / 2 + ts * 0.065, w - ts * 0.13, w - ts * 0.13, r * 0.6); g.stroke(); g.restore();
    for (const [dx, dy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) disc(g, cx + dx * w * 0.36, cy + dy * w * 0.36, Math.max(0.8, ts * 0.022), "rgba(255,255,255,.22)");
  }
  function hexPath(g, cx, cy, r) { g.beginPath(); for (let k = 0; k < 6; k++) { const a = k * Math.PI / 3 + Math.PI / 6; g.lineTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r); } g.closePath(); }
  function nugget(g, x, y, r, k) {
    const gr = g.createLinearGradient(x - r, y - r, x + r, y + r); gr.addColorStop(0, "#FFF0B0"); gr.addColorStop(0.5, "#F5C94A"); gr.addColorStop(1, "#9B7417");
    g.fillStyle = gr; g.beginPath();
    for (let j = 0; j < 7; j++) { const a = j / 7 * PI2, rr = r * (0.75 + 0.25 * hash2(k, j)); g.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr * 0.85); }
    g.closePath(); g.fill(); g.strokeStyle = "rgba(70,48,6,.8)"; g.lineWidth = 1; g.stroke();
  }
  function sparkle(g, x, y, r, a) {
    if (a <= 0) return;
    g.save(); g.globalAlpha *= a; g.fillStyle = "#FFF6D0";
    g.beginPath(); g.moveTo(x, y - r); g.lineTo(x + r * 0.22, y - r * 0.22); g.lineTo(x + r, y); g.lineTo(x + r * 0.22, y + r * 0.22);
    g.lineTo(x, y + r); g.lineTo(x - r * 0.22, y + r * 0.22); g.lineTo(x - r, y); g.lineTo(x - r * 0.22, y - r * 0.22); g.closePath(); g.fill(); g.restore();
  }
  function wallArt(g, x, y, ts, nb, hpFrac) {
    const e = ts * 0.08, has = (dx, dy) => !!(nb && nb(dx, dy));
    const L = has(-1, 0), R = has(1, 0), U = has(0, -1), D = has(0, 1);
    const x0 = x * ts + (L ? 0 : e), x1 = (x + 1) * ts - (R ? 0 : e), y0 = y * ts + (U ? 0 : e), y1 = (y + 1) * ts - (D ? 0 : e);
    const lip = D ? 0 : ts * 0.12;
    g.fillStyle = "rgba(0,0,0,.45)"; g.fillRect(x0 + ts * 0.04, y0 + ts * 0.08, x1 - x0, y1 - y0);
    g.fillStyle = "#34363F"; g.fillRect(x0, y0, x1 - x0, y1 - y0);
    const top = g.createLinearGradient(x0, y0, x1, y1); top.addColorStop(0, "#7F8294"); top.addColorStop(1, "#4F5261");
    g.fillStyle = top; g.fillRect(x0, y0, x1 - x0, y1 - y0 - lip);
    g.strokeStyle = "rgba(18,18,24,.55)"; g.lineWidth = 1;
    const yt = y1 - lip;
    for (let r = 0; r < 3; r++) {
      const ya = y * ts + (r * ts) / 3, yb = y * ts + ((r + 1) * ts) / 3;
      if (r > 0 && ya > y0 + 1 && ya < yt - 1) line(g, x0, ya, x1, ya);
      for (const f of r % 2 ? [0.5] : [0.25, 0.75]) {
        const xx = x * ts + f * ts;
        if (xx > x0 + 1 && xx < x1 - 1) line(g, xx, Math.max(ya, y0), xx, Math.min(yb, yt));
      }
    }
    g.fillStyle = "rgba(255,255,255,.12)";
    if (!U) g.fillRect(x0, y0, x1 - x0, Math.max(1, ts * 0.03));
    if (!L) g.fillRect(x0, y0, Math.max(1, ts * 0.03), yt - y0);
    if (hpFrac < 0.6) {
      g.strokeStyle = "rgba(8,8,10,.85)"; g.lineWidth = Math.max(1, ts * 0.03);
      const cx = x * ts + ts * 0.5, cy = y * ts + ts * 0.45;
      g.beginPath(); g.moveTo(cx - ts * 0.3, cy - ts * 0.2); g.lineTo(cx - ts * 0.08, cy); g.lineTo(cx - ts * 0.14, cy + ts * 0.14); g.lineTo(cx + ts * 0.12, cy + ts * 0.3); g.stroke();
      if (hpFrac < 0.3) { g.beginPath(); g.moveTo(cx + ts * 0.3, cy - ts * 0.3); g.lineTo(cx + ts * 0.1, cy - ts * 0.08); g.lineTo(cx + ts * 0.2, cy + ts * 0.05); g.stroke(); }
    }
  }
  /* o: { s (live structure), t (seconds, animation clock), since (seconds since its last shot), nb (wall neighbour fn), hpFrac, alpha } */
  function drawTowerArt(g, type, x, y, ts, o) {
    o = o || {};
    const cx = (x + 0.5) * ts, cy = (y + 0.5) * ts, col = TCOL[type], s = o.s, t = o.t || 0;
    const aim = s && s.aim != null ? s.aim : Math.PI, since = o.since == null ? 9 : o.since, hpFrac = o.hpFrac == null ? 1 : o.hpFrac;
    g.save(); g.globalAlpha = o.alpha == null ? 1 : o.alpha;
    if (s && s.flash > 0) g.globalAlpha *= 0.65;
    g.lineCap = "round"; g.lineJoin = "round";
    if (type === "wall") wallArt(g, x, y, ts, o.nb, hpFrac);
    else if (type === "spike") {
      const w = ts * 0.84;
      g.fillStyle = "rgba(0,0,0,.35)"; rrect(g, cx - w / 2 + ts * 0.03, cy - w / 2 + ts * 0.05, w, w, ts * 0.1); g.fill();
      const pg = g.createLinearGradient(cx - w / 2, cy - w / 2, cx + w / 2, cy + w / 2); pg.addColorStop(0, "#4D4F59"); pg.addColorStop(1, "#23242A");
      g.fillStyle = pg; rrect(g, cx - w / 2, cy - w / 2, w, w, ts * 0.1); g.fill();
      g.strokeStyle = "#101114"; g.lineWidth = Math.max(1, ts * 0.025); g.stroke();
      if (s && s.kills) softGlow(g, cx, cy, ts * 0.42, "#6B1A12", Math.min(0.7, 0.15 + s.kills * 0.04));
      for (let i = 0; i < 9; i++) {
        const px = cx + ((i % 3) - 1) * ts * 0.24, py = cy + (((i / 3) | 0) - 1) * ts * 0.24, r = ts * 0.085;
        disc(g, px + r * 0.25, py + r * 0.35, r, "rgba(0,0,0,.45)");
        const cg = g.createRadialGradient(px - r * 0.35, py - r * 0.35, 0, px, py, r);
        cg.addColorStop(0, "#FAF8FF"); cg.addColorStop(0.45, "#A5A3B4"); cg.addColorStop(1, "#34353D");
        disc(g, px, py, r, cg);
      }
      for (const [dx, dy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) disc(g, cx + dx * w * 0.42, cy + dy * w * 0.42, Math.max(0.8, ts * 0.02), "rgba(255,255,255,.3)");
    } else {
      plinth(g, cx, cy, ts, col);
      if (type === "arrow") {
        disc(g, cx, cy, ts * 0.27, "#5E4024"); g.strokeStyle = "#24170C"; g.lineWidth = Math.max(1, ts * 0.025); g.stroke();
        g.strokeStyle = "rgba(0,0,0,.3)"; g.lineWidth = 1;
        for (const k of [-1, 1]) { const dy = k * ts * 0.09, hw = Math.sqrt(Math.max(0, (ts * 0.27) ** 2 - dy * dy)); line(g, cx - hw, cy + dy, cx + hw, cy + dy); }
        g.save(); g.translate(cx, cy); g.rotate(aim);
        const loaded = since > 0.14, nock = loaded ? -ts * 0.07 : ts * 0.12;
        g.fillStyle = "#A06E38"; rrect(g, -ts * 0.2, -ts * 0.045, ts * 0.44, ts * 0.09, ts * 0.03); g.fill();
        g.strokeStyle = "#3A2410"; g.lineWidth = 1; g.stroke();
        g.strokeStyle = col; g.lineWidth = Math.max(1.5, ts * 0.055);
        g.beginPath(); g.arc(ts * 0.02, 0, ts * 0.22, -1.05, 1.05); g.stroke();
        const ex = ts * 0.02 + Math.cos(1.05) * ts * 0.22, ey = Math.sin(1.05) * ts * 0.22;
        g.strokeStyle = "rgba(240,235,220,.85)"; g.lineWidth = 1;
        g.beginPath(); g.moveTo(ex, -ey); g.lineTo(nock, 0); g.lineTo(ex, ey); g.stroke();
        if (loaded) {
          g.strokeStyle = "#EFE8D2"; g.lineWidth = Math.max(1, ts * 0.03); line(g, nock, 0, ts * 0.32, 0);
          g.fillStyle = col; g.beginPath(); g.moveTo(ts * 0.38, 0); g.lineTo(ts * 0.3, -ts * 0.04); g.lineTo(ts * 0.3, ts * 0.04); g.closePath(); g.fill();
        }
        g.restore();
      } else if (type === "cannon") {
        const rec = since < 0.25 ? (1 - since / 0.25) * ts * 0.08 : 0;
        const tg = g.createRadialGradient(cx - ts * 0.08, cy - ts * 0.08, ts * 0.02, cx, cy, ts * 0.28);
        tg.addColorStop(0, "#71737F"); tg.addColorStop(1, "#212229");
        disc(g, cx, cy, ts * 0.27, tg); g.strokeStyle = "#0E0E12"; g.lineWidth = Math.max(1, ts * 0.03); g.stroke();
        g.save(); g.translate(cx, cy); g.rotate(aim); g.translate(-rec, 0);
        g.fillStyle = "rgba(0,0,0,.35)"; rrect(g, -ts * 0.03, -ts * 0.06, ts * 0.43, ts * 0.17, ts * 0.04); g.fill();
        const bg = g.createLinearGradient(0, -ts * 0.085, 0, ts * 0.085); bg.addColorStop(0, "#5A5C68"); bg.addColorStop(0.45, "#26272E"); bg.addColorStop(1, "#131418");
        g.fillStyle = bg; rrect(g, -ts * 0.05, -ts * 0.085, ts * 0.43, ts * 0.17, ts * 0.04); g.fill();
        g.strokeStyle = "#0B0B0E"; g.lineWidth = 1; g.stroke();
        g.fillStyle = col; g.fillRect(ts * 0.31, -ts * 0.1, ts * 0.06, ts * 0.2); g.fillRect(ts * 0.1, -ts * 0.09, ts * 0.035, ts * 0.18);
        disc(g, ts * 0.38, 0, ts * 0.045, "#050506");
        if (since < 0.1) softGlow(g, ts * 0.46, 0, ts * 0.24, "#FFD27A", 1 - since / 0.1);
        g.restore();
        disc(g, cx, cy, ts * 0.1, "#393A44"); g.strokeStyle = col; g.lineWidth = Math.max(1, ts * 0.03); g.stroke();
      } else if (type === "frost") {
        const pu = 0.5 + 0.5 * Math.sin(t * 2.2 + x + y);
        softGlow(g, cx, cy, ts * 0.44, "#6FC3FF", 0.35 + 0.3 * pu);
        hexPath(g, cx, cy, ts * 0.27); g.fillStyle = "#1A3042"; g.fill();
        g.strokeStyle = "rgba(170,225,255,.55)"; g.lineWidth = Math.max(1, ts * 0.025); g.stroke();
        g.save(); g.translate(cx, cy); g.rotate(Math.sin(t * 0.7 + x) * 0.2);
        const shard = (ang, len, wid) => {
          g.save(); g.rotate(ang);
          const cg = g.createLinearGradient(0, -len, 0, len * 0.2); cg.addColorStop(0, "#F4FCFF"); cg.addColorStop(1, "#3C9BE6");
          g.fillStyle = cg; g.beginPath(); g.moveTo(0, -len); g.lineTo(wid, -len * 0.25); g.lineTo(0, len * 0.15); g.lineTo(-wid, -len * 0.25); g.closePath(); g.fill();
          g.strokeStyle = "rgba(255,255,255,.6)"; g.lineWidth = 0.8; line(g, 0, -len, 0, len * 0.1); g.restore();
        };
        shard(Math.PI, ts * 0.14, ts * 0.045); shard(-2.1, ts * 0.17, ts * 0.05); shard(2.1, ts * 0.17, ts * 0.05); shard(0, ts * 0.26, ts * 0.075);
        g.restore();
      } else if (type === "mine") {
        g.fillStyle = "#080605"; rrect(g, cx - ts * 0.19, cy - ts * 0.19, ts * 0.38, ts * 0.38, ts * 0.05); g.fill();
        g.strokeStyle = "#8C5E32"; g.lineWidth = Math.max(1.5, ts * 0.055); rrect(g, cx - ts * 0.19, cy - ts * 0.19, ts * 0.38, ts * 0.38, ts * 0.05); g.stroke();
        g.strokeStyle = "#6A4526"; g.lineWidth = Math.max(1, ts * 0.035); line(g, cx - ts * 0.19, cy - ts * 0.05, cx + ts * 0.19, cy - ts * 0.05);
        nugget(g, cx + ts * 0.07, cy + ts * 0.09, ts * 0.085, 1); nugget(g, cx - ts * 0.08, cy + ts * 0.12, ts * 0.06, 2); nugget(g, cx + ts * 0.15, cy - ts * 0.03, ts * 0.05, 3);
        g.strokeStyle = "#A06E38"; g.lineWidth = Math.max(1, ts * 0.035); line(g, cx - ts * 0.2, cy + ts * 0.02, cx - ts * 0.02, cy - ts * 0.2);
        g.strokeStyle = "#C9C6D4"; g.lineWidth = Math.max(1, ts * 0.04);
        g.beginPath(); g.moveTo(cx - ts * 0.14, cy - ts * 0.25); g.quadraticCurveTo(cx + ts * 0.02, cy - ts * 0.22, cx + ts * 0.05, cy - ts * 0.08); g.stroke();
        const k = (t * 0.9 + x * 0.37 + y * 0.61) % 1.4;
        if (k < 0.5) sparkle(g, cx + ts * 0.1, cy + ts * 0.05, ts * 0.09, Math.sin((k / 0.5) * Math.PI));
      }
      if (hpFrac < 0.5) {
        g.strokeStyle = "rgba(8,8,10,.8)"; g.lineWidth = Math.max(1, ts * 0.025);
        g.beginPath(); g.moveTo(cx - ts * 0.36, cy - ts * 0.18); g.lineTo(cx - ts * 0.24, cy - ts * 0.08); g.lineTo(cx - ts * 0.3, cy + ts * 0.06); g.stroke();
      }
    }
    g.restore();
  }
  /* Top-down zombie facing `ang`. o: { phase, flash, slow, still, alpha } */
  function drawZombie(g, type, cx, cy, ts, ang, t, o) {
    o = o || {};
    const K = ZSKIN[type], r = ENEMIES[type].r * ts * 1.35;
    g.save(); g.translate(cx, cy);
    if (o.alpha != null) g.globalAlpha *= o.alpha;
    g.fillStyle = "rgba(0,0,0,.38)"; g.beginPath(); g.ellipse(r * 0.12, r * 0.32, r * 1.05, r * 0.75, 0, 0, PI2); g.fill();
    g.rotate(ang);
    const sw = o.still ? 0 : Math.sin(t * (type === "runner" ? 18 : type === "brute" ? 6 : 9) + (o.phase || 0));
    g.lineCap = "round"; g.lineJoin = "round";
    if (type === "runner" && !o.still) {
      g.strokeStyle = "rgba(216,227,107,.22)"; g.lineWidth = Math.max(1, r * 0.14);
      for (const k of [-0.45, 0, 0.45]) line(g, -r * 1.05, k * r, -r * (1.7 + 0.2 * Math.abs(sw)), k * r);
    }
    // feet shuffle
    g.fillStyle = K.dark;
    disc(g, -r * 0.15 + sw * r * 0.22, -r * 0.34, r * 0.2); g.fill();
    disc(g, -r * 0.15 - sw * r * 0.22, r * 0.34, r * 0.2); g.fill();
    if (type === "spitter") {
      const pu = 0.5 + 0.5 * Math.sin(t * 4 + (o.phase || 0));
      softGlow(g, -r * 0.55, 0, r * 1.1, "#7CFFD9", 0.25 + 0.2 * pu);
      const sg = g.createRadialGradient(-r * 0.7, -r * 0.2, 0, -r * 0.55, 0, r * 0.7);
      sg.addColorStop(0, "#D2FFF2"); sg.addColorStop(0.45, K.skin); sg.addColorStop(1, K.goo);
      disc(g, -r * 0.55, 0, r * (0.62 + 0.04 * pu), sg); g.strokeStyle = K.dark; g.lineWidth = Math.max(1, r * 0.08); g.stroke();
    }
    // arms reach forward
    const lw = r * (type === "brute" ? 0.4 : 0.27), reach = r * (type === "runner" ? 0.95 : 1.1);
    const arms = [[-1, reach], [1, reach * (type === "spitter" ? 0.7 : 1)]];
    for (const pass of [0, 1]) {
      g.strokeStyle = pass ? K.skin : K.dark; g.lineWidth = pass ? lw : lw + Math.max(1.2, r * 0.14);
      for (const [s, L] of arms) line(g, r * 0.05, s * r * 0.56, r * 0.05 + L, s * (r * 0.46 - sw * r * 0.18));
    }
    if (type === "brute") {
      g.strokeStyle = "#EDE3CC"; g.lineWidth = Math.max(1, r * 0.08);
      for (const [s, L] of arms) { const hx = r * 0.05 + L, hy = s * (r * 0.46 - sw * r * 0.18); for (const d of [-1, 0, 1]) line(g, hx, hy + d * r * 0.1, hx + r * 0.16, hy + d * r * 0.13); }
    }
    // torso
    const bg = g.createLinearGradient(-r * 0.6, -r, r * 0.4, r); bg.addColorStop(0, K.cloth); bg.addColorStop(1, K.dark);
    g.fillStyle = bg; g.beginPath(); g.ellipse(-r * 0.05, 0, r * 0.6, r * (type === "brute" ? 1.0 : 0.86), 0, 0, PI2); g.fill();
    g.strokeStyle = K.dark; g.lineWidth = Math.max(1, r * 0.1); g.stroke();
    g.save(); g.globalAlpha *= 0.75; disc(g, -r * 0.22, r * 0.36, r * 0.13, K.skin); disc(g, r * 0.1, -r * 0.45, r * 0.09, K.skin); g.restore();
    if (type === "brute") {
      g.fillStyle = "#EDE3CC";
      for (const s of [-1, 1]) { g.beginPath(); g.moveTo(-r * 0.25, s * r * 0.8); g.lineTo(-r * 0.02, s * r * 1.28); g.lineTo(r * 0.14, s * r * 0.8); g.closePath(); g.fill(); }
    }
    // head
    const hx = r * (type === "runner" ? 0.42 : 0.3), hr = r * (type === "brute" ? 0.46 : 0.42);
    disc(g, hx, 0, hr, K.skin); g.strokeStyle = K.dark; g.lineWidth = Math.max(1, r * 0.1); g.stroke();
    const hg = g.createRadialGradient(hx - hr * 0.3, -hr * 0.35, 0, hx, 0, hr);
    hg.addColorStop(0, "rgba(255,255,255,.28)"); hg.addColorStop(1, "rgba(0,0,0,.28)");
    disc(g, hx, 0, hr, hg);
    if (type === "walker") { g.strokeStyle = "rgba(0,0,0,.35)"; g.lineWidth = Math.max(1, r * 0.06); line(g, hx - hr * 0.5, -hr * 0.1, hx - hr * 0.1, hr * 0.3); }
    for (const s of [-1, 1]) {
      const ex = hx + hr * 0.52, ey = s * hr * 0.4;
      softGlow(g, ex, ey, hr * 0.55, K.eye, 0.55);
      disc(g, ex, ey, Math.max(0.8, hr * 0.17), K.eye);
    }
    if (type === "spitter") disc(g, hx + hr * 0.95, 0, hr * 0.2, "#C8FFEE");
    if (o.flash > 0) {
      g.globalAlpha = Math.min(1, o.flash * 8) * 0.75 * (o.alpha == null ? 1 : o.alpha);
      g.fillStyle = "#FFFFFF"; g.beginPath(); g.ellipse(-r * 0.05, 0, r * 0.6, r * 0.9, 0, 0, PI2); g.fill(); disc(g, hx, 0, hr, "#FFFFFF");
    }
    g.restore();
    if (o.slow) {
      g.save(); g.strokeStyle = "rgba(150,215,255,.85)"; g.lineWidth = Math.max(1, ts * 0.025);
      g.beginPath(); g.arc(cx, cy, r * 1.25, 0, PI2); g.stroke();
      for (let k = 0; k < 3; k++) {
        const a = t * 1.5 + k * 2.1, px = cx + Math.cos(a) * r * 1.25, py = cy + Math.sin(a) * r * 1.25, q = Math.max(1.5, ts * 0.04);
        g.fillStyle = "#DDF3FF"; g.beginPath(); g.moveTo(px, py - q); g.lineTo(px + q * 0.6, py); g.lineTo(px, py + q); g.lineTo(px - q * 0.6, py); g.closePath(); g.fill();
      }
      g.restore();
    }
  }
  function drawActionIcon(g, kind, S) {
    const c = S / 2;
    g.lineCap = "round"; g.lineJoin = "round";
    if (kind === "sell") {
      const cg = g.createLinearGradient(c - S * 0.3, c - S * 0.3, c + S * 0.3, c + S * 0.3); cg.addColorStop(0, "#FFF0B0"); cg.addColorStop(1, "#A77E1A");
      disc(g, c, c + S * 0.05, S * 0.3, cg); g.strokeStyle = "#5A420C"; g.lineWidth = S * 0.04; g.stroke();
      g.strokeStyle = "#6A4E0E"; g.lineWidth = S * 0.07; line(g, c, c - S * 0.08, c, c + S * 0.2); line(g, c - S * 0.1, c + S * 0.02, c, c - S * 0.08); line(g, c + S * 0.1, c + S * 0.02, c, c - S * 0.08);
    } else if (kind === "repair") {
      g.save(); g.translate(c, c); g.rotate(-0.8);
      g.fillStyle = "#A06E38"; rrect(g, -S * 0.05, -S * 0.05, S * 0.1, S * 0.42, S * 0.03); g.fill();
      g.fillStyle = "#C9C6D4"; rrect(g, -S * 0.2, -S * 0.2, S * 0.4, S * 0.16, S * 0.03); g.fill();
      g.strokeStyle = "#3E3C46"; g.lineWidth = S * 0.03; g.stroke();
      g.restore();
      g.strokeStyle = "#5AD690"; g.lineWidth = S * 0.06; line(g, S * 0.72, S * 0.18, S * 0.72, S * 0.38); line(g, S * 0.62, S * 0.28, S * 0.82, S * 0.28);
    } else if (kind === "bomb") {
      softGlow(g, c, c - S * 0.2, S * 0.3, "#FFB35C", 0.8);
      const bg = g.createRadialGradient(c - S * 0.1, c, 0, c, c + S * 0.1, S * 0.28); bg.addColorStop(0, "#6A6C78"); bg.addColorStop(1, "#15161A");
      disc(g, c, c + S * 0.1, S * 0.26, bg);
      g.fillStyle = "#3A3B44"; g.fillRect(c - S * 0.08, c - S * 0.2, S * 0.16, S * 0.1);
      g.fillStyle = "#FF8A3C"; g.beginPath(); g.moveTo(c, c - S * 0.44); g.quadraticCurveTo(c + S * 0.14, c - S * 0.28, c, c - S * 0.2); g.quadraticCurveTo(c - S * 0.14, c - S * 0.28, c, c - S * 0.44); g.fill();
      g.fillStyle = "#FFE08A"; disc(g, c, c - S * 0.27, S * 0.045); g.fill();
    }
  }
  /* Small data-URL sprites for the DOM (tool bar, inspector, bestiary). Cached for the page's lifetime. */
  const ICONS = {};
  function spriteURL(key, size, paint) {
    if (ICONS[key]) return ICONS[key];
    try {
      const c = document.createElement("canvas"), k = 3;
      c.width = c.height = size * k;
      const g = c.getContext("2d"); g.scale(k, k); paint(g, size);
      ICONS[key] = c.toDataURL("image/png");
    } catch (e) { ICONS[key] = ""; }
    return ICONS[key];
  }
  const towerIcon = (t) => (t === "sell" || t === "repair" || t === "bomb")
    ? spriteURL("act-" + t, 32, (g, S) => drawActionIcon(g, t, S))
    : spriteURL("tw-" + t, 32, (g, S) => drawTowerArt(g, t, 0, 0, S, { t: 0.2, s: t === "arrow" || t === "cannon" ? { aim: -Math.PI / 4 } : null }));
  const zombieIcon = (k) => spriteURL("zb-" + k, 40, (g, S) => {
    const bg = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S * 0.6); bg.addColorStop(0, "#2A3324"); bg.addColorStop(1, "#141712");
    g.fillStyle = bg; g.fillRect(0, 0, S, S);
    drawZombie(g, k, S * 0.44, S * 0.5, S * (k === "brute" ? 0.78 : 0.95), -0.35, 0.3, { still: true });
  });

  /* Tiny synthesized sound effects (WebAudio). Off until the first tap inside the game, so nothing plays uninvited. */
  const SFX = (function () {
    let ac = null, master = null, noiseBuf = null, on = true, armed = false;
    try { on = localStorage.getItem("dg.base.sfx") !== "0"; } catch (e) { /* storage blocked: keep default */ }
    const last = {};
    const GAP = { arrow: 70, die: 45, cannon: 90, hit: 140, place: 40, crash: 150, bomb: 120, wave: 600, held: 600, end: 900, err: 160, sell: 60 };
    function ready() {
      if (!on || !armed) return false;
      try {
        if (!ac) {
          const A = window.AudioContext || window.webkitAudioContext;
          if (!A) return false;
          ac = new A(); master = ac.createGain(); master.gain.value = 0.45; master.connect(ac.destination);
          noiseBuf = ac.createBuffer(1, Math.floor(ac.sampleRate * 0.7), ac.sampleRate);
          const d = noiseBuf.getChannelData(0); let s = 7;
          for (let i = 0; i < d.length; i++) { s = (s * 16807) % 2147483647; d[i] = s / 1073741823.5 - 1; }
        }
        if (ac.state === "suspended" && ac.resume) ac.resume().catch(() => {});
        return true;
      } catch (e) { return false; }
    }
    function tone(type, f0, f1, dur, vol, at) {
      const t = ac.currentTime + (at || 0), o = ac.createOscillator(), gn = ac.createGain();
      o.type = type; o.frequency.setValueAtTime(f0, t); o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
      gn.gain.setValueAtTime(0.0001, t); gn.gain.exponentialRampToValueAtTime(vol, t + 0.012); gn.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(gn); gn.connect(master); o.start(t); o.stop(t + dur + 0.03);
    }
    function noise(dur, vol, f0, f1, at) {
      const t = ac.currentTime + (at || 0), src = ac.createBufferSource(), fl = ac.createBiquadFilter(), gn = ac.createGain();
      src.buffer = noiseBuf; fl.type = "lowpass"; fl.frequency.setValueAtTime(f0, t); fl.frequency.exponentialRampToValueAtTime(Math.max(40, f1), t + dur);
      gn.gain.setValueAtTime(vol, t); gn.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      src.connect(fl); fl.connect(gn); gn.connect(master); src.start(t); src.stop(t + dur + 0.03);
    }
    function play(k) {
      if (!on || !armed) return;
      const now = performance.now();
      if (last[k] && now - last[k] < (GAP[k] || 50)) return;
      last[k] = now;
      if (!ready()) return;
      try {
        switch (k) {
          case "arrow": noise(0.05, 0.07, 5000, 1800); break;
          case "cannon": tone("sine", 150, 42, 0.28, 0.25); noise(0.22, 0.12, 1400, 140); break;
          case "die": tone("sawtooth", 210, 70, 0.15, 0.03); noise(0.09, 0.05, 900, 250); break;
          case "hit": tone("square", 95, 55, 0.3, 0.08); noise(0.2, 0.12, 700, 90); break;
          case "crash": noise(0.35, 0.16, 2200, 120); tone("triangle", 120, 50, 0.25, 0.08); break;
          case "bomb": noise(0.6, 0.3, 2600, 80); tone("sine", 90, 30, 0.5, 0.25); break;
          case "place": tone("triangle", 520, 360, 0.08, 0.06); noise(0.05, 0.05, 1500, 400); break;
          case "sell": tone("triangle", 880, 1320, 0.09, 0.05); tone("triangle", 1320, 1760, 0.09, 0.04, 0.07); break;
          case "err": tone("square", 160, 120, 0.12, 0.035); break;
          case "wave": tone("sawtooth", 98, 92, 0.75, 0.06); tone("sawtooth", 147, 139, 0.75, 0.035); noise(0.7, 0.04, 400, 200); break;
          case "held": [523, 659, 784].forEach((f, i) => tone("triangle", f, f, 0.22, 0.06, i * 0.09)); break;
          case "end": [784, 659, 523, 392].forEach((f, i) => tone("triangle", f, f * 0.98, 0.28, 0.06, i * 0.12)); break;
        }
      } catch (e) { /* audio is best-effort */ }
    }
    return {
      play,
      arm() { armed = true; },
      get on() { return on; },
      set(v) { on = !!v; try { localStorage.setItem("dg.base.sfx", on ? "1" : "0"); } catch (e) { /* ignore */ } if (on) ready(); },
    };
  })();

  /* ====================================================================================
     BASE DUEL — play
     ==================================================================================== */
  const HUD_ICON = {
    wave: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 14V2.5M3.5 3h8.5l-2 3 2 3H3.5"/></svg>',
    hp: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 13.6S2.4 10.3 2.4 6.4A2.9 2.9 0 0 1 8 4.9a2.9 2.9 0 0 1 5.6 1.5c0 3.9-5.6 7.2-5.6 7.2z"/></svg>',
    gold: '<svg viewBox="0 0 16 16" aria-hidden="true"><ellipse cx="8" cy="5" rx="5" ry="2.2"/><path d="M3 5v3c0 1.2 2.2 2.2 5 2.2s5-1 5-2.2V5M3 8v3c0 1.2 2.2 2.2 5 2.2s5-1 5-2.2V8"/></svg>',
    kills: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2.2c-3 0-5.2 2.1-5.2 4.8 0 1.6.8 2.8 2 3.4v2.4h6.4v-2.4c1.2-.6 2-1.8 2-3.4 0-2.7-2.2-4.8-5.2-4.8z"/><path d="M6.6 12.8v-1.4M9.4 12.8v-1.4"/><circle cx="6" cy="7.4" r=".9"/><circle cx="10" cy="7.4" r=".9"/></svg>',
    score: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2.2l1.8 3.7 4.1.6-3 2.9.7 4.1L8 11.6l-3.6 1.9.7-4.1-3-2.9 4.1-.6z"/></svg>',
    sndOn: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3 8h3l4-3.5v11L6 12H3z"/><path d="M13 7.2a4 4 0 0 1 0 5.6M15.3 5a7 7 0 0 1 0 10"/></svg>',
    sndOff: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3 8h3l4-3.5v11L6 12H3z"/><path d="M13.5 8l4 4M17.5 8l-4 4"/></svg>',
  };
  function basePlay(ctx) {
    const P = "g-base";
    DG.css("base", packCss(P) + `
      .g-base-map{position:relative;border-radius:var(--r-md)}
      .g-base-map canvas{cursor:crosshair;border-radius:var(--r-md);box-shadow:0 0 0 1px var(--line),0 18px 40px -18px rgba(0,0,0,.9)}
      .g-base .g-base-hud{grid-template-columns:repeat(5,minmax(0,1fr));gap:4px}
      .g-base .g-base-stat{padding:5px 7px 6px;position:relative;overflow:hidden;transition:border-color .3s}
      .g-base .g-base-stat span{font-size:9px;letter-spacing:.08em;display:flex;align-items:center;gap:4px}
      .g-base .g-base-stat span svg{flex:none;width:11px;height:11px;fill:none;stroke:currentColor;stroke-width:1.6;stroke-linecap:round;stroke-linejoin:round}
      .g-base .g-base-stat b{font-size:15px}
      .g-base-stat[data-k=hp] span svg{color:var(--bad)} .g-base-stat[data-k=gold] span svg{color:var(--gold)}
      .g-base-stat[data-k=kills] span svg{color:#8FBF6A} .g-base-stat[data-k=wave] span svg{color:#FF8A9A}
      .g-base-hpb{position:absolute;left:0;right:0;bottom:0;height:3px;background:rgba(255,255,255,.06)}
      .g-base-hpb em{display:block;height:100%;width:100%;background:var(--good);transition:width .3s,background-color .3s}
      .g-base-stat.hurt{border-color:var(--bad);animation:gbHurt .5s}
      .g-base-stat.gain b{animation:gbGain .45s}
      @keyframes gbHurt{0%{background:color-mix(in srgb,var(--bad) 28%,var(--panel))}100%{background:var(--panel)}}
      @keyframes gbGain{0%{transform:scale(1.14)}100%{transform:none}}
      .g-base-tb{display:grid;grid-template-columns:repeat(auto-fill,minmax(58px,1fr));gap:4px}
      .g-base-tbb{position:relative;display:grid;align-content:center;justify-items:center;gap:1px;min-height:56px;padding:4px 2px 3px;border-radius:var(--r-sm);border:1px solid var(--line);
        background:linear-gradient(180deg,color-mix(in srgb,var(--c) 11%,var(--panel-2)),var(--panel-2) 70%);box-shadow:inset 0 2px 0 color-mix(in srgb,var(--c) 75%,transparent);line-height:1.1;transition:transform .08s,background .15s}
      .g-base-tbb .ic{width:24px;height:24px;display:block}
      .g-base-tbb b{font-size:12px;font-weight:700}
      .g-base-tbb small{font-family:var(--f-mono);font-size:11px;color:var(--gold);font-variant-numeric:tabular-nums}
      .g-base-tbb kbd{position:absolute;top:3px;right:4px;font:600 9px/1 var(--f-mono);color:var(--muted);opacity:.65}
      @media (pointer:coarse){.g-base-tbb kbd{display:none}}
      .g-base-tbb.poor small{color:var(--muted)} .g-base-tbb.poor .ic{opacity:.45;filter:grayscale(.6)}
      .g-base-tbb:hover:not(:disabled){background:linear-gradient(180deg,color-mix(in srgb,var(--c) 18%,var(--panel-3)),var(--panel-3) 70%)}
      .g-base-tbb[aria-pressed="true"]{border-color:var(--gold);background:linear-gradient(180deg,color-mix(in srgb,var(--gold) 24%,var(--panel-2)),color-mix(in srgb,var(--gold) 8%,var(--panel-2)));transform:translateY(-1px)}
      .g-base-tbb:disabled{opacity:.4;cursor:not-allowed}
      .g-base-tbb.bomb.live{box-shadow:inset 0 2px 0 var(--bad),0 0 0 1px var(--bad) inset,0 0 14px -4px var(--bad)}
      .g-base .g-base-bar{flex-wrap:nowrap}
      .g-base-ph{display:grid;gap:6px;flex:1 1 auto}
      .g-base .g-base-phase{font-size:13px}
      .g-base-wp{height:4px;border-radius:2px;background:rgba(255,255,255,.07);overflow:hidden}
      .g-base-wp i{display:block;height:100%;width:0;background:var(--gold);border-radius:inherit;transition:width .2s linear}
      .g-base-wp.wave i{background:linear-gradient(90deg,var(--bad),#FFB35C)}
      .g-base-acts{display:flex;gap:6px;align-items:center;flex:none}
      .g-base .g-base-bar .dg-btn{min-height:38px;padding:6px 12px}
      .g-base-snd{width:38px;height:38px;display:grid;place-items:center;border-radius:var(--r-sm);border:1px solid var(--line);background:var(--panel-2);color:var(--muted);padding:0}
      .g-base-snd svg{width:18px;height:18px;fill:none;stroke:currentColor;stroke-width:1.6;stroke-linecap:round;stroke-linejoin:round}
      .g-base-snd[aria-pressed="true"]{color:var(--fg)}
      .g-base-card{background:var(--panel);border:1px solid var(--line);border-radius:var(--r-md);padding:8px 10px;display:grid;gap:8px}
      .g-base-prev{display:flex;flex-wrap:wrap;gap:6px}
      .g-base-prev span{background:var(--panel-2);border:1px solid var(--line);border-radius:999px;padding:2px 10px 2px 3px;font-size:13px;display:inline-flex;gap:6px;align-items:center}
      .g-base-prev span b{font-family:var(--f-mono);font-variant-numeric:tabular-nums}
      .g-base-prev img{width:22px;height:22px;border-radius:50%}
      .g-base-tip{font-size:12.5px;color:var(--muted);border-left:2px solid var(--gold);padding-left:8px;line-height:1.4}
      .g-base-tip:empty{display:none}
      .g-base-tinfo,.g-base-insp{display:grid;grid-template-columns:36px minmax(0,1fr);gap:10px;align-items:center}
      .g-base-tinfo img,.g-base-insp img{width:36px;height:36px;border-radius:var(--r-sm);background:rgba(0,0,0,.3)}
      .g-base-info p{margin:6px 0 0;line-height:1.4}
      .g-base-chips{display:flex;flex-wrap:wrap;gap:4px;margin-top:3px}
      .g-base-chips span{font-family:var(--f-mono);font-size:11px;padding:1px 6px;border-radius:999px;background:var(--panel-2);border:1px solid var(--line);color:var(--fg);white-space:nowrap}
      .g-base-ihp{height:6px;border-radius:3px;background:rgba(255,255,255,.08);overflow:hidden;margin-top:8px}
      .g-base-ihp i{display:block;height:100%;border-radius:inherit}
      .g-base-ist{display:flex;flex-wrap:wrap;gap:4px 14px;margin-top:6px;font-size:12.5px}
      .g-base-ist b{font-family:var(--f-mono);font-variant-numeric:tabular-nums}
      .g-base-iact{display:flex;gap:6px;margin-top:8px}
      .g-base-iact .dg-btn{min-height:34px;padding:4px 10px;font-size:13px;flex:1}
      .g-base-elist{margin:8px 0 0;padding:0;list-style:none;display:grid;gap:8px;color:var(--muted)}
      .g-base-elist li{display:grid;grid-template-columns:40px minmax(0,1fr);gap:10px;align-items:center}
      .g-base-elist img{width:40px;height:40px;border-radius:var(--r-sm)}
      .g-base-elist .st{display:block;font-family:var(--f-mono);font-size:11px;color:var(--muted);margin-top:1px}
      .g-base-dmg{display:grid;gap:6px}
      .g-base-dmg .r{display:grid;grid-template-columns:minmax(0,104px) minmax(0,1fr) auto;gap:8px;align-items:center;font-size:13px}
      .g-base-dmg .r span{display:flex;gap:6px;align-items:center;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .g-base-dmg img{width:20px;height:20px;flex:none}
      .g-base-dmg i{height:8px;border-radius:4px;background:rgba(255,255,255,.07);overflow:hidden}
      .g-base-dmg em{display:block;height:100%;border-radius:inherit}
      .g-base-dmg b{font-family:var(--f-mono);font-size:12px;white-space:nowrap;font-variant-numeric:tabular-nums}
      .g-base-dmg b small{color:var(--muted);font-weight:500}
      .g-base-mvp{font-size:13px;color:var(--muted)} .g-base-mvp b{color:var(--gold)}
    `);
    const S = BaseSim(ctx.seed, ctx.mode), cfg = S.cfg;
    const log = [];
    S.onAct = (op, a) => log.push([S.wave, S.inWave ? S.waveTick : -1, op].concat(a));
    let phase = "build", phaseStart = 0, waveStart = 0, tool = "arrow", lastTower = "arrow", hover = null, pending = null, sel = null;
    let waveKills0 = 0, waveLeaks0 = 0;
    const RM = !!ctx.reducedMotion;
    const towerTools = TOWER_ORDER.filter((t) => ctx.mode === "full" || t !== "mine");
    const hstat = (label, k, me, extra) => `<div class="${P}-stat${me ? " me" : ""}" data-k="${k}"><span>${HUD_ICON[k]}${label}</span><b data-test="${k}">–</b>${extra || ""}</div>`;
    const tbtn = (t, label, small, title, key, extra) => `<button class="${P}-tbb${extra || ""}" data-tool="${t}" data-test="tool-${t}" title="${U.esc(title)}" style="--c:${TCOL[t] || (t === "repair" ? "var(--good)" : "var(--muted)")}">` +
      `<img class="ic" src="${towerIcon(t)}" alt=""><b>${label}</b>${small}${key ? `<kbd>${key}</kbd>` : ""}</button>`;
    ctx.root.innerHTML = `<div class="${P}">
      <div class="${P}-hud">${hstat("Wave", "wave")}${hstat("HP", "hp", false, `<i class="${P}-hpb"><em data-test="hpbar"></em></i>`)}${hstat("Gold", "gold")}${hstat("Kills", "kills")}${hstat("Score", "score", true)}</div>
      <div data-test="result"></div>
      <div class="${P}-main">
        <div class="${P}-col">
          <div class="${P}-map" data-test="map"></div>
          <div class="${P}-tb" data-test="palette" role="toolbar" aria-label="Build and actions">${towerTools.map((t, k) => tbtn(t, TOWERS[t].short, `<small>${TOWERS[t].cost}g</small>`, `${TOWERS[t].name}: ${TOWERS[t].desc} (key ${k + 1})`, k + 1)).join("")}
            ${tbtn("sell", "Sell", "<small>refund</small>", "Sell: full refund, build phase only (S)", "S")}
            ${tbtn("repair", "Repair", "<small>gold</small>", "Repair a damaged structure (R)", "R")}
            ${tbtn("bomb", "Bomb", `<small data-test="bombs">${S.bombs} left</small>`, "Firebomb: area damage during waves (F)", "F", " bomb")}
          </div>
          <div class="${P}-bar">
            <div class="${P}-ph"><span class="${P}-phase" data-test="phase"></span><div class="${P}-wp" data-test="wprog"><i></i></div></div>
            <div class="${P}-acts"><button class="${P}-snd" data-test="sfx" title="Sound effects (M)"></button><button class="dg-btn primary" data-test="go"></button></div>
          </div>
          <div class="${P}-msg" data-test="msg"></div>
        </div>
        <div class="${P}-col" data-test="side">
          <div class="${P}-info" data-test="info"></div>
          <div class="${P}-card"><div class="dg-eyebrow" data-test="prev-title">Next wave</div><div class="${P}-prev" data-test="preview"></div><div class="${P}-tip" data-test="tip"></div></div>
          <details><summary>Rules and zombies</summary>
            <ul class="${P}-rules">${BASE_RULES(ctx.mode).map((r) => `<li>${r}</li>`).join("")}</ul>
            <ul class="${P}-elist">${ENEMY_ORDER.map((k) => { const E = ENEMIES[k]; return `<li><img src="${zombieIcon(k)}" alt=""><div><b style="color:var(--fg)">${E.name}</b> ${ENEMY_DESC[k]}<span class="st">HP ${E.hp} · speed ${E.spd} · ${E.armor ? "armour " + E.armor + " · " : ""}hits core for ${E.dmg} · ${E.bounty}g bounty</span></div></li>`; }).join("")}</ul>
          </details>
        </div>
      </div></div>`;
    const $ = (t) => ctx.root.querySelector(`[data-test="${t}"]`);
    const say = makeSay($("msg"), P);
    const C = {
      font: cssVar(ctx.root, "--f-body", "sans-serif"),
      gold: cssVar(ctx.root, "--gold", "#F5C94A"), bad: cssVar(ctx.root, "--bad", "#FF6275"), good: cssVar(ctx.root, "--good", "#5AD690"),
      ally: cssVar(ctx.root, "--ally", "#6FC3FF"), muted: cssVar(ctx.root, "--muted", "#9D9BC0"),
    };
    // keep map + tool bar on one phone screen: cap the map height by the viewport
    const cvs = makeCanvas(ctx, $("map"), BW / BH, () => draw(), () => Math.max(180, (window.innerHeight || 800) - 350));
    let pathCache = null, pathFor = null;

    // ---- presentation state (real-time clock; never feeds back into the sim)
    const T0 = performance.now();
    let seedP = 1 + (Math.abs(Number(ctx.seed) || 7) % 2147483600);
    const prand = () => (seedP = (seedP * 16807) % 2147483647) / 2147483647;
    const vis = new Map(), shotSeen = new Map(), everBuilt = new Map(), parts = [], decals = [], pops = [], corpses = [];
    let shake = 0, hitFlash = 0, banner = null, lastReal = performance.now();
    let ground = null, groundKey = "", shade = null, shadeKey = "";

    function layer(w, h, paint) {
      const c = document.createElement("canvas");
      c.width = Math.max(1, Math.round(w * cvs.dpr)); c.height = Math.max(1, Math.round(h * cvs.dpr));
      const g = c.getContext("2d"); g.setTransform(cvs.dpr, 0, 0, cvs.dpr, 0, 0); paint(g, w, h);
      return c;
    }
    function layers(w, h) {
      const key = w + "x" + h + "@" + cvs.dpr;
      if (key !== groundKey) { ground = layer(w, h, (g) => paintGround(g, S.map, w, h)); groundKey = key; }
      if (key !== shadeKey) {
        shade = layer(w, h, (g) => {
          const gr = g.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.35, w / 2, h / 2, Math.hypot(w, h) * 0.58);
          gr.addColorStop(0, "rgba(0,0,0,0)"); gr.addColorStop(1, "rgba(0,0,0,.55)");
          g.fillStyle = gr; g.fillRect(0, 0, w, h);
        });
        shadeKey = key;
      }
    }
    function burst(x, y, n, cols, spd, life, size, kind) {
      for (let k = 0; k < n; k++) {
        const a = prand() * PI2, v = spd * (0.35 + prand() * 0.65);
        parts.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, t: 0, life: life * (0.6 + prand() * 0.6), col: cols[k % cols.length], size: size * (0.6 + prand() * 0.8), kind });
      }
      if (parts.length > 420) parts.splice(0, parts.length - 420);
    }
    function addDecal(d) {
      d.t = 0; d.rot = prand() * PI2; d.blobs = [];
      for (let k = 0; k < (d.k === "rubble" ? 7 : 6); k++) d.blobs.push([(prand() - 0.5) * d.r * 1.6, (prand() - 0.5) * d.r * 1.6, d.r * (0.2 + prand() * 0.35)]);
      decals.push(d);
      if (decals.length > 70) decals.shift();
    }
    function onEvent(e, quiet) {
      if (e.k === "die") {
        const K = ZSKIN[e.type], v = vis.get(e.id);
        corpses.push({ type: e.type, x: e.x, y: e.y, ang: v ? v.ang : 0, ph: v ? v.ph : 0, t: 0 });
        addDecal({ k: "splat", x: e.x, y: e.y, r: ENEMIES[e.type].r * 1.6, col: K.goo, life: 14 });
        burst(e.x, e.y, RM ? 3 : 9, [K.goo, K.skin, K.dark], 2.4, 0.45, 0.05, "goo");
        pops.push({ x: e.x, y: e.y - 0.25, text: "+" + e.v, col: C.gold, t: 0, life: 0.9 });
        if (!quiet) SFX.play("die");
      } else if (e.k === "leak") {
        shake = Math.min(1, shake + 0.55); hitFlash = 0.7;
        const b = S.map.base;
        pops.push({ x: b.x + 0.5, y: b.y + 0.05, text: "−" + e.v, col: C.bad, t: 0, life: 1.1, big: true });
        burst(b.x + 0.5, b.y + 0.5, RM ? 4 : 12, ["#FF6275", "#FFB35C", "#5E5A52"], 2.8, 0.5, 0.05, "spark");
        const hs = ctx.root.querySelector(`[data-k="hp"]`);
        if (hs) { hs.classList.remove("hurt"); void hs.offsetWidth; hs.classList.add("hurt"); }
        if (!quiet) SFX.play("hit");
      } else if (e.k === "destroy") {
        burst(e.x, e.y, RM ? 5 : 16, ["#8C8FA0", "#5D6070", "#3A3C46", "#2A2B31"], 2.6, 0.7, 0.07, "rubble");
        addDecal({ k: "rubble", x: e.x, y: e.y, r: 0.32, col: "#4A4C55", life: 18 });
        if (sel && sel.x + 0.5 === e.x && sel.y + 0.5 === e.y) sel = null;
        if (!quiet) SFX.play("crash");
      } else if (e.k === "bomb") {
        burst(e.x, e.y, RM ? 8 : 30, ["#FFE08A", "#FFB35C", "#FF6A3C", "#FF3B3B"], 4.2, 0.6, 0.07, "fire");
        burst(e.x, e.y, RM ? 3 : 10, ["#3A3533"], 1.2, 1.4, 0.16, "smoke");
        addDecal({ k: "scorch", x: e.x, y: e.y, r: e.r, col: "#000", life: 12 });
        shake = Math.min(1, shake + 0.4);
        SFX.play("bomb");
      } else if (e.k === "blast") {
        burst(e.x, e.y, RM ? 3 : 8, ["#FFE08A", "#FFB35C", "#7A7A80"], 2.6, 0.35, 0.05, "fire");
        addDecal({ k: "scorch", x: e.x, y: e.y, r: e.r * 0.6, col: "#000", life: 6 });
        if (!quiet) SFX.play("cannon");
      }
    }
    const angDiff = (a, b) => { let d = a - b; while (d > Math.PI) d -= PI2; while (d < -Math.PI) d += PI2; return d; };
    function animate(dt) {
      let ev = S.events;
      if (ev.length) {
        S.events = [];
        const quiet = ev.length > 60;
        if (quiet) ev = ev.slice(-60);
        for (const e of ev) onEvent(e, quiet);
      }
      const b = S.map.base, seen = new Set();
      for (const e of S.enemies) {
        seen.add(e.id);
        let v = vis.get(e.id);
        if (!v) { v = { x: e.x, y: e.y, ang: Math.atan2(b.y + 0.5 - e.y, b.x + 0.5 - e.x), hp: e.hp, flash: 0, ph: prand() * 6 }; vis.set(e.id, v); }
        const dx = e.x - v.x, dy = e.y - v.y;
        if (dx * dx + dy * dy > 1e-6) v.ang += angDiff(Math.atan2(dy, dx), v.ang) * Math.min(1, dt * 12);
        if (e.hp < v.hp - 1.5) v.flash = 0.12;
        v.flash = Math.max(0, v.flash - dt); v.x = e.x; v.y = e.y; v.hp = e.hp;
      }
      for (const id of vis.keys()) if (!seen.has(id)) vis.delete(id);
      const nowR = performance.now();
      for (const s of S.list) {
        everBuilt.set(s.id, s);
        if (s.shot == null) continue;
        const r = shotSeen.get(s.id);
        if (!r || r.tick !== s.shot) { shotSeen.set(s.id, { tick: s.shot, at: nowR }); if (r && s.type === "arrow") SFX.play("arrow"); }
      }
      for (const p of parts) {
        p.t += dt;
        const drag = p.kind === "smoke" ? 0.9 : 0.86;
        p.vx *= Math.pow(drag, dt * 60); p.vy *= Math.pow(drag, dt * 60);
        if (p.kind === "smoke") p.vy -= 0.4 * dt;
        p.x += p.vx * dt; p.y += p.vy * dt;
      }
      const live = (a) => { let j = 0; for (const q of a) if (q.t < q.life) a[j++] = q; a.length = j; };
      live(parts); live(pops);
      for (const q of pops) q.t += dt;
      for (const q of corpses) q.t += dt;
      for (let i = corpses.length - 1; i >= 0; i--) if (corpses[i].t > 0.8) corpses.splice(i, 1);
      for (const d of decals) d.t += dt;
      for (let i = decals.length - 1; i >= 0; i--) if (decals[i].t > decals[i].life) decals.splice(i, 1);
      shake = Math.max(0, shake - dt * 2.4); hitFlash = Math.max(0, hitFlash - dt * 1.8);
      if (phase === "wave" && !RM) {
        for (const s of S.list) if (s.maxHp && s.hp > 0 && s.hp / s.maxHp < 0.5 && prand() < dt * 5) {
          parts.push({ x: s.x + 0.35 + prand() * 0.3, y: s.y + 0.4, vx: (prand() - 0.5) * 0.2, vy: -0.35, t: 0, life: 1.2, col: "#4A4644", size: 0.09, kind: "smoke" });
        }
      }
    }

    function tileAt(e) {
      const r = cvs.cv.getBoundingClientRect();
      const fx = ((e.clientX - r.left) / r.width) * BW, fy = ((e.clientY - r.top) / r.height) * BH;
      if (fx < 0 || fy < 0 || fx >= BW || fy >= BH) return null;
      return { x: Math.floor(fx), y: Math.floor(fy), fx: Math.round(fx * 100) / 100, fy: Math.round(fy * 100) / 100 };
    }
    const wallAt = (X, Y) => { if (X < 0 || Y < 0 || X >= BW || Y >= BH) return false; const q = S.structs[Y * BW + X]; return !!q && q.type === "wall" && q.hp > 0; };
    function draw() {
      const g = cvs.g, w = cvs.w, h = cvs.h, ts = w / BW;
      if (!w) return;
      const t = (performance.now() - T0) / 1000, nowR = performance.now();
      layers(w, h);
      g.clearRect(0, 0, w, h);
      g.save();
      if (shake > 0 && !RM) g.translate((prand() - 0.5) * shake * ts * 0.22, (prand() - 0.5) * shake * ts * 0.22);
      g.drawImage(ground, 0, 0, w, h);
      // decals: goo splats, scorch marks, rubble
      for (const d of decals) {
        const a = Math.min(1, (d.life - d.t) / 2.5);
        g.save(); g.globalAlpha = a;
        if (d.k === "scorch") {
          const gr = g.createRadialGradient(d.x * ts, d.y * ts, 0, d.x * ts, d.y * ts, d.r * ts);
          gr.addColorStop(0, "rgba(0,0,0,.6)"); gr.addColorStop(0.7, "rgba(20,10,5,.3)"); gr.addColorStop(1, "rgba(0,0,0,0)");
          g.fillStyle = gr; disc(g, d.x * ts, d.y * ts, d.r * ts); g.fill();
        } else {
          g.globalAlpha = a * (d.k === "rubble" ? 0.9 : 0.55);
          for (const [bx, by, br] of d.blobs) {
            if (d.k === "rubble") { g.fillStyle = d.col; g.fillRect((d.x + bx) * ts - br * ts * 0.4, (d.y + by) * ts - br * ts * 0.4, br * ts * 0.8, br * ts * 0.8); }
            else disc(g, (d.x + bx) * ts, (d.y + by) * ts, br * ts, d.col);
          }
        }
        g.restore();
      }
      // zombie routes (preview while placing a blocking piece)
      let paths;
      const hv = pending || hover;
      if (hv && TOWERS[tool] && TOWERS[tool].block && phase !== "wave" && phase !== "done" && !S.canPlace(tool, hv.x, hv.y)) paths = S.previewPaths(tool, hv.x, hv.y);
      else { if (pathFor !== S.field) { pathCache = S.previewPaths(null, 0, 0); pathFor = S.field; } paths = pathCache; }
      paintPaths(g, paths, ts, RM ? 0 : t, phase !== "wave");
      for (const sp of S.map.spawns) drawSpawn(g, sp, ts, RM ? 0 : t, phase === "wave");
      // frost auras while zombies are about
      if (phase === "wave") for (const s of S.list) if (s.type === "frost" && s.hp > 0) {
        const cx = (s.x + 0.5) * ts, cy = (s.y + 0.5) * ts, R = TOWERS.frost.range * ts;
        g.save(); g.fillStyle = "rgba(111,195,255,.06)"; disc(g, cx, cy, R); g.fill();
        g.strokeStyle = "rgba(111,195,255,.28)"; g.lineWidth = 1; g.setLineDash([ts * 0.08, ts * 0.12]); g.lineDashOffset = RM ? 0 : -t * ts * 0.3;
        g.stroke(); g.restore();
      }
      drawCore(g, S.map.base, ts, RM ? 0 : t, Math.max(0, S.baseHp) / BASE_HP, hitFlash * 0.8);
      for (const s of S.list) {
        if (s.hp <= 0 && s.type !== "spike") continue;
        const r = shotSeen.get(s.id);
        drawTowerArt(g, s.type, s.x, s.y, ts, { s, t: RM ? 0 : t, since: r ? (nowR - r.at) / 1000 : 9, nb: (dx, dy) => wallAt(s.x + dx, s.y + dy), hpFrac: s.maxHp ? s.hp / s.maxHp : 1 });
        if (s.maxHp && s.hp < s.maxHp) {
          const f = Math.max(0, s.hp / s.maxHp), bx = s.x * ts + ts * 0.14, by = s.y * ts + ts * 0.84, bw = ts * 0.72;
          g.fillStyle = "rgba(0,0,0,.75)"; rrect(g, bx - 1, by - 1, bw + 2, 6, 3); g.fill();
          g.fillStyle = f > 0.45 ? C.good : C.bad; rrect(g, bx, by, bw * f, 4, 2); g.fill();
        }
      }
      // falling corpses
      for (const q of corpses) drawZombie(g, q.type, q.x * ts, q.y * ts, ts, q.ang + q.t * 0.6, t, { still: true, alpha: Math.max(0, 1 - q.t / 0.8) * 0.9, phase: q.ph });
      // zombies, back to front
      const list = S.enemies.slice().sort((a, b) => a.y - b.y);
      for (const e of list) {
        const v = vis.get(e.id), cx = e.x * ts, cy = e.y * ts;
        drawZombie(g, e.type, cx, cy, ts, v ? v.ang : Math.PI, RM ? 0 : t, { phase: v ? v.ph : 0, flash: v ? v.flash : 0, slow: e.slow < 1 });
        if (e.hp < e.maxHp) {
          const r = ENEMIES[e.type].r * ts * 1.35, bw = Math.max(ts * 0.44, r * 2), f = Math.max(0, e.hp / e.maxHp);
          g.fillStyle = "rgba(0,0,0,.75)"; rrect(g, cx - bw / 2 - 1, cy - r - 9, bw + 2, 5, 2.5); g.fill();
          g.fillStyle = f > 0.5 ? "#FFB35C" : C.bad; rrect(g, cx - bw / 2, cy - r - 8, bw * f, 3, 1.5); g.fill();
        }
      }
      // projectiles and blasts (sim fx)
      for (const f of S.fx) {
        if (f.k === "shot") {
          const p = Math.min(1, Math.max(0, 1 - f.t / 0.12)), x = f.x + (f.x2 - f.x) * p, y = f.y + (f.y2 - f.y) * p;
          const a = Math.atan2(f.y2 - f.y, f.x2 - f.x), L = ts * 0.26;
          g.strokeStyle = "rgba(242,193,78,.35)"; g.lineWidth = Math.max(1, ts * 0.03); line(g, f.x * ts, f.y * ts, x * ts, y * ts);
          g.strokeStyle = "#F4EBD0"; g.lineWidth = Math.max(1.2, ts * 0.035); line(g, x * ts - Math.cos(a) * L, y * ts - Math.sin(a) * L, x * ts, y * ts);
        } else if (f.k === "splash") {
          const k = f.t / 0.3;
          softGlow(g, f.x * ts, f.y * ts, f.r * ts * (1.4 - 0.5 * k), "#FFB35C", k);
          softGlow(g, f.x * ts, f.y * ts, f.r * ts * 0.6, "#FFF1C4", k * k);
        } else if (f.k === "bomb") {
          const k = Math.min(1, f.t / 0.6);
          softGlow(g, f.x * ts, f.y * ts, f.r * ts * (1.8 - 0.6 * k), "#FF6A3C", k);
          softGlow(g, f.x * ts, f.y * ts, f.r * ts * 0.9, "#FFE08A", k * k);
          g.strokeStyle = `rgba(255,179,92,${k})`; g.lineWidth = Math.max(2, ts * 0.06); disc(g, f.x * ts, f.y * ts, f.r * ts * (1.25 - 0.35 * k)); g.stroke();
        } else if (f.k === "spit") {
          const p = Math.min(1, Math.max(0, 1 - f.t / 0.2)), x = f.x + (f.x2 - f.x) * p, y = f.y + (f.y2 - f.y) * p - Math.sin(p * Math.PI) * 0.35;
          softGlow(g, x * ts, y * ts, ts * 0.2, "#7CFFD9", 0.8); disc(g, x * ts, y * ts, ts * 0.06, "#C8FFEE");
        }
      }
      // particles
      for (const p of parts) {
        const k = 1 - p.t / p.life;
        if (p.kind === "smoke") { g.save(); g.globalAlpha = k * 0.35; disc(g, p.x * ts, p.y * ts, p.size * ts * (1 + p.t), p.col); g.restore(); }
        else if (p.kind === "fire") { g.save(); g.globalAlpha = k; g.globalCompositeOperation = "lighter"; disc(g, p.x * ts, p.y * ts, p.size * ts * (0.5 + k * 0.6), p.col); g.restore(); }
        else if (p.kind === "rubble") { g.save(); g.globalAlpha = Math.min(1, k * 2); g.fillStyle = p.col; const q = p.size * ts; g.fillRect(p.x * ts - q / 2, p.y * ts - q / 2, q, q); g.restore(); }
        else { g.save(); g.globalAlpha = k; disc(g, p.x * ts, p.y * ts, p.size * ts, p.col); g.restore(); }
      }
      // floating numbers
      g.textAlign = "center"; g.textBaseline = "middle";
      for (const q of pops) {
        const k = q.t / q.life, y = (q.y - k * 0.55) * ts, sz = Math.round(ts * (q.big ? 0.42 : 0.27) * (1 + 0.25 * Math.max(0, 1 - k * 5)));
        g.save(); g.globalAlpha = Math.min(1, (1 - k) * 2);
        g.font = `800 ${sz}px ${C.font}`; g.lineWidth = 3; g.strokeStyle = "rgba(0,0,0,.8)";
        g.strokeText(q.text, q.x * ts, y); g.fillStyle = q.col; g.fillText(q.text, q.x * ts, y); g.restore();
      }
      // selection + hover ghost / aim
      if (sel && sel.hp > 0 && phase !== "done") {
        const R = TOWERS[sel.type].range, cx = (sel.x + 0.5) * ts, cy = (sel.y + 0.5) * ts;
        if (R) ring(g, cx, cy, R * ts, C.gold);
        g.save(); g.strokeStyle = C.gold; g.lineWidth = 2; g.setLineDash([6, 4]); g.lineDashOffset = RM ? 0 : -t * 20;
        rrect(g, sel.x * ts + 2, sel.y * ts + 2, ts - 4, ts - 4, ts * 0.14); g.stroke(); g.restore();
      }
      if (hv && phase !== "done") {
        const cx = (hv.x + 0.5) * ts, cy = (hv.y + 0.5) * ts;
        if (tool === "bomb") {
          const bx = (hv.fx != null ? hv.fx : hv.x + 0.5) * ts, by = (hv.fy != null ? hv.fy : hv.y + 0.5) * ts;
          g.save(); g.fillStyle = "rgba(255,98,117,.1)"; disc(g, bx, by, S.bombRadius * ts); g.fill();
          g.strokeStyle = C.bad; g.setLineDash([5, 4]); g.lineWidth = 2; g.lineDashOffset = RM ? 0 : -t * 16; g.stroke();
          g.setLineDash([]); g.lineWidth = 1.5; line(g, bx - 6, by, bx + 6, by); line(g, bx, by - 6, bx, by + 6); g.restore();
        } else if (TOWERS[tool]) {
          const ok = !S.canPlace(tool, hv.x, hv.y);
          const occ = S.structs[S.idx(hv.x, hv.y)];
          if (occ && TOWERS[occ.type].range && occ !== sel) ring(g, cx, cy, TOWERS[occ.type].range * ts, C.gold);
          else if (!occ && !S.map.grid[S.idx(hv.x, hv.y)]) {
            g.save(); g.fillStyle = ok ? "rgba(245,201,74,.10)" : "rgba(255,98,117,.10)"; g.fillRect(hv.x * ts, hv.y * ts, ts, ts); g.restore();
            drawTowerArt(g, tool, hv.x, hv.y, ts, { alpha: ok ? 0.6 : 0.25, t, nb: (dx, dy) => wallAt(hv.x + dx, hv.y + dy) });
            if (TOWERS[tool].range) ring(g, cx, cy, TOWERS[tool].range * ts, ok ? C.gold : C.bad);
            if (!ok) { g.strokeStyle = C.bad; g.lineWidth = 2; g.strokeRect(hv.x * ts + 2, hv.y * ts + 2, ts - 4, ts - 4); }
          }
          if (pending) { g.strokeStyle = C.gold; g.lineWidth = 3; g.strokeRect(pending.x * ts + 1.5, pending.y * ts + 1.5, ts - 3, ts - 3); }
        } else {
          g.strokeStyle = tool === "sell" ? C.gold : C.good; g.lineWidth = 2; rrect(g, hv.x * ts + 2, hv.y * ts + 2, ts - 4, ts - 4, ts * 0.12); g.stroke();
        }
      }
      g.restore();
      // screen-space overlays: night vignette, drifting fog, danger pulse, banner
      g.drawImage(shade, 0, 0, w, h);
      if (!RM) for (let k = 0; k < 3; k++) {
        const fx = (((t * 0.018 * (k + 1) + k * 0.37) % 1.4) - 0.2) * w, fy = h * (0.25 + 0.3 * k);
        softGlow(g, fx, fy, ts * (2.4 + k), "#A9BFB2", 0.05);
      }
      const danger = phase !== "done" && S.baseHp <= 30 ? 0.18 + 0.12 * Math.sin(t * 5) : 0;
      const red = Math.max(hitFlash * 0.55, danger);
      if (red > 0) {
        const gr = g.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.3, w / 2, h / 2, Math.hypot(w, h) * 0.6);
        gr.addColorStop(0, "rgba(255,40,60,0)"); gr.addColorStop(1, `rgba(255,40,60,${red})`);
        g.fillStyle = gr; g.fillRect(0, 0, w, h);
      }
      if (banner) {
        const k = (nowR - banner.at) / 1000, D = banner.dur;
        if (k > D) banner = null;
        else {
          const a = Math.max(0, Math.min(1, k / 0.25, (D - k) / 0.45)), slide = RM ? 0 : Math.pow(1 - Math.min(1, k / 0.35), 2) * ts * 0.8;
          const bh = Math.max(56, ts * 1.5), by = h * 0.5 - bh / 2;
          g.save(); g.globalAlpha = a;
          const bgd = g.createLinearGradient(0, 0, w, 0);
          bgd.addColorStop(0, "rgba(0,0,0,0)"); bgd.addColorStop(0.2, "rgba(0,0,0,.72)"); bgd.addColorStop(0.8, "rgba(0,0,0,.72)"); bgd.addColorStop(1, "rgba(0,0,0,0)");
          g.fillStyle = bgd; g.fillRect(0, by, w, bh);
          const edge = g.createLinearGradient(0, 0, w, 0);
          edge.addColorStop(0, "rgba(0,0,0,0)"); edge.addColorStop(0.5, banner.col); edge.addColorStop(1, "rgba(0,0,0,0)");
          g.fillStyle = edge; g.fillRect(0, by, w, 1.5); g.fillRect(0, by + bh - 1.5, w, 1.5);
          g.textAlign = "center"; g.textBaseline = "middle";
          g.font = `800 ${Math.round(Math.max(22, ts * 0.62))}px ${C.font}`; g.fillStyle = banner.col;
          if ("letterSpacing" in g) g.letterSpacing = "2px";
          g.fillText(banner.title, w / 2 - slide, by + bh * 0.4);
          if ("letterSpacing" in g) g.letterSpacing = "0px";
          g.font = `600 ${Math.round(Math.max(11, ts * 0.24))}px ${C.font}`; g.fillStyle = "rgba(255,255,255,.82)";
          g.fillText(banner.sub, w / 2 + slide, by + bh * 0.77);
          g.restore();
        }
      }
    }
    function ring(g, cx, cy, r, col) {
      g.save(); g.fillStyle = col; g.globalAlpha = 0.06; disc(g, cx, cy, r); g.fill();
      g.strokeStyle = col; g.globalAlpha = 0.75; g.setLineDash([4, 4]); g.lineWidth = 1.5;
      g.beginPath(); g.arc(cx, cy, r, 0, PI2); g.stroke(); g.restore();
    }
    function showBanner(title, sub, col, dur) { banner = { title, sub: sub || "", col: col || C.gold, at: performance.now(), dur: dur || 1.5 }; }

    // ---- side panel: tool card or the selected structure's inspector
    let infoKey = "";
    function chips(list) { return `<div class="${P}-chips">${list.filter(Boolean).map((c) => `<span>${c}</span>`).join("")}</div>`; }
    function toolInfo(t) {
      const T = TOWERS[t];
      if (T) {
        return `<div class="${P}-tinfo"><img src="${towerIcon(t)}" alt=""><div><b>${T.name}</b>${chips([T.cost + "g", T.hp ? T.hp + " HP" : "", T.range ? "range " + T.range : "",
          T.dmg ? T.dmg + " dmg / " + T.cd + "s" : T.dps ? T.dps + " dmg/s" : "", T.splash ? "splash" : "", T.slow ? "slow " + Math.round((1 - T.slow) * 100) + "%" : "", T.income ? "+" + T.income + "g/s" : "",
          T.block ? "blocks path" : "on path"])}</div></div><p>${T.desc}</p>`;
      }
      const head = (name, sub) => `<div class="${P}-tinfo"><img src="${towerIcon(t)}" alt=""><div><b>${name}</b>${chips(sub)}</div></div>`;
      if (t === "sell") return head("Sell", ["full refund", "build phase only"]) + "<p>Tap a structure to sell it for everything you paid.</p>";
      if (t === "repair") return head("Repair", ["up to 60% of price"]) + "<p>Tap a damaged structure. The cost grows with the damage.</p>";
      return head("Firebomb", [S.bombDamage() + " dmg", "radius " + S.bombRadius, "5 s cooldown"]) + "<p>During a wave, tap the map to drop it on a crowd. Armour still applies.</p>";
    }
    function renderInfo() {
      let key, html;
      if (sel && (sel.hp <= 0 && sel.type !== "spike" || S.structs[S.idx(sel.x, sel.y)] !== sel)) sel = null;
      if (sel) {
        const s = sel, T = TOWERS[s.type], rc = S.repairCost(s), canSell = !(S.wave > 0 || S.inWave), f = s.maxHp ? s.hp / s.maxHp : 1;
        key = ["sel", s.id, Math.ceil(s.hp), s.kills || 0, Math.round((s.dmg || 0) / 5), rc, rc && rc <= S.gold, canSell].join(":");
        if (key !== infoKey) {
          const stats = s.type === "mine" ? `<span>Income <b>+${T.income}g/s</b></span><span>During waves</span>`
            : s.type === "wall" ? `<span>Blocks and reroutes</span>` : `<span>Kills <b>${s.kills || 0}</b></span><span>Damage <b>${U.fmt(Math.round(s.dmg || 0))}</b></span>`;
          html = `<div class="${P}-insp"><img src="${towerIcon(s.type)}" alt=""><div><b>${T.name}</b>${chips([s.maxHp ? Math.ceil(s.hp) + " / " + s.maxHp + " HP" : "trap", T.range ? "range " + T.range : ""])}</div></div>` +
            (s.maxHp ? `<div class="${P}-ihp"><i style="width:${(f * 100).toFixed(1)}%;background:${f > 0.45 ? "var(--good)" : "var(--bad)"}"></i></div>` : "") +
            `<div class="${P}-ist">${stats}</div>` +
            `<div class="${P}-iact"><button class="dg-btn" data-act="repair"${rc && rc <= S.gold ? "" : " disabled"}>${rc ? "Repair · " + rc + "g" : "Repair"}</button>` +
            `<button class="dg-btn" data-act="sell"${canSell ? "" : " disabled"}>Sell · +${s.paid}g</button></div>`;
        }
      } else {
        key = "tool:" + tool + ":" + (tool === "bomb" ? S.bombDamage() : "");
        if (key !== infoKey) html = toolInfo(tool);
      }
      if (key !== infoKey) { infoKey = key; $("info").innerHTML = html; }
    }
    $("info").addEventListener("click", (e) => {
      const b = e.target.closest("[data-act]");
      if (!b || !sel || phase === "done") return;
      const x = sel.x, y = sel.y;
      if (b.dataset.act === "repair") { const why = S.repair(x, y); say(why || "Repaired.", why ? "bad" : "good"); SFX.play(why ? "err" : "place"); }
      else { const why = S.sell(x, y); say(why || "Sold for a full refund.", why ? "bad" : "good"); SFX.play(why ? "err" : "sell"); if (!why) sel = null; }
      infoKey = ""; renderInfo();
    });

    // ---- HUD
    const hudCache = {};
    function setT(t, v) { if (hudCache[t] !== v) { hudCache[t] = v; const el = $(t); if (el) el.textContent = v; } }
    function bump(k) { const el = ctx.root.querySelector(`[data-k="${k}"]`); if (el) { el.classList.remove("gain"); void el.offsetWidth; el.classList.add("gain"); } }
    function setTool(t) {
      if (phase === "done") return;
      tool = t; pending = null; sel = null;
      if (TOWERS[t]) lastTower = t;
      ctx.root.querySelectorAll("[data-tool]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.tool === t)));
      renderInfo();
    }
    function setSound() {
      const b = $("sfx");
      b.setAttribute("aria-pressed", String(SFX.on));
      b.setAttribute("aria-label", SFX.on ? "Sound on" : "Sound off");
      b.innerHTML = SFX.on ? HUD_ICON.sndOn : HUD_ICON.sndOff;
    }
    const seenBefore = (wi) => { const o = new Set(); for (let i = 0; i < wi; i++) for (const [k] of S.waves[i].counts) o.add(k); return o; };
    function hud() {
      setT("wave", Math.min(S.wave + (phase === "wave" ? 1 : 0), cfg.waves) + "/" + cfg.waves);
      setT("hp", String(Math.ceil(S.baseHp)));
      const gOld = hudCache.gold, kOld = hudCache.kills;
      setT("gold", String(S.gold));
      setT("kills", String(S.kills));
      if (gOld != null && Number(gOld) < S.gold && phase === "wave") bump("gold");
      if (kOld != null && kOld !== hudCache.kills) bump("kills");
      const hf = Math.max(0, S.baseHp) / BASE_HP, hb = $("hpbar");
      const hpw = (hf * 100).toFixed(1) + "%";
      if (hudCache.hpw !== hpw) { hudCache.hpw = hpw; hb.style.width = hpw; hb.style.backgroundColor = hf > 0.5 ? "var(--good)" : hf > 0.25 ? "#FFB35C" : "var(--bad)"; }
      setT("score", phase === "build" ? "0" : U.fmt(S.score())); // nothing is scored until the defence starts
      setT("bombs", S.bombCd > 0 && phase === "wave" ? `cool ${Math.ceil(S.bombCd)}s` : `${S.bombs} left`);
      const goTxt = phase === "build" ? "Start waves" : phase === "window" ? "Next wave now" : phase === "wave" ? "Wave running" : "Finished";
      const go = $("go");
      if (go.textContent !== goTxt) { go.textContent = goTxt; go.disabled = phase === "wave" || phase === "done"; }
      const wv = S.waves[S.wave];
      let ph, frac = 0;
      if (phase === "build") { ph = `Build your defence · ${cfg.gold} gold budget`; frac = Math.max(0, 1 - ctx.now() / cfg.buildMs); }
      else if (phase === "window") { ph = `Wave ${S.wave} held · build, repair, or start the next wave`; frac = Math.max(0, 1 - (ctx.now() - phaseStart) / cfg.windowMs); }
      else if (phase === "wave" && wv) {
        const left = wv.spawns.length - S.spawnIdx + S.enemies.length;
        ph = `Wave ${S.wave + 1} of ${cfg.waves} · ${left} zombie${left === 1 ? "" : "s"} left`;
        frac = 1 - left / Math.max(1, wv.spawns.length);
      } else { ph = "Defence over"; frac = 1; }
      setT("phase", ph);
      const wp = $("wprog"), wpw = (frac * 100).toFixed(1) + "%";
      if (hudCache.wpw !== wpw) { hudCache.wpw = wpw; wp.firstChild.style.width = wpw; }
      const wpc = phase === "wave" ? "wave" : "";
      if (hudCache.wpc !== wpc) { hudCache.wpc = wpc; wp.className = `${P}-wp ${wpc}`; }
      const pv = !wv || phase === "done" ? "" : wv.counts.map(([k, c]) => `<span title="${ENEMIES[k].name}: ${U.esc(ENEMY_DESC[k])}"><img src="${zombieIcon(k)}" alt="">${ENEMIES[k].name} <b>×${c}</b></span>`).join("");
      if (hudCache.prev !== pv) {
        hudCache.prev = pv; $("preview").innerHTML = pv || '<span class="dg-muted">No more waves</span>';
        let tip = "";
        if (wv && phase !== "done") {
          const old = seenBefore(S.wave), fresh = wv.counts.map(([k]) => k).filter((k) => !old.has(k) && ENEMY_TIP[k]);
          if (fresh.length && S.wave > 0) tip = `<b style="color:var(--fg)">New:</b> ${ENEMY_TIP[fresh[0]]}`;
          else if (S.wave === 0) tip = "Walls make the route longer, so zombies walk past more towers. Spikes under Frost hit hardest.";
          else if (S.wave === cfg.waves - 1) tip = "Final wave. Spend your gold: unspent gold scores only ÷ 10.";
        }
        $("tip").innerHTML = tip;
      }
      setT("prev-title", phase === "done" ? "Waves" : phase === "wave" ? `This wave (${S.wave + 1})` : `Next wave (${Math.min(S.wave + 1, cfg.waves)} of ${cfg.waves})`);
      ctx.root.querySelectorAll("[data-tool]").forEach((b) => {
        const T = TOWERS[b.dataset.tool];
        b.classList.toggle("poor", !!T && T.cost > S.gold);
        if (b.dataset.tool === "bomb") b.classList.toggle("live", phase === "wave" && S.bombs > 0 && S.bombCd <= 0);
      });
      renderInfo();
    }
    // ---- flow
    function startWave() {
      if (phase === "done" || phase === "wave" || S.over) return;
      phase = "wave"; pending = null;
      waveKills0 = S.kills; waveLeaks0 = S.leaks;
      const wv = S.waves[S.wave], old = seenBefore(S.wave), fresh = wv.counts.map(([k]) => k).filter((k) => !old.has(k));
      S.startWave(); waveStart = ctx.now();
      if (S.bombs > 0) setTool("bomb");
      const last = S.wave === cfg.waves - 1;
      showBanner(last ? "FINAL WAVE" : "WAVE " + (S.wave + 1), fresh.length && S.wave > 0 ? "New: " + fresh.map((k) => ENEMIES[k].name + "s").join(" & ") + "!"
        : wv.counts.map(([k, c]) => c + " " + ENEMIES[k].name + (c === 1 ? "" : "s")).join(" · "), last ? C.bad : "#FF8A9A", 1.4);
      SFX.play("wave");
      say("Wave " + (S.wave + 1) + " incoming.", "");
    }
    function waveOver() {
      S.fx = [];
      ctx.progress(S.score());
      if (S.over) { finish(); return; }
      phase = "window"; phaseStart = ctx.now();
      setTool(lastTower);
      const kills = S.kills - waveKills0, leaks = S.leaks - waveLeaks0;
      showBanner(`WAVE ${S.wave} HELD`, `${kills} zombie${kills === 1 ? "" : "s"} down · ${leaks ? leaks + " got through" : "no leaks"}`, C.gold, 1.3);
      SFX.play("held");
      say(`Wave ${S.wave} held. +${cfg.windowMs / 1000} s to build or repair.`, "good");
    }
    const SRC_NAME = { bomb: "Firebomb" };
    function damageBreakdown() {
      const rows = Object.keys(S.stats.dmg).map((k) => [k, S.stats.dmg[k], S.stats.kills[k] || 0]).filter((r) => r[1] >= 1).sort((a, b) => b[1] - a[1]);
      if (!rows.length) return "";
      const max = rows[0][1];
      return `<div class="dg-eyebrow">Damage by source</div><div class="${P}-dmg">${rows.map(([k, d, kl]) =>
        `<div class="r"><span><img src="${towerIcon(k)}" alt="">${SRC_NAME[k] || TOWERS[k].name}</span><i><em style="width:${Math.max(2, (d / max) * 100).toFixed(1)}%;background:${TCOL[k]}"></em></i><b>${U.fmt(Math.round(d))} <small>· ${kl} kills</small></b></div>`).join("")}</div>`;
    }
    function finish() {
      if (phase === "done") return;
      phase = "done"; hover = null; pending = null; sel = null;
      const score = S.score();
      const rows = [
        ["Waves survived", `${S.survived} × 1,000`, 1000 * S.survived],
        ["Base HP left", `${Math.max(0, Math.round(S.baseHp))} × 5`, Math.max(0, Math.round(S.baseHp)) * 5],
        ["Kills", `${S.kills} × 10`, 10 * S.kills],
        ["Unspent gold", `${S.gold} ÷ 10`, Math.floor(S.gold / 10)],
      ];
      const table = `<table class="dg-table"><tbody>${rows.map((r) => `<tr><td>${r[0]}</td><td class="num dg-muted">${r[1]}</td><td class="num">${U.fmt(r[2])}</td></tr>`).join("")}
        <tr class="tot"><td>Total</td><td></td><td class="num dg-gold">${U.fmt(score)}</td></tr></tbody></table>`;
      const verdict = S.dead ? `Base destroyed in wave ${S.wave + 1}.` : `All ${cfg.waves} waves held.`;
      let mvp = null;
      for (const s of S.list) everBuilt.set(s.id, s);
      for (const s of everBuilt.values()) if ((s.kills || 0) > 0 && (!mvp || s.kills > mvp.kills)) mvp = s;
      const lost = mvp && S.structs[S.idx(mvp.x, mvp.y)] !== mvp ? " before it fell" : "";
      const mvpLine = mvp ? `<div class="${P}-mvp">Top defender: <b>${TOWERS[mvp.type].name}</b> with ${mvp.kills} kills and ${U.fmt(Math.round(mvp.dmg || 0))} damage${lost}.</div>` : "";
      $("result").innerHTML = `<div class="${P}-res"><div class="dg-eyebrow">Base Duel · final</div>
        <div class="${P}-big" data-test="final">${U.fmt(score)}<small>points · ${verdict}</small></div>${table}${mvpLine}${damageBreakdown()}</div>`;
      ctx.root.querySelectorAll("[data-tool]").forEach((b) => { b.disabled = true; b.setAttribute("aria-pressed", "false"); });
      showBanner(S.dead ? "BASE OVERRUN" : "BASE HELD", `${U.fmt(score)} points`, S.dead ? C.bad : C.gold, 2.6);
      SFX.play(S.dead ? "end" : "held");
      say(verdict, S.dead ? "bad" : "good");
      infoKey = ""; hud(); draw();
      ctx.setStatus("Final · " + U.fmt(score));
      ctx.progress(score);
      ctx.timeout(() => ctx.end({ score, detail: `<p class="dg-note">${verdict} ${S.survived} waves, ${Math.max(0, Math.round(S.baseHp))} HP, ${S.kills} kills.</p>${table}` }), 900);
    }
    function frame(now) {
      if (ctx.signal.ended) return;
      if (phase === "wave") {
        const target = Math.round(baseSimAt(cfg, now - waveStart) / DT);
        let n = 0;
        while (S.inWave && !S.over && S.waveTick < target && n++ < 800) S.step();
        if (!S.inWave || S.over) waveOver();
      }
      const r = performance.now(), dt = Math.min(0.05, Math.max(0, (r - lastReal) / 1000));
      lastReal = r;
      animate(dt);
      draw(); hud();
      ctx.raf(frame);
    }
    function act(e) {
      if (phase === "done" || ctx.signal.ended) return;
      const p = tileAt(e);
      if (!p) return;
      hover = p;
      if (tool === "bomb") {
        const why = S.bomb(p.fx, p.fy);
        say(why || "Firebomb away.", why ? "bad" : "good");
        if (why) SFX.play("err");
        if (!why && S.bombs === 0) setTool("repair");
        return;
      }
      const s = S.structs[S.idx(p.x, p.y)];
      if (tool === "repair") { const why = S.repair(p.x, p.y); say(why || "Repaired.", why ? "bad" : "good"); SFX.play(why ? "err" : "place"); return; }
      if (tool === "sell") { const why = S.sell(p.x, p.y); say(why || "Sold for a full refund.", why ? "bad" : "good"); SFX.play(why ? "err" : "sell"); return; }
      if (s) {
        sel = sel === s ? null : s; pending = null; infoKey = "";
        say(sel ? `${TOWERS[s.type].name}: ${Math.ceil(s.hp)}/${s.maxHp} HP. Repair or sell it from the panel.` : "", "");
        renderInfo();
        return;
      }
      if (sel) { sel = null; infoKey = ""; }
      const why = S.canPlace(tool, p.x, p.y);
      if (why) { say(why + ".", "bad"); pending = null; SFX.play("err"); return; }
      const T = TOWERS[tool];
      if (e.pointerType && e.pointerType !== "mouse" && T.cost >= 50 && !(pending && pending.x === p.x && pending.y === p.y && pending.t === tool)) {
        pending = { x: p.x, y: p.y, t: tool };
        say(`Tap again to build ${T.name} for ${T.cost} gold.`, "");
        return;
      }
      pending = null;
      S.place(tool, p.x, p.y);
      burst(p.x + 0.5, p.y + 0.5, RM ? 2 : 8, ["#6A5A44", "#8A7658", "#3A3024"], 1.6, 0.4, 0.05, "rubble");
      SFX.play("place");
      say(`${T.name} built. ${S.gold} gold left.`, "good");
    }
    const cv = cvs.cv;
    ctx.root.firstElementChild.addEventListener("pointerdown", () => SFX.arm(), { capture: true });
    cv.addEventListener("pointerdown", (e) => { e.preventDefault(); act(e); });
    cv.addEventListener("pointermove", (e) => { if (e.pointerType === "mouse" || !pending) hover = tileAt(e); });
    cv.addEventListener("pointerleave", () => { if (!pending) hover = null; });
    ctx.root.querySelectorAll("[data-tool]").forEach((b) => b.addEventListener("click", () => setTool(b.dataset.tool)));
    $("go").addEventListener("click", () => { if (phase === "build" || phase === "window") startWave(); });
    $("sfx").addEventListener("click", () => { SFX.arm(); SFX.set(!SFX.on); setSound(); });
    ctx.onKey((e) => {
      if (phase === "done") return;
      if (e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
      SFX.arm();
      const k = e.key.toLowerCase();
      const n = parseInt(k, 10);
      if (n >= 1 && n <= towerTools.length) setTool(towerTools[n - 1]);
      else if (k === "s") setTool("sell"); else if (k === "r") setTool("repair"); else if (k === "f") setTool("bomb");
      else if (k === "m") { SFX.set(!SFX.on); setSound(); }
      else if (k === "escape") { sel = null; pending = null; infoKey = ""; renderInfo(); }
      else if (k === "enter" && (phase === "build" || phase === "window")) startWave();
    });
    ctx.interval(() => {
      const now = ctx.now();
      if (phase === "build") {
        const left = cfg.buildMs - now;
        ctx.setStatus("Build · " + mmss(left));
        if (left <= 0) startWave();
      } else if (phase === "window") {
        const left = cfg.windowMs - (now - phaseStart);
        ctx.setStatus(`Wave ${S.wave + 1} in ${Math.max(0, Math.ceil(left / 1000))} s`);
        if (left <= 0) startWave();
      } else if (phase === "wave") ctx.setStatus(`Wave ${S.wave + 1}/${cfg.waves}`);
    }, 200);
    setTool("arrow");
    setSound();
    say(ctx.mode === "mix" ? "Quick defence: 20 s to build, then 3 waves." : "Build towers on the grid. Walls and towers reroute the zombies (dashed lines).", "");
    ctx.setStatus("Build · " + mmss(cfg.buildMs));
    hud();
    ctx.raf(frame);

    ctx.test = {
      state: () => ({ phase, gold: S.gold, wave: S.wave, survived: S.survived, baseHp: S.baseHp, kills: S.kills, bombs: S.bombs, score: S.score(), over: S.over,
        structs: S.list.map((s) => ({ type: s.type, x: s.x, y: s.y, hp: s.hp })), enemies: S.enemies.map((e) => ({ type: e.type, x: e.x, y: e.y })), log: log.slice(), tool }),
      placeAI(skill) { if (phase === "wave" || phase === "done") return 0; const n0 = S.list.length; aiBuild(S, U.rng("ui-ai:" + ctx.seed + ":" + skill), skill == null ? 0.9 : skill, phase === "build" ? "build" : "window"); return S.list.length - n0; },
      skipToDefence() { if (phase === "build" || phase === "window") startWave(); },
      fastForward() {
        if (phase === "done") return;
        let guard = 0;
        while (!S.over && guard++ < 200000) { if (!S.inWave) S.startWave(); S.step(); }
        phase = "wave"; waveOver();
      },
      tilePoint(x, y) { const r = cv.getBoundingClientRect(); return { x: r.left + ((x + 0.5) / BW) * r.width, y: r.top + ((y + 0.5) / BH) * r.height }; },
      mapPoint(fx, fy) { const r = cv.getBoundingClientRect(); return { x: r.left + (fx / BW) * r.width, y: r.top + (fy / BH) * r.height }; },
      legal(type) { const out = []; for (let y = 0; y < BH; y++) for (let x = 0; x < BW; x++) if (!S.canPlace(type, x, y)) out.push([x, y]); return out; },
      why: (type, x, y) => S.canPlace(type, x, y),
      replay: (lg) => baseReplay(ctx.seed, ctx.mode, lg || log),
      setTool,
    };
  }
  function BASE_RULES(mode) {
    const c = baseConfig(mode);
    return [
      `Build phase (${c.buildMs / 1000} s): spend ${c.gold} gold on walls, towers${mode === "full" ? ", traps and gold mines" : " and traps"}. Sell for a full refund until the first wave starts.`,
      `Zombies walk the shortest route to your core (dashed lines). Towers and walls reroute them, but you can never seal the path.`,
      `Then ${c.waves} identical seeded waves attack. Between waves you get ${c.windowMs / 1000} s to spend gold earned from kills${mode === "full" ? " and mines" : ""}.`,
      `During waves: ${c.bombs} Firebombs (tap the map). Repair (costs gold) works at any time.`,
      `Score = 1,000 per wave survived + 5 × base HP + 10 per kill + unspent gold ÷ 10. Losing the base ends the run.`,
    ];
  }

  /* ====================================================================================
     CITY DUEL — play
     ==================================================================================== */
  const CITY_RADIUS = { park: 2, com: 2, ind: 2, power: 2, transit: 2, hosp: 3, school: 2, police: 3 };
  function cityFacts(k) {
    const B = BLD[k], f = [];
    if (B.house) f.push(`houses ${B.house}`);
    if (B.jobs) f.push(`${B.jobs} jobs`);
    if (B.gen) f.push(`+${B.gen} energy`);
    if (B.wgen) f.push(`+${B.wgen} water`);
    if (B.energy) f.push(`uses ${B.energy} energy`);
    if (B.water) f.push(`uses ${B.water} water`);
    if (B.traf) f.push(`traffic ${B.traf}`);
    if (B.crime) f.push(`crime ${B.crime}`);
    if (B.pol) f.push(`pollution ${B.pol}`);
    if (CITY_RADIUS[k]) f.push(`radius ${CITY_RADIUS[k]}`);
    return f.join(" · ");
  }
  function cityPlay(ctx) {
    const P = "g-city";
    DG.css("city", packCss(P) + `
      .g-city-grid{display:grid;gap:3px;background:var(--panel);border:1px solid var(--line);border-radius:var(--r-md);padding:6px;touch-action:manipulation}
      .g-city-t{position:relative;aspect-ratio:1;min-height:36px;border-radius:6px;border:1px solid var(--line);background:#1F2340;padding:2px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:0;font-size:11px;line-height:1.1;overflow:hidden;color:var(--fg)}
      .g-city-t:hover:not(:disabled){border-color:var(--muted)}
      .g-city-t.water{background:repeating-linear-gradient(135deg,#1C3E5E 0 6px,#18344F 6px 12px);cursor:not-allowed}
      .g-city-t.rock{background:#3B3552;cursor:not-allowed}
      .g-city-t .k{font-weight:700;letter-spacing:.02em;text-transform:uppercase;font-size:10px}
      .g-city-t .lg{display:none} .g-city-t .sm{display:inline}
      @container (min-width:560px){.g-city-t .lg{display:inline}.g-city-t .sm{display:none}.g-city-t .k{font-size:11px}}
      .g-city-t .v{font-family:var(--f-mono);font-size:11px}
      .g-city-t.in{box-shadow:inset 0 0 0 2px color-mix(in srgb,var(--gold) 60%,transparent)}
      .g-city-t.pend{box-shadow:inset 0 0 0 3px var(--gold)}
      .g-city-t.glow{box-shadow:inset 0 0 0 2px var(--gold)}
      .g-city-prog{flex:1 1 120px;max-width:220px;height:6px;border-radius:3px;background:var(--panel-2);overflow:hidden}
      .g-city-prog i{display:block;height:100%;width:0;background:var(--gold)}
      .g-city-stats{display:grid;grid-template-columns:1fr auto;gap:2px 10px;font-size:13px;background:var(--panel);border:1px solid var(--line);border-radius:var(--r-md);padding:8px 10px}
      .g-city-stats span{color:var(--muted)} .g-city-stats b{font-family:var(--f-mono);font-weight:600;text-align:right}
      .g-city-stats .sc{border-top:1px solid var(--line);padding-top:4px;margin-top:2px}
      .g-city-stats .parts{grid-column:1/-1;font-size:12px}
      .g-city-rep{display:grid;grid-template-columns:repeat(auto-fit,minmax(118px,1fr));gap:8px}
      .g-city-rep div{background:var(--panel-2);border:1px solid var(--line);border-radius:var(--r-sm);padding:6px 10px}
      .g-city-rep span{display:block;font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:var(--muted);font-weight:600}
      .g-city-rep b{font-family:var(--f-mono);font-size:17px}
      .g-city-leg td{font-size:12px;vertical-align:top}
    `);
    const map = cityMap(ctx.seed, ctx.mode), cfg = cityConfig(ctx.mode), n = map.n;
    const plan = new Array(n * n).fill(null);
    let tool = "res", phase = "build", pending = -1, lastPtr = "mouse", hoverI = -1, ev = cityEval(map, plan);
    const moves = [];
    ctx.root.innerHTML = `<div class="${P}">
      <div class="${P}-hud">${stat(P, "Budget left", "budget")}${stat(P, "Population", "pop")}${stat(P, "Happiness", "hap")}${stat(P, "City score", "score", true)}</div>
      <div data-test="result"></div>
      <div class="${P}-main">
        <div class="${P}-col">
          <div class="${P}-grid" data-test="grid" style="grid-template-columns:repeat(${n},minmax(0,1fr))">${plan.map((_, i) =>
            `<button class="${P}-t${map.tiles[i] === 1 ? " water" : map.tiles[i] === 2 ? " rock" : ""}" data-i="${i}" data-test="tile-${i}" aria-label="Tile ${i % n + 1},${((i / n) | 0) + 1}"></button>`).join("")}</div>
          <div class="${P}-bar"><span class="${P}-phase" data-test="phase">Place buildings, then finish.</span><span class="dg-row" style="gap:8px"><button class="dg-btn" data-test="undo" disabled>Undo</button><button class="dg-btn primary" data-test="finish">Finish city</button></span></div>
          <div class="${P}-msg" data-test="msg"></div>
        </div>
        <div class="${P}-col">
          <div class="dg-eyebrow">Buildings (tap one, then a tile)</div>
          <div class="${P}-pal" data-test="palette">${BLD_ORDER.map((k) => `<button class="${P}-tool" data-tool="${k}" data-test="tool-${k}" title="${U.esc(BLD[k].desc)}"><i class="sw" style="background:${BLD[k].col}"></i><span class="tx"><b>${BLD[k].short}</b><small>$${U.fmt(BLD[k].cost)}</small></span></button>`).join("")}
            <button class="${P}-tool" data-tool="bulldoze" data-test="tool-bulldoze" title="Remove a building for a full refund"><i class="sw" style="background:var(--bad)"></i><span class="tx"><b>Bulldoze</b><small>refund</small></span></button></div>
          <div class="${P}-info" data-test="info"></div>
          <div class="dg-eyebrow">Projected city</div>
          <div class="${P}-stats" data-test="stats"></div>
          <details><summary>How the score works</summary><ul class="${P}-rules">${CITY_RULES(ctx.mode).map((r) => `<li>${r}</li>`).join("")}</ul></details>
          <details><summary>Building guide</summary><table class="dg-table ${P}-leg"><tbody>${BLD_ORDER.map((k) => `<tr><td><b>${BLD[k].name}</b><br><span class="dg-gold dg-mono">$${U.fmt(BLD[k].cost)}</span></td><td class="dg-muted">${BLD[k].desc}<br>${cityFacts(k)}</td></tr>`).join("")}</tbody></table></details>
        </div>
      </div></div>`;
    const $ = (t) => ctx.root.querySelector(`[data-test="${t}"]`);
    const say = makeSay($("msg"), P);
    const tiles = [...ctx.root.querySelectorAll(`.${P}-t`)];
    const hapCol = (h) => (h >= 60 ? "var(--good)" : h >= 40 ? "var(--warn)" : "var(--bad)");
    function renderTiles() {
      tiles.forEach((el, i) => {
        const k = plan[i];
        let html = "", bg = "";
        if (k) {
          const B = BLD[k];
          bg = `color-mix(in srgb,${B.col} 30%,#1F2340)`;
          html = `<span class="k" style="color:${B.col}"><span class="lg">${B.short}</span><span class="sm">${B.tile}</span></span>`;
          if (k === "res" && ev.homeHap[i] != null) html += `<span class="v" style="color:${hapCol(ev.homeHap[i])}">${ev.homeHap[i]}</span>`;
        }
        if (el._h !== html) { el.innerHTML = html; el._h = html; }
        if (!map.tiles[i]) el.style.background = bg;
        el.classList.toggle("pend", i === pending);
        const R = hoverI >= 0 && CITY_RADIUS[tool] != null && phase === "build" ? CITY_RADIUS[tool] : -1;
        el.classList.toggle("in", R >= 0 && Math.max(Math.abs((i % n) - (hoverI % n)), Math.abs(((i / n) | 0) - ((hoverI / n) | 0))) <= R);
      });
    }
    function pct(v) { return Math.round(v) + "%"; }
    function statsHtml(e) {
      const rows = [
        ["Population", U.fmt(e.population)], ["Happiness", pct(e.happiness)], ["Revenue", money(e.revenue) + "/day"],
        ["Employment", pct(e.employment * 100) + ` · ${U.fmt(e.jobs)} jobs`], ["Energy", `${e.energy[0]} / ${e.energy[1]} used`],
        ["Water", `${e.water[0]} / ${e.water[1]} used`], ["Traffic", pct(e.trafficPct)], ["Crime", pct(e.crimePct)], ["Pollution", pct(e.pollutionPct)],
        ["Growth", (e.growth >= 0 ? "+" : "") + e.growth.toFixed(1) + "%/yr"],
      ];
      const warn = (lab) => (lab === "Energy" && e.energy[1] > e.energy[0]) || (lab === "Water" && e.water[1] > e.water[0]) ? ' class="dg-bad"' : "";
      return rows.map(([a, b]) => `<span>${a}</span><b${warn(a)}>${b}</b>`).join("") +
        `<span class="sc">City score</span><b class="sc dg-gold">${(e.score10 / 10).toFixed(1)}</b><span class="parts">= People ${e.parts.people.toFixed(1)} + Money ${e.parts.money.toFixed(1)} + Growth ${e.parts.growth.toFixed(1)}</span>`;
    }
    let lastScore = null;
    function refresh() {
      ev = cityEval(map, plan);
      $("budget").textContent = "$" + U.fmt(ev.left);
      $("pop").textContent = U.fmt(ev.population);
      $("hap").textContent = pct(ev.happiness);
      $("score").textContent = (ev.score10 / 10).toFixed(1);
      $("stats").innerHTML = statsHtml(ev);
      ctx.root.querySelectorAll("[data-tool]").forEach((b) => { const B = BLD[b.dataset.tool]; b.classList.toggle("poor", !!B && B.cost > ev.left); });
      const ub = $("undo"); if (ub) ub.disabled = phase !== "build" || !moves.length;
      renderTiles();
      if (lastScore !== ev.score10) { lastScore = ev.score10; ctx.progress(ev.score10 / 10); }
    }
    function setTool(t) {
      tool = t; pending = -1;
      ctx.root.querySelectorAll("[data-tool]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.tool === t)));
      $("info").innerHTML = t === "bulldoze" ? "<b>Bulldoze</b> · tap a building to remove it for a full refund." :
        `<b>${BLD[t].name}</b> · <span class="dg-gold dg-mono">$${U.fmt(BLD[t].cost)}</span><br>${BLD[t].desc}<br><span class="dg-note">${cityFacts(t)}</span>`;
      renderTiles();
    }
    function tap(i) {
      if (phase !== "build" || ctx.signal.ended) return;
      if (tool === "bulldoze") {
        if (!plan[i]) { say("Nothing to bulldoze there.", "bad"); return; }
        const k = plan[i]; plan[i] = null; moves.push(["x", i, k]);
        say(`${BLD[k].name} removed, $${U.fmt(BLD[k].cost)} refunded.`, "good"); refresh(); return;
      }
      if (plan[i]) { say(`${BLD[plan[i]].name} is here. Bulldoze it first.`, ""); return; }
      const why = cityCanPlace(map, plan, i, tool);
      if (why) { say(why + ".", "bad"); pending = -1; renderTiles(); return; }
      const B = BLD[tool];
      pending = -1;
      const before = ev.score10;
      plan[i] = tool; moves.push(["b", i, tool]);
      refresh();
      const d = (ev.score10 - before) / 10;
      say(`${B.name} built. Score ${d >= 0 ? "+" : ""}${d.toFixed(1)}.`, d >= 0 ? "good" : "bad");
    }
    tiles.forEach((el, i) => {
      el.addEventListener("pointerdown", (e) => { lastPtr = e.pointerType || "mouse"; });
      el.addEventListener("click", () => tap(i));
      el.addEventListener("pointerenter", () => { hoverI = i; renderTiles(); });
      el.addEventListener("pointerleave", () => { if (hoverI === i) { hoverI = -1; renderTiles(); } });
    });
    ctx.root.querySelectorAll("[data-tool]").forEach((b) => b.addEventListener("click", () => setTool(b.dataset.tool)));
    $("finish").addEventListener("click", () => finish());
    $("undo").addEventListener("click", () => undo());
    function undo() {
      if (phase !== "build" || !moves.length) return;
      const m = moves.pop();
      if (m[0] === "b") { plan[m[1]] = null; say(`Undid ${BLD[m[2]].name}.`, ""); }
      else { plan[m[1]] = m[2]; say(`Restored ${BLD[m[2]].name}.`, ""); }
      refresh();
    }
    ctx.onKey((e) => {
      if (phase !== "build") return;
      const k = e.key.toUpperCase();
      const t = BLD_ORDER.find((q) => BLD[q].key === k);
      if ((e.ctrlKey || e.metaKey) && k === "Z") { e.preventDefault(); undo(); return; }
      if (t) setTool(t); else if (k === "B" || k === "DELETE") setTool("bulldoze");
    });
    const t0 = ctx.now();
    ctx.interval(() => {
      if (phase !== "build") return;
      const left = cfg.buildMs - (ctx.now() - t0);
      ctx.setStatus("Build · " + mmss(left));
      if (left <= 0) finish();
    }, 250);

    function finish(instant) {
      if (phase !== "build") return;
      phase = "sim"; pending = -1; hoverI = -1;
      const e = cityEval(map, plan), score = e.score10 / 10;
      ctx.root.querySelectorAll("button").forEach((b) => (b.disabled = true));
      say("", "");
      $("phase").textContent = "Simulating a year…";
      ctx.setStatus("Simulating");
      const metrics = [
        ["Population", (v) => U.fmt(v), e.population], ["Happiness", (v) => pct(v), e.happiness], ["Revenue", (v) => money(v) + "/day", e.revenue],
        ["Traffic", (v) => pct(v), e.trafficPct], ["Crime", (v) => pct(v), e.crimePct], ["Pollution", (v) => pct(v), e.pollutionPct],
        ["Energy", (v) => `${Math.round(v)} / ${e.energy[1]}`, e.energy[0]], ["Employment", (v) => pct(v), e.employment * 100],
        ["Growth", (v) => (v >= 0 ? "+" : "") + v.toFixed(1) + "%/yr", e.growth],
      ];
      $("result").innerHTML = `<div class="${P}-res"><div class="${P}-bar"><div class="dg-eyebrow" data-test="rep-title">Simulating a year…</div><div class="${P}-prog"><i data-test="simbar"></i></div></div>
        <div class="${P}-rep">${metrics.map((m, k) => `<div><span>${m[0]}</span><b data-m="${k}">${m[1](m[2])}</b></div>`).join("")}</div>
        <div class="${P}-big" data-test="final">${score.toFixed(1)}<small>city score</small></div>
        <p class="dg-note" style="margin:0">People ${e.parts.people.toFixed(1)} (population × (happiness + 15) ÷ 690) + Money ${e.parts.money.toFixed(1)} (revenue ÷ 40) + Growth ${e.parts.growth.toFixed(1)} (growth × 3, or × 1 if shrinking).</p></div>`;
      const built = tiles.map((_, i) => i).filter((i) => plan[i]);
      // Only the reveal animates. Every number above is the exact final value from the first frame, identical to the HUD.
      const paint = (t) => {
        const bar = $("simbar"); if (bar) bar.style.width = Math.round(t * 100) + "%";
        built.forEach((i, k) => tiles[i].classList.toggle("glow", t < 1 && Math.abs(k / Math.max(1, built.length) - t) < 0.15));
        if (t >= 1) { const ti = $("rep-title"); if (ti) ti.textContent = "City report"; }
      };
      const done = () => {
        paint(1);
        $("phase").textContent = "Final city";
        ctx.setStatus("Final · " + score.toFixed(1));
        ctx.progress(score);
        const detail = `<p class="dg-note">Population ${U.fmt(e.population)}, happiness ${pct(e.happiness)}, revenue ${money(e.revenue)}/day, growth ${e.growth.toFixed(1)}%/yr.</p>`;
        ctx.timeout(() => ctx.end({ score, detail }), 700);
      };
      if (ctx.reducedMotion || instant) { done(); return; }
      const DUR = ctx.mode === "mix" ? 3000 : 3600, s0 = ctx.now();
      const step = (now) => { const t = Math.min(1, (now - s0) / DUR); if (t >= 1) { done(); return; } paint(t); ctx.raf(step); };
      paint(0); ctx.raf(step);
    }
    setTool("res");
    refresh();
    say(`Budget $${U.fmt(map.budget)}. Homes need jobs, power, water and nearby services.`, "");
    ctx.setStatus("Build · " + mmss(cfg.buildMs));
    ctx.test = {
      state: () => ({ phase, plan: plan.slice(), eval: cityEval(map, plan), tiles: map.tiles.slice(), n, moves: moves.slice(),
        hud: $("score").textContent, report: $("final") ? parseFloat($("final").textContent) : null }),
      undo,
      place(i, t) { setTool(t); tap(i); return plan[i] === t; },
      autoBuild(skill) {
        if (phase !== "build") return 0;
        for (let i = 0; i < plan.length; i++) plan[i] = null;
        const r = cityPlan(map, U.rng("ui-city:" + ctx.seed + ":" + skill), skill == null ? 0.9 : skill);
        r.plan.forEach((k, i) => { plan[i] = k; });
        refresh();
        return r.score10 / 10;
      },
      finish: (instant) => finish(instant !== false),
      score: () => cityEval(map, plan).score10 / 10,
    };
  }
  function CITY_RULES(mode) {
    const c = cityConfig(mode);
    return [
      `Same ${c.n}×${c.n} plot for everyone, $${U.fmt(c.budget)} budget, ${c.buildMs / 1000} s. Bulldoze refunds in full.`,
      `Homes are the heart: each home's happiness (number on the tile) comes from parks, hospital, school, police and shops in reach, minus pollution, crime, traffic and unemployment.`,
      `Everything needs energy and water. Shortages hit every building.`,
      `Half of residents want jobs: shops, factories and services employ them and pay taxes.`,
      `City score = People (population × happiness) + Money (daily revenue) + Growth. Mixed cities beat any single-building spam.`,
    ];
  }

  /* ====================================================================================
     RESTAURANT DUEL — play
     ==================================================================================== */
  function restFix(plan) {
    const q = JSON.parse(JSON.stringify(plan));
    for (const d of ["soup", "tacos", "salad", "burger", "pasta"]) if (q.menu.length < 3 && !q.menu.includes(d)) q.menu.push(d);
    if (q.menu.length > 5) q.menu = q.menu.slice(0, 5);
    q.chefs = clamp(q.chefs, 1, KITCHEN[q.kitchen].maxChefs);
    let guard = 0;
    while (restSpend(q) > 10000 && guard++ < 200) {
      if (q.marketing > 0) q.marketing = Math.max(0, q.marketing - 250);
      else if (q.tables > 4) q.tables--;
      else if (q.waiters > 1) q.waiters--;
      else if (q.chefs > 1) q.chefs--;
      else if (q.kitchen > 0) q.kitchen--;
      else break;
    }
    return q;
  }
  const hhmm = (m) => { const t = DAY_OPEN + Math.round(m); return String(Math.floor(t / 60) % 24).padStart(2, "0") + ":" + String(t % 60).padStart(2, "0"); };
  function restaurantPlay(ctx) {
    const P = "g-restaurant";
    DG.css("restaurant", packCss(P) + `
      .g-restaurant-sec{background:var(--panel);border:1px solid var(--line);border-radius:var(--r-md);padding:10px 12px;display:grid;gap:8px}
      .g-restaurant{--side:320px}
      .g-restaurant-row{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:10px}
      .g-restaurant-row label{font-weight:600;font-size:14px}
      .g-restaurant-row .dg-note{display:block;font-weight:400}
      .g-restaurant-step{display:flex;align-items:center;gap:6px}
      .g-restaurant-step button{width:40px;height:40px;border-radius:8px;border:1px solid var(--line);background:var(--panel-2);font-size:20px;font-weight:700;line-height:1}
      .g-restaurant-step button:hover:not(:disabled){background:var(--panel-3)}
      .g-restaurant-step button:disabled{opacity:.35;cursor:not-allowed}
      .g-restaurant-step b{font-family:var(--f-mono);min-width:56px;text-align:center;font-size:16px}
      .g-restaurant-chips{display:grid;grid-template-columns:repeat(auto-fill,minmax(128px,1fr));gap:6px}
      .g-restaurant-chip{background:var(--panel-2);border:1px solid var(--line);border-radius:var(--r-sm);padding:6px 9px;text-align:left;min-height:44px;line-height:1.2}
      .g-restaurant-chip b{display:block;font-size:13px}
      .g-restaurant-chip small{font-family:var(--f-mono);font-size:11.5px;color:var(--muted)}
      .g-restaurant-chip[aria-pressed="true"]{border-color:var(--gold);background:color-mix(in srgb,var(--gold) 14%,var(--panel-2))}
      .g-restaurant-chip[aria-pressed="true"] small{color:var(--gold)}
      .g-restaurant-chip:disabled{opacity:.4;cursor:not-allowed}
      .g-restaurant-meter{height:8px;border-radius:4px;background:var(--panel-2);overflow:hidden}
      .g-restaurant-meter i{display:block;height:100%;background:var(--gold)}
      .g-restaurant-hist{display:flex;align-items:flex-end;gap:2px;height:54px}
      .g-restaurant-hist i{flex:1;background:color-mix(in srgb,var(--ally) 60%,var(--panel-2));border-radius:2px 2px 0 0;min-height:2px}
      .g-restaurant-axis{display:flex;justify-content:space-between;font-size:11px;color:var(--muted);font-family:var(--f-mono)}
      .g-restaurant-kv{display:grid;grid-template-columns:1fr auto;gap:2px 10px;font-size:13px}
      .g-restaurant-kv span{color:var(--muted)} .g-restaurant-kv b{font-family:var(--f-mono);font-weight:600;text-align:right}
      .g-restaurant-day{display:flex;align-items:flex-end;gap:1px;height:90px;border-bottom:1px solid var(--line)}
      .g-restaurant-day i{flex:1;background:var(--gold);opacity:.85;min-height:1px}
      .g-restaurant-day i.q{background:var(--bad)}
      .g-restaurant-live{display:grid;grid-template-columns:repeat(auto-fit,minmax(90px,1fr));gap:8px}
      .g-restaurant-live div{background:var(--panel-2);border:1px solid var(--line);border-radius:var(--r-sm);padding:6px 10px}
      .g-restaurant-live span{display:block;font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:var(--muted);font-weight:600}
      .g-restaurant-live b{font-family:var(--f-mono);font-size:18px}
      .g-restaurant-pop{font-size:12px;color:var(--muted);min-height:32px}
      .g-restaurant-sec{padding:8px 10px;gap:8px}
      .g-restaurant-kit{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:4px}
      .g-restaurant-kit .g-restaurant-chip{padding:4px 6px;min-height:40px;overflow:hidden}
      .g-restaurant-kit b{font-size:12.5px}
      .g-restaurant-kit small{font-size:10.5px;overflow-wrap:anywhere}
      .g-restaurant-grid2{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px 10px}
      @container (min-width:560px){.g-restaurant-grid2{grid-template-columns:repeat(3,minmax(0,1fr))}}
      .g-restaurant-st{display:grid;gap:2px}
      .g-restaurant-stl{display:flex;gap:6px;align-items:baseline;font-size:13px;white-space:nowrap;overflow:hidden}
      .g-restaurant-stl span{font-size:11px;color:var(--muted);overflow:hidden;text-overflow:ellipsis}
      .g-restaurant-st .g-restaurant-step{gap:2px}
      .g-restaurant-st .g-restaurant-step button{width:38px;height:38px;flex:none}
      .g-restaurant-st .g-restaurant-step b{flex:1;min-width:0;font-size:15px}
      .g-restaurant-dishes{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:4px}
      @container (min-width:560px){.g-restaurant-dishes{grid-template-columns:repeat(3,minmax(0,1fr))}}
      .g-restaurant-dish{display:grid;grid-template-columns:auto minmax(0,1fr);grid-template-rows:auto auto;column-gap:6px;align-items:center;text-align:left;min-height:40px;padding:3px 7px;background:var(--panel-2);border:1px solid var(--line);border-radius:var(--r-sm);line-height:1.15}
      .g-restaurant-dish i{grid-row:1/3;width:14px;height:14px;border-radius:4px;border:2px solid var(--muted)}
      .g-restaurant-dish b{font-size:12.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .g-restaurant-dish small{font-family:var(--f-mono);font-size:10.5px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .g-restaurant-dish[aria-pressed="true"]{border-color:var(--gold);background:color-mix(in srgb,var(--gold) 14%,var(--panel-2))}
      .g-restaurant-dish[aria-pressed="true"] i{background:var(--gold);border-color:var(--gold)}
      .g-restaurant-dish[aria-pressed="true"] small{color:var(--gold)}
      .g-restaurant-dish:disabled{opacity:.4;cursor:not-allowed}
      .g-restaurant-fc summary{display:flex;gap:8px;align-items:baseline;flex-wrap:wrap}
      .g-restaurant-fcs{font-size:12.5px;color:var(--fg);font-weight:500}
      .g-restaurant .g-restaurant-hud{gap:6px}
      .g-restaurant .g-restaurant-stat{padding:4px 8px}
      .g-restaurant .g-restaurant-stat b{font-size:16px}
      .g-restaurant-kv{gap:1px 10px}
    `);
    const day = restDay(ctx.seed), cfg = restConfig(ctx.mode);
    let plan = restDefaultPlan(), phase = "plan", lastDish = null;
    const budget = cfg.budget;
    const typeTop = (d) => CT_ORDER.slice().sort((a, b) => DISHES[d].pop[b] - DISHES[d].pop[a]).slice(0, 2).map((k) => CTYPES[k].name).join(", ");
    const hours = new Array(12).fill(0);
    for (const p of day.parties) hours[Math.min(11, Math.floor(p.t / 60))]++;
    const hmax = Math.max(...hours);
    const stepper = (key, label, note) => `<div class="${P}-st"><div class="${P}-stl"><b>${label}</b><span>${note}</span></div>
      <div class="${P}-step"><button data-dec="${key}" data-test="${key}-dec" aria-label="Less ${label}">−</button><b data-test="${key}"></b><button data-inc="${key}" data-test="${key}-inc" aria-label="More ${label}">+</button></div></div>`;
    const topMix = day.mix.slice().sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => `${CTYPES[k].name} ${v}%`).join(" · ");
    ctx.root.innerHTML = `<div class="${P}">
      <div class="${P}-hud">${stat(P, "Budget left", "budget")}${stat(P, "Proj. profit", "profit")}${stat(P, "Proj. reviews", "stars")}${stat(P, "Proj. score", "score", true)}</div>
      <div data-test="result"></div>
      <div class="${P}-main" data-test="planner">
        <div class="${P}-col">
          <details class="${P}-fc" data-test="forecast"><summary><span class="dg-eyebrow">Forecast</span> <span class="${P}-fcs">${topMix} · peaks 12:00 and 19:00</span></summary>
            <table class="dg-table"><thead><tr><th>Guests</th><th class="num">Share</th><th class="num">Spend</th><th class="num">Party</th></tr></thead><tbody>
            ${day.mix.map(([k, v]) => `<tr><td>${CTYPES[k].name}<br><span class="dg-note">${CTYPES[k].sens >= 1 ? "price-sensitive" : CTYPES[k].sens <= 0.5 ? "pays for quality" : "average"} · waits ${Math.round((CTYPES[k].patience[0] + CTYPES[k].patience[1]) / 2)}′</span></td><td class="num">${v}%</td><td class="num">$${CTYPES[k].budget}</td><td class="num">${CTYPES[k].size[0]}–${CTYPES[k].size[1]}</td></tr>`).join("")}
            </tbody></table>
            <div class="dg-eyebrow">Arrivals by hour</div>
            <div class="${P}-hist">${hours.map((h) => `<i style="height:${Math.round((h / hmax) * 100)}%" title="${h} groups"></i>`).join("")}</div>
            <div class="${P}-axis"><span>11:00</span><span>17:00</span><span>23:00</span></div>
          </details>
          <div class="${P}-sec"><div class="dg-eyebrow">Kitchen · seats · staff</div><div class="${P}-kit">${KITCHEN.map((k, i) => `<button class="${P}-chip" data-kitchen="${i}" data-test="kitchen-${i}"><b>${k.name}</b><small>$${U.fmt(k.cost)}</small><small>×${k.speed} · ${k.maxChefs} chefs</small></button>`).join("")}</div>
            <div class="${P}-grid2">
              ${stepper("tables", "Tables", "4 seats · $" + RCOST.table)}
              ${stepper("chefs", "Chefs", "$" + RCOST.chef + " each")}
              ${stepper("waiters", "Waiters", "$" + RCOST.waiter + " each")}
              ${stepper("price", "Prices", "× menu price")}
              ${stepper("marketing", "Marketing", "draws guests")}
            </div>
          </div>
          <div class="${P}-sec"><div class="dg-eyebrow">Menu · 3–5 dishes · $${RCOST.dish} setup each</div>
            <div class="${P}-dishes" data-test="menu">${DISH_ORDER.map((d) => `<button class="${P}-dish" data-dish="${d}" data-test="dish-${d}"><i></i><b>${DISHES[d].name}</b><small data-price="${d}"></small></button>`).join("")}</div>
            <div class="${P}-pop" data-test="dishinfo">Tap a dish to add or remove it and see who likes it.</div>
          </div>
          <div class="${P}-bar"><span class="${P}-msg" data-test="msg"></span><button class="dg-btn primary" data-test="open">Open for the day</button></div>
        </div>
        <div class="${P}-col">
          <div class="${P}-sec"><div class="dg-eyebrow">Projection</div><div class="${P}-kv" data-test="proj"></div></div>
          <details><summary>Rules</summary><ul class="${P}-rules">${REST_RULES(ctx.mode).map((r) => `<li>${r}</li>`).join("")}</ul></details>
        </div>
      </div></div>`;
    const $ = (t) => ctx.root.querySelector(`[data-test="${t}"]`);
    const say = makeSay($("msg"), P);
    const LIM = { tables: [2, 24, 1], chefs: [1, 6, 1], waiters: [1, 6, 1], price: [0.7, 1.6, 0.05], marketing: [0, 3000, 250] };
    function tryPlan(q) {
      const why = restValid(q, budget);
      if (why && why !== "Pick at least 3 dishes") return why;
      plan = q; refresh(); return "";
    }
    function bump(key, dir) {
      if (phase !== "plan") return;
      const [lo, hi, st] = LIM[key];
      const q = JSON.parse(JSON.stringify(plan));
      q[key] = Math.round(clamp(q[key] + dir * st, lo, hi) * 100) / 100;
      if (key === "chefs" && q.chefs > KITCHEN[q.kitchen].maxChefs) { say(`${KITCHEN[q.kitchen].name} kitchen fits ${KITCHEN[q.kitchen].maxChefs} chefs. Upgrade the kitchen.`, "bad"); return; }
      const why = tryPlan(q);
      say(why ? why + "." : "", why ? "bad" : "");
    }
    let lastProj = null;
    function refresh() {
      const spend = restSpend(plan), left = budget - spend;
      $("budget").textContent = money(left);
      ctx.root.querySelectorAll("[data-kitchen]").forEach((b) => {
        const i = +b.dataset.kitchen;
        b.setAttribute("aria-pressed", String(plan.kitchen === i));
        const q = Object.assign({}, plan, { kitchen: i, chefs: Math.min(plan.chefs, KITCHEN[i].maxChefs) });
        b.disabled = phase !== "plan" || restSpend(q) > budget;
      });
      for (const k of Object.keys(LIM)) {
        $(k).textContent = k === "price" ? "×" + plan.price.toFixed(2) : k === "marketing" ? "$" + U.fmt(plan.marketing) : String(plan[k]);
        const [lo, hi, st] = LIM[k];
        const up = Object.assign({}, plan, { [k]: plan[k] + st });
        $(k + "-dec").disabled = phase !== "plan" || plan[k] <= lo + 1e-9;
        $(k + "-inc").disabled = phase !== "plan" || plan[k] >= hi - 1e-9 || restSpend(up) > budget || (k === "chefs" && plan.chefs >= KITCHEN[plan.kitchen].maxChefs);
      }
      ctx.root.querySelectorAll("[data-dish]").forEach((b) => {
        const d = b.dataset.dish, on = plan.menu.includes(d);
        b.setAttribute("aria-pressed", String(on));
        b.disabled = phase !== "plan" || (!on && (plan.menu.length >= 5 || left < RCOST.dish));
        ctx.root.querySelector(`[data-price="${d}"]`).textContent = `$${(DISHES[d].price * plan.price).toFixed(0)} · ${DISHES[d].prep}′ · cost $${DISHES[d].cost}`;
      });
      const valid = !restValid(plan, budget);
      $("open").disabled = phase !== "plan" || !valid;
      const r = restSim(day, plan);
      const kv = [
        ["Visit / served", `${r.visitors} / ${r.served} groups`],
        ["Left: wait / menu", `${r.lostWait} / ${r.lostMenu}`],
        ["Revenue", money(r.revenue)], ["Costs", money(r.cogs + r.wages + r.depreciation + r.menuCost + r.marketing)],
        ["Profit", money(r.profit)], ["Reviews", r.stars.toFixed(1) + " / 5 → " + (r.repBonus >= 0 ? "+" : "") + U.fmt(r.repBonus)],
      ];
      $("proj").innerHTML = valid ? kv.map(([a, b]) => `<span>${a}</span><b>${b}</b>`).join("") + `<span>Score</span><b class="dg-gold">${U.fmt(r.score)}</b>` : `<span>${restValid(plan, budget)}</span><b></b>`;
      $("profit").textContent = valid ? money(r.profit) : "–";
      $("stars").textContent = valid ? r.stars.toFixed(1) + "/5" : "–";
      $("score").textContent = valid ? U.fmt(r.score) : "–";
      if (valid && lastProj !== r.score) { lastProj = r.score; ctx.progress(r.score); }
      if (lastDish) {
        const D = DISHES[lastDish];
        $("dishinfo").innerHTML = `<b style="color:var(--fg)">${D.name}</b>: sells for $${(D.price * plan.price).toFixed(0)}, ingredients $${D.cost}, ${D.prep} min to cook. Popular with ${typeTop(lastDish)}.`;
      }
    }
    ctx.root.querySelectorAll("[data-kitchen]").forEach((b) => b.addEventListener("click", () => {
      if (phase !== "plan") return;
      const i = +b.dataset.kitchen;
      const q = Object.assign({}, plan, { kitchen: i, chefs: Math.min(plan.chefs, KITCHEN[i].maxChefs) });
      const why = tryPlan(q); say(why ? why + "." : `${KITCHEN[i].name} kitchen selected.`, why ? "bad" : "");
    }));
    ctx.root.querySelectorAll("[data-dec]").forEach((b) => b.addEventListener("click", () => bump(b.dataset.dec, -1)));
    ctx.root.querySelectorAll("[data-inc]").forEach((b) => b.addEventListener("click", () => bump(b.dataset.inc, 1)));
    ctx.root.querySelectorAll("[data-dish]").forEach((b) => b.addEventListener("click", () => {
      if (phase !== "plan") return;
      const d = b.dataset.dish;
      lastDish = d;
      const q = JSON.parse(JSON.stringify(plan));
      if (q.menu.includes(d)) q.menu = q.menu.filter((x) => x !== d); else q.menu.push(d);
      const why = tryPlan(q);
      say(why ? why + "." : q.menu.length < 3 ? "Pick at least 3 dishes." : "", why || q.menu.length < 3 ? "bad" : "");
    }));
    $("open").addEventListener("click", () => openDay());
    const t0 = ctx.now();
    ctx.interval(() => {
      if (phase !== "plan") return;
      const left = cfg.planMs - (ctx.now() - t0);
      ctx.setStatus("Plan · " + mmss(left));
      if (left <= 0) { plan = restFix(plan); openDay(); }
    }, 250);

    function openDay(instant) {
      if (phase !== "plan") return;
      if (restValid(plan, budget)) { say(restValid(plan, budget) + ".", "bad"); return; }
      phase = "sim";
      refresh();
      const r = restSim(day, plan, true);
      ctx.setStatus("Service");
      $("planner").style.display = "none";
      const cap = plan.tables * 4, tr = r.trace;
      const qmax = Math.max(1, ...tr.map((x) => x.queue));
      $("result").innerHTML = `<div class="${P}-res" data-test="day">
        <div class="${P}-bar"><div class="dg-eyebrow">Service · ${plan.tables} tables, ${plan.chefs} chefs, ${plan.waiters} waiters</div><b class="dg-mono" data-test="clock">11:00</b></div>
        <div class="${P}-live"><div><span>Seated</span><b data-l="seated">0</b></div><div><span>Queue</span><b data-l="queue">0</b></div><div><span>Served</span><b data-l="served">0</b></div><div><span>Left unhappy</span><b data-l="left">0</b></div></div>
        <div class="${P}-day" data-test="daychart">${tr.map(() => "<i></i>").join("")}</div>
        <div class="${P}-axis"><span>11:00</span><span>17:00</span><span>23:00</span></div>
        <div data-test="pnl"></div></div>`;
      const bars = [...ctx.root.querySelectorAll(`.${P}-day i`)];
      const paint = (t) => {
        const k = Math.min(tr.length - 1, Math.floor(t * (tr.length - 1)));
        const x = tr[k];
        $("clock").textContent = hhmm(x.m);
        for (const key of ["seated", "queue", "served", "left"]) ctx.root.querySelector(`[data-l="${key}"]`).textContent = x[key];
        bars.forEach((b, j) => {
          if (j > k) { b.style.height = "0"; return; }
          const y = tr[j];
          b.style.height = Math.round(Math.min(1, y.seated / cap) * 100) + "%";
          b.className = y.queue > 0 && y.queue >= qmax * 0.5 ? "q" : "";
        });
      };
      const done = () => {
        paint(1);
        const rows = [
          ["Revenue (food, drinks, tips)", r.revenue], ["Ingredients", -r.cogs], ["Wages", -r.wages],
          [`Kitchen and tables (${Math.round(DEPR * 100)}% of $${U.fmt(KITCHEN[plan.kitchen].cost + plan.tables * RCOST.table)})`, -r.depreciation],
          ["Menu setup", -r.menuCost], ["Marketing", -r.marketing],
        ];
        const pnl = `<table class="dg-table"><tbody>${rows.map(([a, v]) => `<tr><td>${a}</td><td class="num ${v < 0 ? "dg-bad" : ""}">${money(v)}</td></tr>`).join("")}
          <tr class="tot"><td>Profit</td><td class="num ${r.profit < 0 ? "dg-bad" : "dg-good"}">${money(r.profit)}</td></tr>
          <tr><td>Reputation (${r.stars.toFixed(1)} / 5 from ${r.served + r.unhappy} reviews)</td><td class="num">${r.repBonus >= 0 ? "+" : ""}${U.fmt(r.repBonus)}</td></tr>
          <tr><td>Base</td><td class="num">5,000</td></tr>
          <tr class="tot"><td>Score</td><td class="num dg-gold">${U.fmt(r.score)}</td></tr></tbody></table>`;
        $("pnl").innerHTML = `<div class="${P}-big" data-test="final">${U.fmt(r.score)}<small>points · ${r.served} groups served · ${r.unhappy} left unhappy · ${r.walked} never came</small></div>${pnl}`;
        ctx.setStatus("Final · " + U.fmt(r.score));
        ctx.progress(r.score);
        ctx.timeout(() => ctx.end({ score: r.score, detail: `<p class="dg-note">Profit ${money(r.profit)}, reviews ${r.stars.toFixed(1)}/5, ${r.served} groups served.</p>` }), 700);
      };
      if (ctx.reducedMotion || instant) { done(); return; }
      const s0 = ctx.now();
      const step = (now) => { const t = Math.min(1, (now - s0) / cfg.simMs); if (t >= 1) { done(); return; } paint(t); ctx.raf(step); };
      paint(0); ctx.raf(step);
    }
    refresh();
    say(`$${U.fmt(budget)} to set up. The projection updates as you plan.`, "");
    ctx.setStatus("Plan · " + mmss(cfg.planMs));
    ctx.test = {
      state: () => ({ phase, plan: JSON.parse(JSON.stringify(plan)), proj: restSim(day, plan), spend: restSpend(plan) }),
      setPlan(obj) { if (phase !== "plan") return "not planning"; const q = Object.assign(JSON.parse(JSON.stringify(plan)), JSON.parse(JSON.stringify(obj))); const why = restValid(q, budget); if (why) return why; plan = q; refresh(); return ""; },
      optimise(skill) { const r = restOptimise(day, U.rng("ui-rest:" + ctx.seed + ":" + skill), skill, 400); plan = r.plan; refresh(); return r.score; },
      finish: (instant) => openDay(instant !== false),
    };
  }
  function REST_RULES(mode) {
    const c = restConfig(mode);
    return [
      `Everyone gets the same $10,000 and the same seeded day of 100 groups (${c.planMs / 1000} s to plan).`,
      `Groups come if your menu, prices and marketing appeal to them, then leave if they wait longer than their patience.`,
      `Tables seat 4. Chefs cook one order at a time; bigger kitchens cook faster and fit more chefs. Waiters take orders, serve and bill.`,
      `Profit = revenue − ingredients − wages − menu setup − marketing − 35% of kitchen and table cost.`,
      `Score = 5,000 + profit + reputation bonus (±900 per review star above or below 3). Never below 0.`,
    ];
  }

  /* ====================================================================================
     Registration
     ==================================================================================== */
  DG.registerGame({
    id: "base", name: "Base Duel", category: "battle", kind: "race", formats: FORMATS.slice(),
    skill: 9, luck: 1, cashEligible: true, duration: "up to 5 min (mix 45 s)", pack: "builder", // 60 s build + 8 capped waves (~22 s) + 5 s gaps ≈ 4.5 min
    blurb: "Build a base on a fixed budget, then hold it against the same zombie waves as your rival.",
    rules: [
      "Build phase: spend a fixed gold budget on walls, towers, spike traps and gold mines. Sell for a full refund until the first wave starts.",
      "Zombies take the shortest path to your core; towers and walls reroute them, but you can never seal it.",
      "Identical seeded waves: Walkers, fast Runners, armoured wall-smashing Brutes and tower-spitting Spitters.",
      "During waves, throw Firebombs. Repair damaged structures at any time. Between waves, spend gold from kills and mines.",
      "Score = 1,000 per wave survived + 5 × base HP + 10 per kill + unspent gold ÷ 10.",
    ],
    scoreLabel: "points", formatScore: (n) => U.fmt(n),
    play: basePlay,
    bot: (seed, skill, rng, mode) => baseBot(seed, skill, rng, mode === "mix" ? "mix" : "full"),
    _lab: BASE_LAB,
  });
  DG.registerGame({
    id: "city", name: "City Duel", category: "builder", kind: "race", formats: FORMATS.slice(),
    skill: 9, luck: 0, cashEligible: true, duration: "95 s (mix 40 s)", pack: "builder",
    blurb: "Same plot, same budget: zone homes, jobs, power and services into the happiest, richest city.",
    rules: [
      "Everyone builds on the same seeded plot with the same budget. Bulldozing refunds in full.",
      "Homes need jobs, energy and water; parks, schools, hospitals, police and shops nearby make them happy.",
      "Factories and power plants pollute nearby homes; transit cuts traffic; police cut crime.",
      "Watch the live projection: every placement changes the score.",
      "City score = people (population × happiness) + money (daily revenue) + growth.",
    ],
    scoreLabel: "city pts", formatScore: (n) => (Math.round(n * 10) / 10).toFixed(1),
    play: cityPlay,
    bot: (seed, skill, rng, mode) => cityBot(seed, skill, rng, mode === "mix" ? "mix" : "full"),
    _lab: CITY_LAB,
  });
  DG.registerGame({
    id: "restaurant", name: "Restaurant Duel", category: "builder", kind: "race", formats: FORMATS.slice(),
    skill: 8, luck: 1, cashEligible: true, duration: "65 s (mix 35 s)", pack: "builder",
    blurb: "Same $10,000, same 100 customers: set up the kitchen, staff, menu and prices for the best day.",
    rules: [
      "You and your rival get the same budget and the same seeded day of 100 customer groups.",
      "Choose kitchen, tables, chefs, waiters, a 3–5 dish menu, a price level and marketing.",
      "Read the forecast: each customer type likes different dishes, pays differently and waits differently.",
      "Then the day plays out: slow service and bad menus send people away unhappy.",
      "Score = 5,000 + profit + reputation bonus.",
    ],
    scoreLabel: "points", formatScore: (n) => U.fmt(n),
    play: restaurantPlay,
    bot: (seed, skill, rng, mode) => restBot(seed, skill, rng, mode === "mix" ? "mix" : "full"),
    _lab: REST_LAB,
  });
})();
