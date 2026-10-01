/* Duel.gold — Pack C: REFLEX & PRECISION
   Games: reaction (Reaction Duel), aim (Aim Duel), rush (Number Rush), darts (Darts Nine), hockey (Air Hockey).
   All content comes from the match seed; bots replay the same seeded content with skill-scaled behaviour. */
(function () {
  "use strict";
  const U = DG.util;
  const ALL = ["1v1", "2v2", "ffa", "tournament", "mix"];
  const clamp = U.clamp;
  const r2 = (n) => Math.round(n * 100) / 100;
  const TAU = Math.PI * 2;

  /* ---------- shared helpers ---------- */
  function tokens(el) {
    const cs = getComputedStyle(el);
    const v = (n, d) => (cs.getPropertyValue(n) || "").trim() || d;
    return {
      ink: v("--ink", "#10111F"), panel: v("--panel", "#181A2E"), panel2: v("--panel-2", "#212440"),
      panel3: v("--panel-3", "#2A2E52"), line: v("--line", "#30345A"), fg: v("--fg", "#EEEAF7"),
      muted: v("--muted", "#9D9BC0"), gold: v("--gold", "#F2C14E"), goldDeep: v("--gold-deep", "#B9892B"),
      onGold: v("--on-gold", "#1A1406"), rival: v("--rival", "#FF6275"), ally: v("--ally", "#6FC3FF"),
      good: v("--good", "#5AD690"), bad: v("--bad", "#FF6275"), warn: v("--warn", "#FFB35C"),
      mono: v("--f-mono", "monospace"), display: v("--f-display", "sans-serif"), body: v("--f-body", "sans-serif"),
    };
  }
  function statusSetter(ctx) {
    let last = null;
    return (t) => { if (t !== last) { last = t; ctx.setStatus(t); } };
  }
  function mmss(sec) {
    sec = Math.max(0, Math.ceil(sec));
    return Math.floor(sec / 60) + ":" + String(sec % 60).padStart(2, "0");
  }
  function finishTimeline(tl, score, endT) {
    const out = [];
    let lastT = 0;
    for (const [t, s] of tl) { const tt = Math.max(lastT, r2(t)); out.push([tt, s]); lastT = tt; }
    if (!out.length || out[out.length - 1][1] !== score || (endT != null && endT > lastT)) out.push([Math.max(lastT, r2(endT != null ? endT : lastT)), score]);
    return out;
  }

  /* Canvas sized to its host width, DPR-aware, re-laid-out on host resize (observer self-disconnects on end). */
  function canvasView(ctx, host, layout) {
    const cv = document.createElement("canvas");
    cv.style.cssText = "display:block;touch-action:none;max-width:100%;margin:0 auto;user-select:none;-webkit-user-select:none";
    host.style.minWidth = "0";
    host.appendChild(cv);
    const g = cv.getContext("2d");
    const view = { cv, g, lw: 1, lh: 1, scale: 1, dpr: 1, cssW: 1, cssH: 1, meta: {}, onFit: null };
    let lastW = -1;
    function fit() {
      const cw = Math.max(240, Math.min(860, host.clientWidth || 320));
      lastW = host.clientWidth;
      const L = layout(cw);
      const dpr = Math.min(3, window.devicePixelRatio || 1);
      Object.assign(view, { lw: L.lw, lh: L.lh, cssW: L.cssW, cssH: L.cssH, scale: L.cssW / L.lw, dpr, meta: L });
      cv.style.width = L.cssW + "px"; cv.style.height = L.cssH + "px";
      cv.width = Math.round(L.cssW * dpr); cv.height = Math.round(L.cssH * dpr);
      layer = null;
      view.reset();
      if (view.onFit) view.onFit();
    }
    view.reset = () => g.setTransform(view.dpr * view.scale, 0, 0, view.dpr * view.scale, 0, 0);
    /* cached static layer (board / table): drawn once per size, blitted each frame */
    let layer = null, layerFn = null;
    view.layer = (fn) => {
      if (layer && layerFn === fn) return layer;
      layerFn = fn;
      layer = document.createElement("canvas");
      layer.width = cv.width; layer.height = cv.height;
      const lg = layer.getContext("2d");
      lg.setTransform(view.dpr * view.scale, 0, 0, view.dpr * view.scale, 0, 0);
      fn(lg);
      return layer;
    };
    view.blit = (fn) => { const l = view.layer(fn); g.setTransform(1, 0, 0, 1, 0, 0); g.drawImage(l, 0, 0); view.reset(); };
    view.toLogical = (e) => {
      const r = cv.getBoundingClientRect();
      return { x: (e.clientX - r.left) / r.width * view.lw, y: (e.clientY - r.top) / r.height * view.lh };
    };
    view.toClient = (lx, ly) => {
      const r = cv.getBoundingClientRect();
      return { x: r.left + lx / view.lw * r.width, y: r.top + ly / view.lh * r.height };
    };
    let ro = null;
    if (typeof ResizeObserver === "function") {
      let pending = false;
      ro = new ResizeObserver(() => {
        if (ctx.signal.ended) { ro.disconnect(); return; }
        if (pending || Math.abs(host.clientWidth - lastW) <= 0.5) return;
        pending = true; // refit next frame (avoids ResizeObserver loop warnings)
        ctx.raf(() => { pending = false; if (Math.abs(host.clientWidth - lastW) > 0.5) fit(); });
      });
      ro.observe(host);
    }
    view.stop = () => { if (ro) { ro.disconnect(); ro = null; } layer = null; };
    if (typeof ctx.onCleanup === "function") ctx.onCleanup(view.stop);
    fit();
    return view;
  }

  /* =====================================================================
     1. REACTION DUEL
     ===================================================================== */
  function reactionContent(seed, mode) {
    const rng = U.rng(seed + "|reaction");
    const n = mode === "mix" ? 3 : 5;
    const delays = [];
    for (let i = 0; i < n; i++) delays.push(Math.round(1200 + rng() * 2600));
    return { n, delays };
  }

  DG.css("reaction", `
    .g-reaction{display:grid;gap:12px}
    .g-reaction-head{display:flex;justify-content:space-between;align-items:baseline;gap:8px;flex-wrap:wrap}
    .g-reaction-head b{font-family:var(--f-mono);font-variant-numeric:tabular-nums}
    .g-reaction-pad{width:100%;min-height:clamp(200px,42vh,300px);border-radius:var(--r-lg);border:2px solid var(--line);
      background:var(--panel-2);color:var(--fg);display:grid;place-content:center;gap:8px;text-align:center;padding:16px;
      touch-action:manipulation;user-select:none;-webkit-user-select:none;-webkit-tap-highlight-color:transparent;transition:background .08s}
    .g-reaction-pad .g-reaction-big{font-family:var(--f-display);font-weight:900;text-transform:uppercase;line-height:1;font-size:clamp(40px,10vw,72px);letter-spacing:.01em}
    .g-reaction-pad .g-reaction-sub{font-size:14px;color:var(--muted)}
    .g-reaction-pad[data-state=idle]{border-color:var(--gold-deep)}
    .g-reaction-pad[data-state=wait]{background:color-mix(in srgb,var(--rival) 16%,var(--panel));border-color:color-mix(in srgb,var(--rival) 50%,var(--line))}
    .g-reaction-pad[data-state=go]{background:var(--gold);border-color:var(--gold);color:var(--on-gold)}
    .g-reaction-pad[data-state=go] .g-reaction-sub{color:var(--on-gold)}
    .g-reaction-pad[data-state=foul] .g-reaction-big{color:var(--bad)}
    .g-reaction-pad[data-state=result] .g-reaction-big{color:var(--gold)}
    .g-reaction-table td.g-reaction-pts{color:var(--gold)}
    .g-reaction-table tr.g-reaction-cur td{background:var(--panel-2)}`);

  DG.registerGame({
    id: "reaction", name: "Reaction Duel", category: "reflex", kind: "race", formats: ALL,
    skill: 7, luck: 2, cashEligible: true, duration: "30 s", pack: "reflex",
    blurb: "Wait for gold, then tap faster than your rival. Jump early and the round is lost.",
    rules: [
      "Tap the pad (or press Space) to arm a round.",
      "Wait. When the pad turns gold, tap as fast as you can.",
      "Round score is 1000 minus your reaction time in ms (250 ms scores 750).",
      "Tapping before gold is a foul and scores 0. No tap within 1 s also scores 0.",
      "5 rounds (3 in Duel Mix). Highest total wins; everyone gets the same delays.",
    ],
    scoreLabel: "pts",
    play(ctx) {
      const C = reactionContent(ctx.seed, ctx.mode);
      const res = [], log = [];
      let round = 0, phase = "idle", goAt = 0, armAt = 0, timer = null, total = 0;
      const status = statusSetter(ctx);
      ctx.root.innerHTML = `<div class="g-reaction">
        <div class="g-reaction-head"><span class="dg-eyebrow">Round <b data-test="round">1</b> / ${C.n}</span>
          <span class="dg-muted">Total <b class="dg-gold" data-test="score">0</b></span></div>
        <button type="button" class="g-reaction-pad" data-test="pad" data-state="idle">
          <span class="g-reaction-big">Tap to start</span><span class="g-reaction-sub"></span></button>
        <table class="dg-table g-reaction-table"><thead><tr><th>Round</th><th class="num">Time</th><th class="num">Points</th></tr></thead>
          <tbody>${C.delays.map((_, i) => `<tr data-row="${i}"><td>${i + 1}</td><td class="num">—</td><td class="num g-reaction-pts">—</td></tr>`).join("")}</tbody></table>
      </div>`;
      const $ = (s) => ctx.root.querySelector(s);
      const pad = $("[data-test=pad]"), big = pad.querySelector(".g-reaction-big"), sub = pad.querySelector(".g-reaction-sub");
      const setPad = (st, b, s) => { pad.dataset.state = st; big.textContent = b; sub.textContent = s; };
      const clear = () => { if (timer != null) { ctx.clearTimeout(timer); timer = null; } };
      const markRow = () => ctx.root.querySelectorAll("tr[data-row]").forEach((tr) => tr.classList.toggle("g-reaction-cur", +tr.dataset.row === round));

      function idle() {
        phase = "idle";
        $("[data-test=round]").textContent = round + 1;
        markRow();
        setPad("idle", round === 0 ? "Tap to start" : "Next round", "Tap the pad or press Space, then wait for gold.");
        status(`Round ${round + 1}/${C.n}`);
        clear(); timer = ctx.timeout(arm, 6000); // never stall: auto-arm
      }
      function arm() {
        clear(); phase = "wait"; armAt = ctx.now();
        setPad("wait", "Wait…", "Tap only when the pad turns gold.");
        status(`Round ${round + 1}/${C.n} · wait`);
        timer = ctx.timeout(go, C.delays[round]);
      }
      function go() {
        timer = null; phase = "go"; goAt = ctx.now(); log.push({ round, armAt, goAt, wait: goAt - armAt });
        setPad("go", "Tap!", "Now!");
        status(`Round ${round + 1}/${C.n} · TAP`);
        timer = ctx.timeout(() => finishRound({ slow: true }), 1000);
      }
      function finishRound(r) {
        clear();
        let pts = 0, ms = null, label;
        if (r.foul) label = "Foul";
        else if (r.slow) label = "No tap";
        else { ms = Math.max(0, Math.round(r.ms)); pts = Math.max(0, 1000 - ms); label = ms + " ms"; }
        res.push({ ms, foul: !!r.foul, slow: !!r.slow, pts });
        total += pts;
        ctx.progress(total);
        $("[data-test=score]").textContent = U.fmt(total);
        const tr = ctx.root.querySelector(`tr[data-row="${round}"]`);
        tr.children[1].textContent = label; tr.children[2].textContent = pts;
        if (!ms) tr.children[1].className = "num dg-bad";
        phase = "result";
        if (r.foul) setPad("foul", "Foul", "You tapped before gold. 0 points.");
        else if (r.slow) setPad("foul", "Too slow", "No tap within 1 second. 0 points.");
        else setPad("result", ms + " ms", `+${pts} points`);
        round++;
        timer = ctx.timeout(round >= C.n ? done : idle, 1200);
      }
      function done() {
        phase = "over"; timer = null;
        const ok = res.filter((r) => r.ms != null);
        const best = ok.length ? Math.min(...ok.map((r) => r.ms)) : null;
        const avg = ok.length ? Math.round(ok.reduce((a, r) => a + r.ms, 0) / ok.length) : null;
        const fouls = res.filter((r) => r.foul).length;
        const rows = res.map((r, i) => `<tr><td>${i + 1}</td><td class="num">${r.foul ? '<span class="dg-bad">Foul</span>' : r.slow ? '<span class="dg-bad">No tap</span>' : r.ms + " ms"}</td><td class="num dg-gold">${r.pts}</td></tr>`).join("");
        ctx.end({
          score: total,
          detail: `<table class="dg-table"><thead><tr><th>Round</th><th class="num">Time</th><th class="num">Points</th></tr></thead><tbody>${rows}</tbody></table>
            <p class="dg-note">${best != null ? `Best <b class="dg-gold">${best} ms</b> · average ${avg} ms` : "No clean reactions"} · ${fouls} foul${fouls === 1 ? "" : "s"}</p>`,
        });
      }
      function press() {
        if (ctx.signal.ended) return;
        if (phase === "idle") arm();
        else if (phase === "wait") finishRound({ foul: true });
        else if (phase === "go") finishRound({ ms: ctx.now() - goAt });
      }
      pad.addEventListener("pointerdown", (e) => { e.preventDefault(); press(); });
      ctx.onKey((e) => {
        if (e.key === " " || e.key === "Enter" || e.code === "Space") { e.preventDefault(); if (!e.repeat) press(); }
      });
      ctx.test = {
        state: () => ({ round, phase, total, n: C.n, results: res.slice(), delays: C.delays.slice(), log: log.slice() }),
        fire(ms) { if (phase === "idle" || phase === "wait" || phase === "go") { finishRound(ms < 0 ? { foul: true } : { ms }); return true; } return false; },
        press,
      };
      idle();
    },
    bot(seed, skill, rng, mode) {
      const C = reactionContent(seed, mode);
      let t = 0, score = 0;
      const tl = [];
      const mean = 420 - 200 * skill, sd = 45 - 20 * skill, foulP = 0.12 - 0.1 * skill;
      for (let i = 0; i < C.n; i++) {
        t += 0.35 + rng() * 0.6; // time to arm
        if (rng() < foulP) { t += (C.delays[i] / 1000) * (0.3 + rng() * 0.6); }
        else {
          const ms = clamp(mean + sd * U.gauss(rng), 130, 1000);
          t += C.delays[i] / 1000 + ms / 1000;
          score += Math.max(0, 1000 - Math.round(ms));
        }
        tl.push([t, score]);
        t += 1.2;
      }
      return { score, timeline: finishTimeline(tl, score) };
    },
  });

  /* =====================================================================
     2. AIM DUEL
     ===================================================================== */
  const AIM_LIFE = 1100;
  function aimContent(seed, mode) {
    const rng = U.rng(seed + "|aim");
    const dur = mode === "mix" ? 20000 : 30000;
    const T = [];
    let t = 900;
    while (t < dur - 350) {
      const p = t / dur;
      let x, y, tries = 0;
      do { // keep consecutive targets apart
        x = 0.08 + rng() * 0.84; y = 0.1 + rng() * 0.8; tries++;
      } while (tries < 12 && T.slice(-2).some((o) => Math.hypot(o.x - x, o.y - y) < 0.22));
      const r = 0.085 - 0.03 * p + (rng() - 0.5) * 0.02; // radius as fraction of the short side
      T.push({ i: T.length, t: Math.round(t), x, y, r });
      t += 820 - 360 * p + (rng() - 0.5) * 260;
    }
    return { dur, targets: T, life: AIM_LIFE };
  }
  const aimPts = (age) => 100 + Math.round(100 * clamp(1 - age / AIM_LIFE, 0, 1));

  DG.css("aim", `
    .g-aim{display:grid;gap:10px}
    .g-aim-hud{display:flex;gap:16px;flex-wrap:wrap;align-items:baseline}
    .g-aim-hud b{font-family:var(--f-mono);font-variant-numeric:tabular-nums;font-size:18px}
    .g-aim-stage{border-radius:var(--r-lg);overflow:hidden;border:1px solid var(--line);background:var(--panel);line-height:0}
    .g-aim-stage canvas{cursor:crosshair}`);

  DG.registerGame({
    id: "aim", name: "Aim Duel", category: "reflex", kind: "race", formats: ALL,
    skill: 8, luck: 1, cashEligible: true, duration: "30 s", pack: "reflex",
    blurb: "Targets pop up and shrink. Click them fast; stray clicks cost you.",
    rules: [
      "Click or tap each target before it shrinks away (1.1 s).",
      "A hit scores 100 plus up to 100 speed bonus.",
      "A click that hits nothing costs 25.",
      "30 seconds (20 in Duel Mix). Everyone gets the same targets at the same times.",
    ],
    scoreLabel: "pts",
    play(ctx) {
      const C = aimContent(ctx.seed, ctx.mode);
      const T = C.targets.map((o) => Object.assign({ hit: false, hitAt: 0 }, o));
      let score = 0, hits = 0, misses = 0, hitMs = 0, frames = 0, done = false;
      const pops = [];
      const status = statusSetter(ctx);
      ctx.root.innerHTML = `<div class="g-aim">
        <div class="g-aim-hud"><span class="dg-muted">Score <b class="dg-gold" data-test="score">0</b></span>
          <span class="dg-muted">Hits <b data-test="hits">0</b></span><span class="dg-muted">Misses <b data-test="misses">0</b></span></div>
        <div class="g-aim-stage" data-test="stage"></div>
        <p class="dg-note">Hit targets before they vanish. Faster hits score more; missed clicks cost 25.</p></div>`;
      const stage = ctx.root.querySelector("[data-test=stage]");
      const K = tokens(ctx.root);
      const view = canvasView(ctx, stage, (cw) => {
        const hMax = Math.max(260, (window.innerHeight || 800) - 200);
        const h = Math.min(hMax, Math.round(cw < 560 ? cw * 0.95 : cw * 0.58));
        return { lw: cw, lh: h, cssW: cw, cssH: h };
      });
      view.cv.dataset.test = "canvas";
      const t0 = ctx.now();
      const minSide = () => Math.min(view.lw, view.lh);
      const radius = (tg, t) => tg.r * minSide() * (1 - 0.55 * clamp((t - tg.t) / C.life, 0, 1));
      const alive = (tg, t) => !tg.hit && t >= tg.t && t < tg.t + C.life;
      const hud = () => {
        ctx.root.querySelector("[data-test=score]").textContent = U.fmt(score);
        ctx.root.querySelector("[data-test=hits]").textContent = hits;
        ctx.root.querySelector("[data-test=misses]").textContent = misses;
      };
      function hit(tg, t) {
        const age = t - tg.t, pts = aimPts(age);
        tg.hit = true; tg.hitAt = t; score += pts; hits++; hitMs += age;
        pops.push({ x: tg.x, y: tg.y, t, text: "+" + pts, good: true });
        hud(); ctx.progress(score);
      }
      function miss(nx, ny, t) {
        misses++; score = Math.max(0, score - 25);
        pops.push({ x: nx, y: ny, t, text: "−25", good: false });
        hud(); ctx.progress(score);
      }
      view.cv.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        if (ctx.signal.ended || done) return;
        const t = ctx.now() - t0, p = view.toLogical(e);
        let best = null, bd = Infinity;
        const tol = e.pointerType === "touch" ? 10 : 4;
        for (const tg of T) {
          if (!alive(tg, t)) continue;
          const d = Math.hypot(tg.x * view.lw - p.x, tg.y * view.lh - p.y);
          if (d <= radius(tg, t) + tol && d < bd) { bd = d; best = tg; }
        }
        if (best) hit(best, t); else miss(p.x / view.lw, p.y / view.lh, t);
      });
      function draw(t) {
        const g = view.g, W = view.lw, H = view.lh;
        view.reset();
        g.fillStyle = K.panel; g.fillRect(0, 0, W, H);
        g.strokeStyle = K.line; g.lineWidth = 1; g.globalAlpha = 0.5;
        const step = 40;
        g.beginPath();
        for (let x = step; x < W; x += step) { g.moveTo(x + 0.5, 0); g.lineTo(x + 0.5, H); }
        for (let y = step; y < H; y += step) { g.moveTo(0, y + 0.5); g.lineTo(W, y + 0.5); }
        g.stroke(); g.globalAlpha = 1;
        if (t < T[0].t - 100) {
          g.fillStyle = K.muted; g.textAlign = "center"; g.textBaseline = "middle";
          g.font = `800 ${Math.round(Math.min(34, W / 12))}px ${K.display}`;
          g.fillText("TARGETS INCOMING", W / 2, H / 2);
        }
        for (const tg of T) {
          if (done || !alive(tg, t)) continue;
          const cx = tg.x * W, cy = tg.y * H, r = radius(tg, t), life = 1 - (t - tg.t) / C.life;
          g.fillStyle = K.panel3; g.beginPath(); g.arc(cx, cy, r, 0, TAU); g.fill();
          g.strokeStyle = K.fg; g.lineWidth = Math.max(2, r * 0.12); g.beginPath(); g.arc(cx, cy, r * 0.7, 0, TAU); g.stroke();
          g.fillStyle = K.gold; g.beginPath(); g.arc(cx, cy, r * 0.32, 0, TAU); g.fill();
          g.strokeStyle = K.gold; g.lineWidth = 3; g.beginPath(); g.arc(cx, cy, r + 5, -Math.PI / 2, -Math.PI / 2 + TAU * life); g.stroke();
        }
        g.textAlign = "center"; g.textBaseline = "middle";
        for (let i = pops.length - 1; i >= 0; i--) {
          const p = pops[i], a = (t - p.t) / 650;
          if (a >= 1) { pops.splice(i, 1); continue; }
          g.globalAlpha = 1 - a; g.fillStyle = p.good ? K.gold : K.bad;
          g.font = `700 18px ${K.mono}`; g.fillText(p.text, p.x * W, p.y * H - 10 - a * 24);
        }
        g.globalAlpha = 1;
        if (done) {
          g.fillStyle = K.gold; g.textAlign = "center"; g.textBaseline = "middle";
          g.font = `900 ${Math.round(Math.min(48, W / 8))}px ${K.display}`;
          g.fillText("TIME", W / 2, H / 2 - 16);
          g.fillStyle = K.fg; g.font = `700 18px ${K.mono}`;
          g.fillText(`${U.fmt(score)} pts · ${hits} hits`, W / 2, H / 2 + 22);
        }
        const left = Math.max(0, C.dur - t);
        g.fillStyle = K.gold; g.fillRect(0, H - 4, W * left / C.dur, 4);
      }
      function finish() {
        done = true; view.stop();
        draw(C.dur);
        const avg = hits ? Math.round(hitMs / hits) : null;
        ctx.end({
          score,
          detail: `<p class="dg-note">Hits <b class="dg-gold">${hits}</b> / ${T.length} · missed clicks <b class="dg-bad">${misses}</b>${avg != null ? ` · average hit ${avg} ms` : ""}</p>`,
        });
      }
      function tick(now) {
        if (done) return;
        frames++;
        const t = now - t0;
        if (t >= C.dur) return finish();
        draw(t);
        status(`${Math.ceil((C.dur - t) / 1000)} s · ${hits} hits`);
        ctx.raf(tick);
      }
      ctx.test = {
        state: () => ({ score, hits, misses, t: ctx.now() - t0, total: T.length, done }),
        alive() {
          const t = ctx.now() - t0;
          return T.filter((tg) => alive(tg, t)).map((tg) => {
            const c = view.toClient(tg.x * view.lw, tg.y * view.lh);
            return { i: tg.i, cx: c.x, cy: c.y, age: t - tg.t, r: radius(tg, t) * view.scale };
          });
        },
        schedule: () => T.map((tg) => ({ i: tg.i, t: tg.t, x: tg.x, y: tg.y, r: tg.r })),
        hitNext() {
          const t = ctx.now() - t0;
          const tg = T.find((o) => alive(o, t));
          if (!tg) return false;
          hit(tg, t); return true;
        },
        frames: () => frames,
      };
      ctx.raf(tick);
    },
    bot(seed, skill, rng, mode) {
      const C = aimContent(seed, mode);
      const pBase = 0.3 + 0.62 * skill, mean = 780 - 420 * skill, sd = 140 - 60 * skill, missRate = 0.25 * (1 - skill);
      const ev = [];
      for (const tg of C.targets) {
        const pHit = clamp(pBase + (tg.r - 0.07) * 4, 0.05, 0.99);
        if (rng() < pHit) {
          const ms = clamp(mean + sd * U.gauss(rng), 200, C.life - 20);
          if (tg.t + ms < C.dur) ev.push([(tg.t + ms) / 1000, aimPts(ms)]);
        }
        if (rng() < missRate) ev.push([(tg.t + 400) / 1000, -25]);
      }
      ev.sort((a, b) => a[0] - b[0]);
      let score = 0;
      const tl = ev.map(([t, d]) => { score = Math.max(0, score + d); return [t, score]; });
      return { score, timeline: finishTimeline(tl, score, C.dur / 1000) };
    },
  });

  /* =====================================================================
     3. NUMBER RUSH
     ===================================================================== */
  function rushProblem(rng, i) {
    const lv = Math.min(1, i / 24);
    const ops = lv < 0.2 ? ["+", "-"] : lv < 0.45 ? ["+", "-", "×"] : ["+", "-", "×", "÷"];
    const op = U.pick(rng, ops);
    let a, b, ans, d;
    if (op === "+") { a = U.randInt(rng, 2 + Math.round(18 * lv), 9 + Math.round(80 * lv)); b = U.randInt(rng, 2 + Math.round(10 * lv), 9 + Math.round(60 * lv)); ans = a + b; d = (a + b) / 160; }
    else if (op === "-") { a = U.randInt(rng, 10 + Math.round(30 * lv), 20 + Math.round(90 * lv)); b = U.randInt(rng, 2, a - 1); ans = a - b; d = a / 130; }
    else if (op === "×") { a = U.randInt(rng, 2, 5 + Math.round(7 * lv)); b = U.randInt(rng, 2, 9 + Math.round(6 * lv)); ans = a * b; d = 0.2 + ans / 200; }
    else { b = U.randInt(rng, 2, 4 + Math.round(8 * lv)); ans = U.randInt(rng, 2, 9 + Math.round(4 * lv)); a = b * ans; d = 0.3 + a / 220; }
    const cand = [ans + 1, ans - 1, ans + 2, ans - 2, ans + 10, ans - 10];
    if (op === "×") cand.push(ans + a, ans - a, ans + b, ans - b);
    if (op === "÷") cand.push(ans + 3, b, ans * 2);
    const set = [];
    for (const c of U.shuffle(rng, cand)) if (c > 0 && c !== ans && !set.includes(c)) { set.push(c); if (set.length === 3) break; }
    while (set.length < 3) { const c = ans + U.randInt(rng, 3, 19); if (!set.includes(c)) set.push(c); }
    const options = U.shuffle(rng, [ans, ...set]);
    return { text: `${a} ${op === "-" ? "−" : op} ${b}`, ans, options, correct: options.indexOf(ans), d: clamp(d, 0, 1) };
  }
  function rushContent(seed, mode) {
    const rng = U.rng(seed + "|rush");
    const probs = [];
    for (let i = 0; i < 200; i++) probs.push(rushProblem(rng, i));
    return { dur: mode === "mix" ? 25000 : 40000, probs };
  }
  const rushGain = (streak) => 100 + Math.min(50, 10 * (streak - 1)); // streak includes this answer

  DG.css("rush", `
    .g-rush{display:grid;gap:12px}
    .g-rush-hud{display:flex;gap:16px;flex-wrap:wrap;align-items:baseline}
    .g-rush-hud b{font-family:var(--f-mono);font-variant-numeric:tabular-nums;font-size:18px}
    .g-rush-q{background:var(--panel);border:1px solid var(--line);border-radius:var(--r-lg);padding:22px 12px;text-align:center;
      font-family:var(--f-mono);font-weight:700;font-size:clamp(38px,11vw,64px);font-variant-numeric:tabular-nums;line-height:1.1;position:relative;overflow:hidden}
    .g-rush-q[data-flash=good]{border-color:var(--good)} .g-rush-q[data-flash=bad]{border-color:var(--bad)}
    .g-rush-bar{height:5px;background:var(--panel-2);border-radius:3px;overflow:hidden}
    .g-rush-bar i{display:block;height:100%;background:var(--gold);width:100%}
    .g-rush-opts{display:grid;grid-template-columns:1fr 1fr;gap:10px}
    .g-rush-opt{min-height:64px;border-radius:var(--r-md);border:1px solid var(--line);background:var(--panel-2);
      font-family:var(--f-mono);font-size:26px;font-weight:700;font-variant-numeric:tabular-nums;position:relative;touch-action:manipulation}
    .g-rush-opt:hover{background:var(--panel-3)}
    .g-rush-opt kbd{position:absolute;left:8px;top:6px;font-size:11px;color:var(--muted);font-family:var(--f-mono)}
    .g-rush-opt[data-flash=good]{border-color:var(--good);color:var(--good)} .g-rush-opt[data-flash=bad]{border-color:var(--bad);color:var(--bad)}`);

  DG.registerGame({
    id: "rush", name: "Number Rush", category: "numbers", kind: "race", formats: ALL,
    skill: 8, luck: 1, cashEligible: true, duration: "40 s", pack: "reflex",
    blurb: "Quick-fire mental arithmetic. Pick the right answer out of four, keep the streak alive.",
    rules: [
      "Solve each sum and pick the answer (tap it or press 1–4).",
      "Correct: +100, plus 10 per streak step (bonus capped at +50).",
      "Wrong: −50 and the streak resets. Your score never drops below 0.",
      "Problems get harder as you go. 40 seconds (25 in Duel Mix).",
    ],
    scoreLabel: "pts",
    play(ctx) {
      const C = rushContent(ctx.seed, ctx.mode);
      let idx = 0, score = 0, streak = 0, best = 0, right = 0, wrong = 0, lockUntil = -1, done = false;
      const status = statusSetter(ctx);
      ctx.root.innerHTML = `<div class="g-rush">
        <div class="g-rush-hud"><span class="dg-muted">Score <b class="dg-gold" data-test="score">0</b></span>
          <span class="dg-muted">Streak <b data-test="streak">0</b></span><span class="dg-muted">Solved <b data-test="solved">0</b></span></div>
        <div class="g-rush-bar"><i data-test="bar"></i></div>
        <div class="g-rush-q" data-test="question"></div>
        <div class="g-rush-opts">${[0, 1, 2, 3].map((i) => `<button type="button" class="g-rush-opt" data-test="opt-${i}" data-opt="${i}"><kbd>${i + 1}</kbd><span></span></button>`).join("")}</div>
        <p class="dg-note">Tap the answer or press 1–4. Wrong answers cost 50.</p></div>`;
      const $ = (s) => ctx.root.querySelector(s);
      const qEl = $("[data-test=question]"), bar = $("[data-test=bar]");
      const btns = [0, 1, 2, 3].map((i) => $(`[data-test=opt-${i}]`));
      function show() {
        const p = C.probs[idx];
        qEl.textContent = p.text + " = ?";
        btns.forEach((b, i) => { b.querySelector("span").textContent = p.options[i]; });
      }
      function flash(el, kind) {
        el.dataset.flash = kind;
        ctx.timeout(() => { if (el.dataset.flash === kind) delete el.dataset.flash; }, ctx.reducedMotion ? 120 : 220);
      }
      function answer(i) {
        if (done || ctx.signal.ended) return;
        const now = ctx.now();
        if (now < lockUntil) return;
        lockUntil = now + 120;
        const p = C.probs[idx];
        const ok = i === p.correct;
        if (ok) { streak++; best = Math.max(best, streak); right++; score += rushGain(streak); }
        else { streak = 0; wrong++; score = Math.max(0, score - 50); flash(btns[p.correct], "good"); }
        flash(btns[i], ok ? "good" : "bad"); flash(qEl, ok ? "good" : "bad");
        $("[data-test=score]").textContent = U.fmt(score);
        $("[data-test=streak]").textContent = streak;
        $("[data-test=solved]").textContent = right;
        ctx.progress(score);
        idx = Math.min(C.probs.length - 1, idx + 1);
        show();
      }
      btns.forEach((b, i) => b.addEventListener("click", () => answer(i)));
      ctx.onKey((e) => {
        const k = e.key;
        if (k >= "1" && k <= "4" && !e.repeat) { e.preventDefault(); answer(+k - 1); }
      });
      const t0 = ctx.now();
      function tick() {
        if (done) return;
        const left = C.dur - (ctx.now() - t0);
        bar.style.width = clamp(left / C.dur * 100, 0, 100) + "%";
        status(`${Math.max(0, Math.ceil(left / 1000))} s · streak ${streak}`);
        if (left <= 0) {
          done = true;
          btns.forEach((b) => (b.disabled = true));
          const acc = right + wrong ? Math.round(right / (right + wrong) * 100) : 0;
          ctx.end({ score, detail: `<p class="dg-note">Correct <b class="dg-gold">${right}</b> · wrong <b class="dg-bad">${wrong}</b> · accuracy ${acc}% · best streak ${best}</p>` });
        }
      }
      ctx.test = {
        state: () => ({ idx, score, streak, right, wrong, done, current: Object.assign({}, C.probs[idx]) }),
        answerCorrect() { lockUntil = -1; answer(C.probs[idx].correct); },
        answerWrong() { lockUntil = -1; answer((C.probs[idx].correct + 1) % 4); },
      };
      show();
      ctx.interval(tick, 100);
      tick();
    },
    bot(seed, skill, rng, mode) {
      const C = rushContent(seed, mode);
      const dur = C.dur / 1000, speedF = 2.5 - 1.9 * skill;
      let t = 0.3, score = 0, streak = 0;
      const tl = [];
      for (const p of C.probs) {
        t += (1.0 + 1.8 * p.d) * speedF * Math.exp(0.25 * U.gauss(rng));
        if (t > dur) break;
        const acc = clamp(0.8 + 0.18 * skill - 0.12 * p.d, 0.3, 0.995);
        if (rng() < acc) { streak++; score += rushGain(streak); }
        else { streak = 0; score = Math.max(0, score - 50); }
        tl.push([t, score]);
      }
      return { score, timeline: finishTimeline(tl, score, dur) };
    },
    _content: rushContent,
  });

  /* =====================================================================
     4. DARTS NINE
     ===================================================================== */
  const DB = { BULL: 6.35, OBULL: 15.9, TI: 99, TO: 107, DI: 162, DO: 170, NUM: 196, VIEW: 460,
    ORDER: [20, 1, 18, 4, 13, 6, 10, 15, 2, 17, 3, 19, 7, 16, 8, 11, 14, 9, 12, 5],
    A0: 50, AMIN: 21, FATIGUE: 1600, SCATTER: 4, CLOCK: 10000, T20: { x: 0, y: 103 } };
  /* board coordinates in mm, origin at bull, y up; 20 at the top */
  function dartScore(x, y) {
    const r = Math.hypot(x, y);
    if (!(r >= 0)) return { pts: 0, label: "Miss" };
    if (r <= DB.BULL) return { pts: 50, label: "Bull" };
    if (r <= DB.OBULL) return { pts: 25, label: "25" };
    if (r > DB.DO) return { pts: 0, label: "Miss" };
    const a = Math.atan2(x, y) * 180 / Math.PI; // clockwise from top
    const idx = Math.floor((((a + 9) % 360) + 360) % 360 / 18) % 20;
    const n = DB.ORDER[idx];
    if (r >= DB.TI && r <= DB.TO) return { pts: 3 * n, label: "T" + n };
    if (r >= DB.DI) return { pts: 2 * n, label: "D" + n };
    return { pts: n, label: String(n) };
  }
  function dartsContent(seed, mode) {
    const rng = U.rng(seed + "|darts");
    const n = mode === "mix" ? 6 : 9;
    const darts = [];
    for (let i = 0; i < n; i++) {
      const mk = () => {
        const f = [], p = [], a = [];
        const base = [1, 0.6, 0.35];
        for (let k = 0; k < 3; k++) { f.push(0.35 + k * 0.3 + rng() * 0.45); p.push(rng() * TAU); a.push(base[k] * (0.8 + rng() * 0.4)); }
        const s = a.reduce((x, y) => x + y, 0);
        return { f, p, a: a.map((v) => v / s) };
      };
      darts.push({ wx: mk(), wy: mk(), sx: U.gauss(rng) * DB.SCATTER, sy: U.gauss(rng) * DB.SCATTER });
    }
    return { n, darts };
  }
  const wob1 = (w, t) => w.a[0] * Math.sin(TAU * w.f[0] * t + w.p[0]) + w.a[1] * Math.sin(TAU * w.f[1] * t + w.p[1]) + w.a[2] * Math.sin(TAU * w.f[2] * t + w.p[2]);
  function dartsAmp(holdMs) { // holdMs < 0 = not holding
    if (holdMs < 0) return DB.A0;
    let A = DB.AMIN + (DB.A0 - DB.AMIN) * Math.exp(-holdMs / 350);
    if (holdMs > DB.FATIGUE) A += (holdMs - DB.FATIGUE) / 1000 * 45;
    return Math.min(A, 80);
  }

  DG.css("darts", `
    .g-darts{display:grid;gap:10px}
    .g-darts-hud{display:flex;gap:16px;flex-wrap:wrap;align-items:baseline;justify-content:space-between}
    .g-darts-hud b{font-family:var(--f-mono);font-variant-numeric:tabular-nums;font-size:18px}
    .g-darts-stage{line-height:0;border-radius:var(--r-lg);background:var(--panel);border:1px solid var(--line);padding:6px 0}
    .g-darts-stage canvas{cursor:none}
    .g-darts-table td.dg-gold{font-weight:700}
    .g-darts-table td{white-space:nowrap}`);

  DG.registerGame({
    id: "darts", name: "Darts Nine", category: "precision", kind: "race", formats: ALL,
    skill: 7, luck: 2, cashEligible: true, duration: "up to 100 s", pack: "reflex", // 9 × 10 s clock + flights and visit pauses
    blurb: "Nine darts, highest total wins. Steady the wobbling sight and release on target.",
    rules: [
      "Point at the board. The sight wobbles on a fixed path everyone shares.",
      "Press and hold to steady the sight (hold too long and your arm shakes), release to throw.",
      "On touch: press and hold where you want to aim; the sight appears just above your finger so you can see it. Slide to adjust, lift to throw.",
      "Standard board: treble ring ×3, double ring ×2, bull 50, outer bull 25.",
      "9 darts in 3 visits (6 in Duel Mix). Highest total wins. Each dart has a 10 s clock.",
    ],
    scoreLabel: "pts",
    play(ctx) {
      const C = dartsContent(ctx.seed, ctx.mode);
      const thrown = []; // {x,y,pts,label}
      let di = 0, phase = "aim", dartStart = ctx.now(), holding = false, holdStart = 0, phaseT = 0, frames = 0;
      let aim = { x: 0, y: 0 }, touchSight = false, total = 0;
      const status = statusSetter(ctx);
      const visits = Math.ceil(C.n / 3);
      ctx.root.innerHTML = `<div class="g-darts">
        <div class="g-darts-hud"><span class="dg-muted">Total <b class="dg-gold" data-test="score">0</b></span>
          <span class="dg-muted">Dart <b data-test="dart">1</b>/${C.n}</span><span class="dg-muted">Last <b data-test="last">—</b></span></div>
        <div class="g-darts-stage" data-test="stage"></div>
        <p class="dg-note">Point at the board, press and hold to steady the sight, release to throw. On touch the sight sits just above your finger.</p>
        <div class="dg-scroll-x"><table class="dg-table g-darts-table"><thead><tr><th>Visit</th><th class="num">1</th><th class="num">2</th><th class="num">3</th><th class="num">Total</th></tr></thead>
          <tbody>${Array.from({ length: visits }, (_, v) => `<tr data-visit="${v}"><td>${v + 1}</td>${[0, 1, 2].map((k) => `<td class="num">${v * 3 + k < C.n ? "—" : ""}</td>`).join("")}<td class="num dg-gold">—</td></tr>`).join("")}</tbody></table></div></div>`;
      const $ = (s) => ctx.root.querySelector(s);
      const K = tokens(ctx.root);
      const stage = $("[data-test=stage]");
      const view = canvasView(ctx, stage, (cw) => {
        const s = Math.max(240, Math.min(cw - 12, 500, (window.innerHeight || 800) - 250));
        return { lw: DB.VIEW, lh: DB.VIEW, cssW: s, cssH: s };
      });
      view.cv.dataset.test = "canvas";
      const H2 = DB.VIEW / 2;
      const TOUCH_UP = 48; // css px: the touch sight is drawn above the finger
      const toMm = (p) => ({ x: p.x - H2, y: H2 - p.y });
      const aimFrom = (e) => {
        const p = view.toLogical(e);
        if (e.pointerType !== "mouse") p.y -= TOUCH_UP / view.scale;
        aim = toMm(p); clampAim();
      };
      const clampAim = () => { const r = Math.hypot(aim.x, aim.y); if (r > 215) { aim.x *= 215 / r; aim.y *= 215 / r; } };
      function reticle(now) {
        const d = C.darts[di], t = (now - dartStart) / 1000;
        const A = dartsAmp(holding ? now - holdStart : -1);
        return { x: aim.x + A * wob1(d.wx, t), y: aim.y + A * wob1(d.wy, t), A };
      }
      function throwDart(land) {
        const s = dartScore(land.x, land.y);
        thrown.push({ x: land.x, y: land.y, pts: s.pts, label: s.label });
        total += s.pts;
        ctx.progress(total);
        $("[data-test=score]").textContent = total;
        $("[data-test=last]").textContent = s.label === "Miss" ? "Miss" : `${s.label} · ${s.pts}`;
        const v = Math.floor(di / 3), k = di % 3, tr = ctx.root.querySelector(`tr[data-visit="${v}"]`);
        tr.children[k + 1].textContent = s.pts === 0 ? "0" : `${s.pts}`;
        tr.children[k + 1].title = s.label;
        tr.children[4].textContent = thrown.slice(v * 3, v * 3 + 3).reduce((a, o) => a + o.pts, 0);
        holding = false;
        di++;
        phase = (di % 3 === 0 || di >= C.n) ? "visit" : "flight";
        phaseT = ctx.now();
        return s;
      }
      function release(now) {
        if (phase !== "aim") return;
        const r = reticle(now), d = C.darts[di];
        return throwDart({ x: r.x + d.sx, y: r.y + d.sy });
      }
      const cv = view.cv;
      cv.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        if (ctx.signal.ended || phase !== "aim") return;
        try { cv.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
        aimFrom(e);
        touchSight = e.pointerType !== "mouse";
        holding = true; holdStart = ctx.now();
      });
      cv.addEventListener("pointermove", (e) => {
        if (ctx.signal.ended) return;
        if (e.pointerType === "mouse" || holding) aimFrom(e); // mouse hovers; touch/pen adjust while held
      });
      const up = (e) => { if (ctx.signal.ended) return; if (holding) { e.preventDefault(); release(ctx.now()); } };
      cv.addEventListener("pointerup", up);
      cv.addEventListener("pointercancel", up);

      function sectorPath(g, r0, r1, a0, a1) {
        g.beginPath(); g.arc(H2, H2, r1, a0, a1); g.arc(H2, H2, r0, a1, a0, true); g.closePath();
      }
      function drawBoard(g) {
        const dark = "#1b1b1f", cream = "#eadfc4", red = "#d8453e", green = "#2e9c5a";
        g.fillStyle = "#0c0d18"; g.beginPath(); g.arc(H2, H2, 225, 0, TAU); g.fill();
        for (let i = 0; i < 20; i++) {
          const a0 = (i * 18 - 9 - 90) * Math.PI / 180, a1 = (i * 18 + 9 - 90) * Math.PI / 180;
          const even = i % 2 === 0;
          g.fillStyle = even ? dark : cream;
          sectorPath(g, DB.OBULL, DB.TI, a0, a1); g.fill();
          sectorPath(g, DB.TO, DB.DI, a0, a1); g.fill();
          g.fillStyle = even ? red : green;
          sectorPath(g, DB.TI, DB.TO, a0, a1); g.fill();
          sectorPath(g, DB.DI, DB.DO, a0, a1); g.fill();
        }
        g.fillStyle = green; g.beginPath(); g.arc(H2, H2, DB.OBULL, 0, TAU); g.fill();
        g.fillStyle = red; g.beginPath(); g.arc(H2, H2, DB.BULL, 0, TAU); g.fill();
        g.strokeStyle = "rgba(200,200,215,.55)"; g.lineWidth = 0.9;
        for (const r of [DB.OBULL, DB.TI, DB.TO, DB.DI, DB.DO]) { g.beginPath(); g.arc(H2, H2, r, 0, TAU); g.stroke(); }
        g.beginPath();
        for (let i = 0; i < 20; i++) {
          const a = (i * 18 - 9 - 90) * Math.PI / 180;
          g.moveTo(H2 + Math.cos(a) * DB.OBULL, H2 + Math.sin(a) * DB.OBULL); g.lineTo(H2 + Math.cos(a) * DB.DO, H2 + Math.sin(a) * DB.DO);
        }
        g.stroke();
        g.fillStyle = K.fg; g.textAlign = "center"; g.textBaseline = "middle"; g.font = `700 22px ${K.mono}`;
        for (let i = 0; i < 20; i++) {
          const a = (i * 18 - 90) * Math.PI / 180;
          g.fillText(String(DB.ORDER[i]), H2 + Math.cos(a) * DB.NUM, H2 + Math.sin(a) * DB.NUM);
        }
      }
      function draw(now) {
        const g = view.g;
        view.reset();
        g.clearRect(0, 0, DB.VIEW, DB.VIEW);
        view.blit(drawBoard);
        const visitStart = Math.floor((phase === "aim" ? di : di - 1) / 3) * 3;
        for (let i = Math.max(0, visitStart); i < thrown.length; i++) {
          const o = thrown[i], sx = H2 + o.x, sy = H2 - o.y;
          g.fillStyle = K.gold; g.strokeStyle = K.onGold; g.lineWidth = 2;
          g.beginPath(); g.arc(sx, sy, 6, 0, TAU); g.fill(); g.stroke();
          g.font = `700 16px ${K.mono}`; g.textAlign = "center"; g.textBaseline = "bottom";
          g.lineWidth = 4; g.lineJoin = "round"; g.strokeStyle = "rgba(0,0,0,.75)"; g.strokeText(o.label, sx, sy - 9);
          g.fillStyle = K.gold; g.fillText(o.label, sx, sy - 9);
        }
        if (phase === "aim") {
          const r = reticle(now), sx = H2 + r.x, sy = H2 - r.y;
          g.strokeStyle = "rgba(242,193,78,.35)"; g.lineWidth = 1.5; g.setLineDash([4, 4]);
          g.beginPath(); g.arc(H2 + aim.x, H2 - aim.y, r.A, 0, TAU); g.stroke(); g.setLineDash([]);
          g.strokeStyle = "rgba(0,0,0,.6)"; g.lineWidth = 5;
          g.beginPath(); g.arc(sx, sy, 11, 0, TAU); g.stroke();
          g.strokeStyle = holding ? K.gold : K.fg; g.lineWidth = 2.5;
          g.beginPath(); g.arc(sx, sy, 11, 0, TAU);
          g.moveTo(sx - 18, sy); g.lineTo(sx - 5, sy); g.moveTo(sx + 5, sy); g.lineTo(sx + 18, sy);
          g.moveTo(sx, sy - 18); g.lineTo(sx, sy - 5); g.moveTo(sx, sy + 5); g.lineTo(sx, sy + 18);
          g.stroke();
          if (holding && touchSight) { // finger position marker below the sight
            const fy = H2 - aim.y + TOUCH_UP / view.scale;
            g.strokeStyle = "rgba(242,193,78,.45)"; g.lineWidth = 1.5;
            g.beginPath(); g.moveTo(H2 + aim.x, H2 - aim.y + 20); g.lineTo(H2 + aim.x, fy - 14); g.arc(H2 + aim.x, fy, 14, -Math.PI / 2, 1.5 * Math.PI); g.stroke();
          }
          const left = DB.CLOCK - (now - dartStart);
          g.fillStyle = K.muted; g.font = `600 15px ${K.mono}`; g.textAlign = "left"; g.textBaseline = "top";
          g.fillText(`${Math.max(0, Math.ceil(left / 1000))} s`, 8, 6);
        } else if (thrown.length) {
          const o = thrown[thrown.length - 1];
          g.textAlign = "center"; g.textBaseline = "middle";
          const txt = phase === "visit" ? `VISIT ${thrown.slice(visitStart).reduce((a, b) => a + b.pts, 0)}` : (o.pts ? `${o.label === String(o.pts) ? "" : o.label + " · "}${o.pts}` : "MISS");
          g.font = `900 40px ${K.display}`;
          const bw = g.measureText(txt).width + 36, by = H2 + 92;
          g.fillStyle = "rgba(16,17,31,.86)"; g.strokeStyle = phase === "visit" ? K.gold : K.line; g.lineWidth = 2;
          g.beginPath(); if (g.roundRect) g.roundRect(H2 - bw / 2, by - 28, bw, 56, 12); else g.rect(H2 - bw / 2, by - 28, bw, 56); g.fill(); g.stroke();
          g.fillStyle = o.pts || phase === "visit" ? K.gold : K.bad; g.fillText(txt, H2, by + 2);
        }
      }
      function end() {
        phase = "over"; view.stop();
        const t20 = thrown.filter((o) => o.label[0] === "T").length, bulls = thrown.filter((o) => o.label === "Bull" || o.label === "25").length;
        const rows = [];
        for (let v = 0; v < visits; v++) {
          const ds = thrown.slice(v * 3, v * 3 + 3);
          rows.push(`<tr><td>${v + 1}</td>${[0, 1, 2].map((k) => `<td class="num">${ds[k] ? U.esc(ds[k].label) + " · " + ds[k].pts : ""}</td>`).join("")}<td class="num dg-gold">${ds.reduce((a, o) => a + o.pts, 0)}</td></tr>`);
        }
        ctx.end({
          score: total,
          detail: `<div class="dg-scroll-x"><table class="dg-table"><thead><tr><th>Visit</th><th class="num">1</th><th class="num">2</th><th class="num">3</th><th class="num">Total</th></tr></thead><tbody>${rows.join("")}</tbody></table></div>
            <p class="dg-note">Total <b class="dg-gold">${total}</b> from ${thrown.length} darts · trebles ${t20} · bulls ${bulls}</p>`,
        });
      }
      function tick(now) {
        if (phase === "over") return;
        frames++;
        if (phase === "aim" && now - dartStart >= DB.CLOCK) release(now);
        else if ((phase === "flight" && now - phaseT >= 700) || (phase === "visit" && now - phaseT >= 1300)) {
          if (di >= C.n) { draw(now); return end(); }
          phase = "aim"; dartStart = now; holding = false;
        }
        $("[data-test=dart]").textContent = Math.min(C.n, di + 1);
        draw(now);
        const v = Math.floor(Math.min(di, C.n - 1) / 3) + 1;
        status(`Dart ${Math.min(C.n, di + 1)}/${C.n} · visit ${v}/${visits}` + (phase === "aim" ? ` · ${Math.max(0, Math.ceil((DB.CLOCK - (now - dartStart)) / 1000))} s` : ""));
        ctx.raf(tick);
      }
      ctx.test = {
        state: () => ({ dart: di, phase, total, holding, aim: Object.assign({}, aim), thrown: thrown.map((o) => Object.assign({}, o)), n: C.n }),
        throwAt(x, y) { if (phase !== "aim") return null; return throwDart({ x, y }); },
        boardToClient(x, y) { return view.toClient(H2 + x, H2 - y); },
        reticle: () => reticle(ctx.now()),
        scoreAt: (x, y) => dartScore(x, y),
        frames: () => frames,
      };
      ctx.raf(tick);
    },
    /* Bot throws on the SAME seeded wobble path + scatter as the human: it points at T20 (with a
       skill-dependent aiming offset), presses after a think time, and picks a release moment by
       reading the real path (it finds the best moment in its hold window) with skill-dependent
       timing error. Weak bots barely time the release; strong ones release close to the sweet spot. */
    bot(seed, skill, rng, mode) {
      const C = dartsContent(seed, mode);
      const sk = clamp(skill, 0.05, 0.98);
      const aimSd = 2 + 30 * Math.pow(1 - sk, 1.5);     // mm: where it points
      const timeSd = 25 + 330 * Math.pow(1 - sk, 1.6);  // ms: release timing error
      const reads = Math.pow(sk, 1.5);                   // chance to time the release at all
      let t = 0, score = 0;
      const tl = [];
      for (let i = 0; i < C.n; i++) {
        const d = C.darts[i];
        const press = 500 + rng() * 600 + (1 - sk) * 500;          // ms after the dart becomes available
        const ax = DB.T20.x + aimSd * U.gauss(rng), ay = DB.T20.y + aimSd * U.gauss(rng);
        let rel;
        if (rng() < reads) {
          let best = Infinity;
          for (let h = 300; h <= 1500; h += 10) {
            const tt = (press + h) / 1000, A = dartsAmp(h);
            const e = Math.hypot(ax + A * wob1(d.wx, tt) - DB.T20.x, ay + A * wob1(d.wy, tt) - DB.T20.y);
            if (e < best) { best = e; rel = h; }
          }
          rel = clamp(rel + timeSd * U.gauss(rng), 60, 2600);
        } else rel = 120 + rng() * 900;
        const tt = (press + rel) / 1000, A = dartsAmp(rel);
        score += dartScore(ax + A * wob1(d.wx, tt) + d.sx, ay + A * wob1(d.wy, tt) + d.sy).pts;
        t += (press + rel) / 1000 + (i % 3 === 2 ? 1.3 : 0.7);
        tl.push([t, score]);
      }
      return { score, timeline: finishTimeline(tl, score) };
    },
    _dartScore: dartScore,
    /* test-only estimate of human results with the real wobble paths.
       policy 'casual': aim at T20, hold ~0.6 s, release without timing.
       policy 'good': hold, release when the sight crosses T20 (±jitterMs human timing error). */
    _humanEstimate(seed, mode, policy, rng) {
      const C = dartsContent(seed, mode);
      let total = 0;
      const jit = policy === "good" ? 45 : 0;
      for (const d of C.darts) {
        const hold0 = 700 + rng() * 500;
        let rel;
        if (policy === "good") {
          let best = Infinity;
          for (let h = 350; h <= 1500; h += 5) {
            const t = (hold0 + h) / 1000, A = dartsAmp(h);
            const e = Math.hypot(A * wob1(d.wx, t) - DB.T20.x, DB.T20.y + A * wob1(d.wy, t) - DB.T20.y);
            if (e < best) { best = e; rel = h; }
          }
          rel += jit * U.gauss(rng);
        } else rel = 400 + rng() * 600;
        const t = (hold0 + rel) / 1000, A = dartsAmp(rel);
        total += dartScore(DB.T20.x + A * wob1(d.wx, t) + d.sx, DB.T20.y + A * wob1(d.wy, t) + d.sy).pts;
      }
      return total;
    },
  });

  /* =====================================================================
     5. AIR HOCKEY (versus, real-time)
     ===================================================================== */
  const HK = { W: 300, H: 500, GOAL: 110, PR: 21, KR: 13, HZ: 240, MAXV: 1150, FRIC: 0.35, WALL_E: 0.88, PAD_E: 0.9,
    HUMAN_V: 3000, WIN: 5, TIME: 120, SD: 30, KICK: 1.5, HIST: 256 };
  const HK_STEP_MS = 1000 / HK.HZ;
  const GL = HK.W / 2 - HK.GOAL / 2, GR = HK.W / 2 + HK.GOAL / 2;

  function hkNew(firstServe, opts) {
    opts = opts || {};
    const w = {
      win: opts.win || HK.WIN, time: opts.time || HK.TIME, sd: opts.sd || HK.SD,
      steps: 0, clock: 0, sdClock: 0, sudden: false, phase: "kick", kick: HK.KICK, score: [0, 0], serve: firstServe,
      puck: { x: HK.W / 2, y: HK.H / 2, vx: 0, vy: 0 },
      pads: [{ x: HK.W / 2, y: HK.H - 60, vx: 0, vy: 0, maxV: HK.HUMAN_V }, { x: HK.W / 2, y: 60, vx: 0, vy: 0, maxV: HK.HUMAN_V }],
      hist: new Float64Array(HK.HIST * 4), hi: 0, escapes: 0, nan: 0, over: false, goals: [], maxSpeed: 0, lastGoal: -1,
    };
    hkKickoff(w);
    return w;
  }
  function hkKickoff(w) {
    w.phase = "kick"; w.kick = HK.KICK;
    w.puck = { x: HK.W / 2, y: w.serve === 0 ? HK.H * 0.7 : HK.H * 0.3, vx: 0, vy: 0 };
    for (let i = 0; i < HK.HIST; i++) { const j = i * 4; w.hist[j] = w.puck.x; w.hist[j + 1] = w.puck.y; w.hist[j + 2] = 0; w.hist[j + 3] = 0; }
  }
  function hkPadBounds(k) {
    const { W, H, PR } = HK;
    return k === 0 ? { x0: PR, x1: W - PR, y0: H / 2 + 6, y1: H - PR } : { x0: PR, x1: W - PR, y0: PR, y1: H / 2 - 6 };
  }
  function hkClampPad(k, p) {
    const b = hkPadBounds(k);
    p.x = clamp(p.x, b.x0, b.x1); p.y = clamp(p.y, b.y0, b.y1);
    return p;
  }
  const HK_TG = { x: 0, y: 0 };
  function hkPost(P, px, py) {
    const dx = P.x - px, dy = P.y - py, d = Math.hypot(dx, dy);
    if (d >= HK.KR) return;
    const nx = d > 1e-6 ? dx / d : 0, ny = d > 1e-6 ? dy / d : (py === 0 ? 1 : -1);
    P.x = px + nx * HK.KR; P.y = py + ny * HK.KR;
    const vn = P.vx * nx + P.vy * ny;
    if (vn < 0) { P.vx -= (1 + HK.WALL_E) * vn * nx; P.vy -= (1 + HK.WALL_E) * vn * ny; }
  }
  function hkGoal(w, side) { // side = index of the pad whose owner scored
    w.score[side]++;
    w.goals.push({ side, t: r2(w.clock), step: w.steps });
    w.lastGoal = side;
    if (w.score[side] >= w.win || w.sudden) { w.over = true; w.phase = "over"; return; }
    w.serve = 1 - w.serve;
    hkKickoff(w);
  }
  /* one fixed physics step. ctrl[k](w,k) returns the pad target {x,y} */
  function hkStep(w, ctrl) {
    if (w.over) return;
    const dt = 1 / HK.HZ, { W, H, PR, KR } = HK, P = w.puck;
    w.steps++;
    const j = w.hi * 4;
    w.hist[j] = P.x; w.hist[j + 1] = P.y; w.hist[j + 2] = P.vx; w.hist[j + 3] = P.vy;
    w.hi = (w.hi + 1) % HK.HIST;
    for (let k = 0; k < 2; k++) {
      const src = ctrl[k](w, k); HK_TG.x = src.x; HK_TG.y = src.y;
      const pad = w.pads[k], tg = hkClampPad(k, HK_TG);
      if (!isFinite(tg.x) || !isFinite(tg.y)) { tg.x = pad.x; tg.y = pad.y; }
      let dx = tg.x - pad.x, dy = tg.y - pad.y;
      const d = Math.hypot(dx, dy), md = pad.maxV * dt;
      if (d > md) { dx *= md / d; dy *= md / d; }
      pad.x += dx; pad.y += dy; pad.vx = dx / dt; pad.vy = dy / dt;
    }
    if (w.phase === "kick") {
      for (let k = 0; k < 2; k++) { // pads may not sit on the frozen puck
        const pad = w.pads[k], dx = pad.x - P.x, dy = pad.y - P.y, d = Math.hypot(dx, dy);
        if (d < PR + KR) {
          const nx = d > 1e-6 ? dx / d : 0, ny = d > 1e-6 ? dy / d : (k === 0 ? 1 : -1);
          pad.x = P.x + nx * (PR + KR); pad.y = P.y + ny * (PR + KR); hkClampPad(k, pad);
        }
      }
      w.kick -= dt;
      if (w.kick <= 0) w.phase = "play";
      return;
    }
    // integrate puck
    const fr = Math.exp(-HK.FRIC * dt);
    P.vx *= fr; P.vy *= fr;
    P.x += P.vx * dt; P.y += P.vy * dt;
    // paddles
    for (let k = 0; k < 2; k++) {
      const pad = w.pads[k], dx = P.x - pad.x, dy = P.y - pad.y, d = Math.hypot(dx, dy);
      if (d < PR + KR) {
        const nx = d > 1e-6 ? dx / d : 0, ny = d > 1e-6 ? dy / d : (k === 0 ? -1 : 1);
        P.x = pad.x + nx * (PR + KR); P.y = pad.y + ny * (PR + KR);
        const rvn = (P.vx - pad.vx) * nx + (P.vy - pad.vy) * ny;
        if (rvn < 0) { P.vx -= (1 + HK.PAD_E) * rvn * nx; P.vy -= (1 + HK.PAD_E) * rvn * ny; }
      }
    }
    const sp = Math.hypot(P.vx, P.vy);
    if (sp > HK.MAXV) { P.vx *= HK.MAXV / sp; P.vy *= HK.MAXV / sp; }
    w.maxSpeed = Math.max(w.maxSpeed, Math.min(sp, HK.MAXV));
    // side walls
    if (P.x < KR) { P.x = KR; P.vx = Math.abs(P.vx) * HK.WALL_E; }
    else if (P.x > W - KR) { P.x = W - KR; P.vx = -Math.abs(P.vx) * HK.WALL_E; }
    // end walls, goal mouths and posts
    const inMouth = P.x > GL && P.x < GR;
    if (P.y < KR) {
      if (inMouth) { hkPost(P, GL, 0); hkPost(P, GR, 0); }
      else { P.y = KR; P.vy = Math.abs(P.vy) * HK.WALL_E; }
    } else if (P.y > H - KR) {
      if (inMouth) { hkPost(P, GL, H); hkPost(P, GR, H); }
      else { P.y = H - KR; P.vy = -Math.abs(P.vy) * HK.WALL_E; }
    }
    // a pad pinning the puck against a wall gets pushed out of it (puck stays on the table)
    for (let k = 0; k < 2; k++) {
      const pad = w.pads[k], dx = pad.x - P.x, dy = pad.y - P.y, d = Math.hypot(dx, dy);
      if (d < PR + KR - 0.01) {
        const nx = d > 1e-6 ? dx / d : 0, ny = d > 1e-6 ? dy / d : (k === 0 ? 1 : -1);
        pad.x = P.x + nx * (PR + KR); pad.y = P.y + ny * (PR + KR); hkClampPad(k, pad);
      }
    }
    // sanity: NaN or escape → count and reset (tests assert both stay 0)
    if (!isFinite(P.x) || !isFinite(P.y) || !isFinite(P.vx) || !isFinite(P.vy)) { w.nan++; hkKickoff(w); return; }
    if (P.x < KR - 0.5 || P.x > W - KR + 0.5 || P.y < -KR || P.y > H + KR || (P.y < 0 && !inMouth) || (P.y > H && !inMouth)) { w.escapes++; hkKickoff(w); return; }
    if (P.y < 0 && P.x > GL && P.x < GR) { hkGoal(w, 0); return; }
    if (P.y > H && P.x > GL && P.x < GR) { hkGoal(w, 1); return; }
    // clock
    w.clock += dt;
    if (w.sudden) w.sdClock += dt;
    if (!w.sudden && w.clock >= w.time) {
      if (w.score[0] !== w.score[1]) { w.over = true; w.phase = "over"; }
      else w.sudden = true;
    } else if (w.sudden && w.sdClock >= w.sd) { w.over = true; w.phase = "over"; }
  }
  function hkReflectX(x) {
    const a = HK.KR, b = HK.W - HK.KR, span = b - a;
    let u = (x - a) % (2 * span); if (u < 0) u += 2 * span;
    return a + (u > span ? 2 * span - u : u);
  }
  /* AI controller. Canonical frame: own goal at y=0, own half y < H/2. */
  /* AI parameters from skill. Human proxy (tests/calibration only): fast hand, ~200 ms reaction, casual aim. */
  function hkParams(skill) {
    const s = clamp(skill, 0.05, 0.98);
    const P = { s, delay: 0.3 - 0.14 * s, maxV: 480 + 1100 * s, defErr: 13 + 40 * (1 - s), aimErr: 26 + 85 * (1 - s),
      bank: 0.15 + 0.45 * s, power: 25 + 40 * s, defDepth: 0.2 + 0.8 * s, passive: 0 };
    if (s < 0.4) { // beginner band: noticeably slower, sloppier and less aggressive
      const k = (0.4 - s) / 0.35;
      P.delay += 0.12 * k; P.maxV *= 1 - 0.3 * k; P.aimErr += 70 * k; P.defErr += 25 * k;
      P.power -= 12 * k; P.bank *= 1 - 0.8 * k; P.passive = 0.25 + 0.4 * k;
    }
    if (s < 0.65) { // below "strong": leakier defence, slower reads (a casual human should win most games at 0.5)
      const k = (0.65 - s) / 0.55;
      P.defErr += 40 * k; P.delay += 0.1 * k; P.maxV *= 1 - 0.2 * k;
    }
    return P;
  }
  /* human proxies for calibration: 'casual' = ordinary player (quick hand, ~250 ms reaction, loose aim),
     'good' = strong player */
  const HK_HUMAN = { casual: { s: 0.45, delay: 0.25, maxV: 2000, defErr: 36, aimErr: 70, bank: 0.15, power: 55, defDepth: 0.45, passive: 0 },
    good: { s: 0.75, delay: 0.19, maxV: 3000, defErr: 18, aimErr: 35, bank: 0.4, power: 70, defDepth: 0.8, passive: 0 } };
  /* AI controller. Canonical frame: own goal at y=0, own half y < H/2. */
  function hkAI(skill, rng, params) {
    const P = params || hkParams(skill);
    const ai = Object.assign({ rng, err: 0, err2: 0, errT: 0, tgt: null, think: 0, shot: 0 }, P);
    ai.delaySteps = Math.round(ai.delay * HK.HZ);
    const fn = function (w, k) {
      w.pads[k].maxV = ai.maxV;
      if (ai.think-- > 0 && ai.tgt) return ai.tgt;
      ai.think = 3;
      if (ai.errT-- <= 0) {
        ai.err = U.gauss(rng); ai.err2 = U.gauss(rng); ai.errT = 15 + Math.floor(rng() * 20);
        ai.shot = rng() < ai.bank ? (rng() < 0.5 ? -1 : 1) : 0;
        ai.hold = rng() < ai.passive; // passive window: guard the goal instead of attacking
      }
      const N = HK.HIST, j = (((w.hi - 1 - ai.delaySteps) % N) + N) % N * 4;
      const flip = k === 0, H = HK.H;
      const p = { x: w.hist[j], y: flip ? H - w.hist[j + 1] : w.hist[j + 1], vx: w.hist[j + 2], vy: flip ? -w.hist[j + 3] : w.hist[j + 3] };
      const pad = w.pads[k], me = { x: pad.x, y: flip ? H - pad.y : pad.y };
      const t = hkDecide(w, k, p, me, ai);
      ai.tgt = { x: t.x, y: flip ? H - t.y : t.y };
      return ai.tgt;
    };
    fn.ai = ai;
    return fn;
  }
  function hkDecide(w, k, p, me, ai) {
    const { W, H, PR, KR } = HK, s = ai.s, homeY = 46, reach = PR + KR;
    const lo = PR, hi = W - PR;
    if (w.phase === "kick") {
      if (w.serve === k) return { x: p.x + ai.err * 8, y: p.y - (reach + 16) };
      return { x: W / 2, y: homeY };
    }
    const comp = ai.delay * (0.2 + 0.8 * s) + 0.03;
    const qx = hkReflectX(p.x + p.vx * comp), qy = p.y + p.vy * comp;
    // clear a puck that is level with / behind the paddle by sweeping it sideways from the goal-centre side,
    // never pushing it toward our own goal
    const sweep = () => {
      const side = qx >= W / 2 ? 1 : -1, py = Math.max(PR, qy);
      const onCentreSide = (qx - me.x) * side > reach * 0.6;
      if (onCentreSide) return { x: qx + side * 40, y: py };
      if (Math.abs(me.x - qx) < reach + 6 && me.y < qy + reach + 8) return { x: me.x, y: qy + reach + 18 };
      return { x: qx - side * (reach + 8), y: py };
    };
    const strike = (aimX, aimY) => {
      let dx = aimX - qx, dy = aimY - qy;
      const dl = Math.hypot(dx, dy) || 1; dx /= dl; dy /= dl;
      const ax = qx - dx * (reach + 4), ay = qy - dy * (reach + 4);
      const cax = clamp(ax, lo, hi), cay = clamp(ay, PR, H / 2 - 6);
      const tx = qx - me.x, ty = qy - me.y, tl = Math.hypot(tx, ty) || 1;
      const align = (tx * dx + ty * dy) / tl;
      if (Math.hypot(cax - ax, cay - ay) > 6) { // can't get behind the puck
        if (ty < reach * 0.5) return sweep();
        return { x: qx + tx / tl * 45, y: qy + ty / tl * 45 };
      }
      if (align > 0.8 || Math.hypot(ax - me.x, ay - me.y) < 8) return { x: qx + dx * ai.power, y: qy + dy * ai.power };
      return { x: ax, y: ay };
    };
    // incoming puck from the far side: intercept on a defensive line
    if (p.vy < -120 && qy > me.y + 60) {
      const defY = homeY + 6 + 60 * ai.defDepth;
      const tHit = Math.max(0, (qy - defY) / -p.vy);
      const x = hkReflectX(qx + p.vx * tHit) + ai.err * ai.defErr;
      return { x, y: defY };
    }
    if (qy < H / 2 + KR) {
      const slow = Math.hypot(p.vx, p.vy) < 160;
      if (ai.hold && !slow && qy > homeY + 40) return { x: W / 2 + (qx - W / 2) * 0.5, y: homeY };
      if (qy > me.y - 2) {
        // aim: straight at a point in the goal mouth, or a bank shot off a side wall
        let gx = W / 2 + ai.err2 * ai.aimErr;
        if (ai.shot) { const wallX = ai.shot < 0 ? KR : W - KR; gx = 2 * wallX - (W / 2 + ai.err2 * ai.aimErr * 0.6); }
        return strike(gx, H + 30);
      }
      if (qy < reach + 6) return sweep(); // hugging my end wall // hugging my end wall: clear it sideways
      let side = me.x >= qx ? 1 : -1;
      const off = reach + 10;
      if (qx + side * off > hi || qx + side * off < lo) side = -side;
      if (Math.abs(me.x - qx) < off) return { x: qx + side * off, y: me.y };
      return { x: qx + side * off * 0.6, y: qy - off };
    }
    return { x: W / 2 + (qx - W / 2) * 0.35 + ai.err * ai.defErr * 0.3, y: homeY };
  }
  DG.css("hockey", `
    .g-hockey{display:grid;gap:10px}
    .g-hockey-hud{display:grid;grid-template-columns:1fr auto 1fr;align-items:center;gap:8px}
    .g-hockey-hud .g-hockey-side{display:flex;gap:8px;align-items:baseline;min-width:0}
    .g-hockey-hud .g-hockey-side span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600}
    .g-hockey-hud .g-hockey-side.r{justify-content:flex-end}
    .g-hockey-hud b{font-family:var(--f-mono);font-size:28px;font-variant-numeric:tabular-nums;line-height:1}
    .g-hockey-clock{font-family:var(--f-mono);font-size:18px;font-variant-numeric:tabular-nums;background:var(--panel-2);border:1px solid var(--line);border-radius:var(--r-sm);padding:4px 10px}
    .g-hockey-stage{line-height:0}
    .g-hockey-stage canvas{border-radius:var(--r-lg);cursor:none}`);

  function hkMount(ctx, names, colors) {
    ctx.root.innerHTML = `<div class="g-hockey">
      <div class="g-hockey-hud"><div class="g-hockey-side"><b style="color:${colors[0]}" data-test="score-0">0</b><span style="color:${colors[0]}">${U.esc(names[0])}</span></div>
        <div class="g-hockey-clock" data-test="clock">2:00</div>
        <div class="g-hockey-side r"><span style="color:${colors[1]}">${U.esc(names[1])}</span><b style="color:${colors[1]}" data-test="score-1">0</b></div></div>
      <div class="g-hockey-stage" data-test="stage"></div>
      <p class="dg-note" data-test="hint"></p></div>`;
    const stage = ctx.root.querySelector("[data-test=stage]");
    const view = canvasView(ctx, stage, (cw) => {
      const land = cw >= 600;
      const lw = land ? HK.H : HK.W, lh = land ? HK.W : HK.H;
      const maxH = Math.max(320, (window.innerHeight || 800) - 170);
      let cssW = cw, cssH = cw * lh / lw;
      if (cssH > maxH) { cssH = maxH; cssW = cssH * lw / lh; }
      return { lw, lh, cssW: Math.round(cssW), cssH: Math.round(cssH), land };
    });
    view.cv.dataset.test = "canvas";
    // physics <-> screen-logical
    view.toPhys = (e, upCss) => {
      const l = view.toLogical(e);
      if (upCss) l.y -= upCss / view.scale; // screen-up offset (touch: keep the paddle visible above the finger)
      return view.meta.land ? { x: l.y, y: HK.H - l.x } : { x: l.x, y: l.y };
    };
    view.physToClient = (x, y) => view.meta.land ? view.toClient(HK.H - y, x) : view.toClient(x, y);
    return view;
  }
  function hkTable(view, K, colors) {
    const { W, H } = HK;
    return (g) => {
      if (view.meta.land) g.transform(0, 1, -1, 0, H, 0);
      g.fillStyle = "#15182c"; g.fillRect(0, 0, W, H);
      g.strokeStyle = K.line; g.lineWidth = 2;
      g.strokeRect(1, 1, W - 2, H - 2);
      g.strokeStyle = "rgba(157,155,192,.35)"; g.lineWidth = 2;
      g.beginPath(); g.moveTo(0, H / 2); g.lineTo(W, H / 2); g.stroke();
      g.beginPath(); g.arc(W / 2, H / 2, 42, 0, TAU); g.stroke();
      g.beginPath(); g.arc(W / 2, 0, 62, 0, Math.PI); g.stroke();
      g.beginPath(); g.arc(W / 2, H, 62, Math.PI, TAU); g.stroke();
      g.lineWidth = 7;
      g.strokeStyle = colors[1]; g.beginPath(); g.moveTo(GL, 2); g.lineTo(GR, 2); g.stroke();
      g.strokeStyle = colors[0]; g.beginPath(); g.moveTo(GL, H - 2); g.lineTo(GR, H - 2); g.stroke();
    };
  }
  function hkDraw(view, w, K, colors, names, extraText) {
    const g = view.g, { H, PR, KR } = HK;
    if (!view.tableFn) view.tableFn = hkTable(view, K, colors);
    view.blit(view.tableFn); // static table from the cached layer
    if (view.meta.land) g.transform(0, 1, -1, 0, H, 0);
    // pads
    for (let k = 0; k < 2; k++) {
      const p = w.pads[k];
      g.fillStyle = colors[k]; g.beginPath(); g.arc(p.x, p.y, PR, 0, TAU); g.fill();
      g.fillStyle = "rgba(0,0,0,.28)"; g.beginPath(); g.arc(p.x, p.y, PR * 0.62, 0, TAU); g.fill();
      g.fillStyle = colors[k]; g.beginPath(); g.arc(p.x, p.y, PR * 0.36, 0, TAU); g.fill();
    }
    // puck
    const P = w.puck;
    g.fillStyle = K.fg; g.beginPath(); g.arc(P.x, P.y, KR, 0, TAU); g.fill();
    g.strokeStyle = "#8f8db0"; g.lineWidth = 2; g.beginPath(); g.arc(P.x, P.y, KR * 0.6, 0, TAU); g.stroke();
    // overlay text in unrotated screen space
    view.reset();
    g.textAlign = "center"; g.textBaseline = "middle";
    const cx = view.lw / 2, cy = view.lh / 2;
    let big = null, small = null;
    if (w.phase === "kick" && w.steps > 2) {
      big = String(Math.max(1, Math.ceil(w.kick / (HK.KICK / 3))));
      small = (w.lastGoal >= 0 ? `Goal ${names[w.lastGoal]}! ` : "") + `${names[w.serve]} serve${w.serve === 0 && names[0] === "You" ? "" : "s"}`;
    }
    if (w.sudden && w.phase !== "over" && !big) small = "Sudden death";
    if (extraText) { big = extraText; small = null; }
    g.lineJoin = "round";
    if (big) {
      g.font = `900 64px ${K.display}`;
      const fitW = view.lw * 0.86, mw = g.measureText(big).width;
      if (mw > fitW) g.font = `900 ${Math.floor(64 * fitW / mw)}px ${K.display}`;
      g.lineWidth = 8; g.strokeStyle = "rgba(0,0,0,.6)";
      g.strokeText(big, cx, cy - (view.meta.land ? 0 : 60)); g.fillStyle = K.gold; g.fillText(big, cx, cy - (view.meta.land ? 0 : 60));
    }
    if (small) {
      g.font = `700 17px ${K.body}`; g.lineWidth = 5; g.strokeStyle = "rgba(0,0,0,.7)";
      const y = cy + (view.meta.land ? 48 : -10);
      g.strokeText(small, cx, y); g.fillStyle = K.fg; g.fillText(small, cx, y);
    }
  }
  /* HUD writer that touches the DOM only when something changed; returns the clock text on change */
  function hkHud($s0, $s1, $clk) {
    let a = -1, b = -1, sec = -1, sd = null;
    return (w) => {
      const rem = w.sudden ? w.sd - w.sdClock : w.time - w.clock, s2 = Math.max(0, Math.ceil(rem));
      if (w.score[0] === a && w.score[1] === b && s2 === sec && w.sudden === sd) return null;
      if (w.score[0] !== a) $s0.textContent = a = w.score[0];
      if (w.score[1] !== b) $s1.textContent = b = w.score[1];
      sec = s2; sd = w.sudden;
      const c = hkClock(w); $clk.textContent = c;
      return c;
    };
  }
  function hkClock(w) {
    if (w.sudden) return "SD " + mmss(w.sd - w.sdClock);
    return mmss(w.time - w.clock);
  }
  function hkRun(ctx, w, ctrl, view, onFrame, onOver) {
    let last = ctx.now(), acc = 0, frames = 0;
    function frame(now) {
      frames++;
      acc += Math.max(0, now - last); last = now;
      let n = 0;
      while (acc >= HK_STEP_MS && n < 1200 && !w.over) { hkStep(w, ctrl); acc -= HK_STEP_MS; n++; }
      if (n >= 1200) acc = 0;
      onFrame();
      if (w.over) return onOver();
      ctx.raf(frame);
    }
    ctx.raf(frame);
    return { frames: () => frames };
  }
  function hkStress(n, seed) {
    const rng = U.rng("stress|" + seed);
    const w = hkNew(0, { win: 1e9, time: 1e9 });
    const a0 = hkAI(0.3 + rng() * 0.6, rng), a1 = hkAI(0.3 + rng() * 0.6, rng);
    let rt = { x: 150, y: 400 };
    const chaos = (w2, k) => { // erratic, fast human-like pointer
      if (rng() < 0.05) rt = { x: rng() * HK.W, y: HK.H / 2 + rng() * HK.H / 2 };
      return rt;
    };
    const ctrl = [chaos, a1];
    let minX = 1e9, maxX = -1e9, minY = 1e9, maxY = -1e9;
    for (let i = 0; i < n; i++) {
      if (i % 2000 === 1000) ctrl[0] = ctrl[0] === chaos ? a0 : chaos;
      if (i % 997 === 0 && w.phase === "play") { w.puck.vx = (rng() - 0.5) * 4000; w.puck.vy = (rng() - 0.5) * 4000; }
      hkStep(w, ctrl);
      const P = w.puck;
      minX = Math.min(minX, P.x); maxX = Math.max(maxX, P.x); minY = Math.min(minY, P.y); maxY = Math.max(maxY, P.y);
    }
    return { steps: w.steps, escapes: w.escapes, nan: w.nan, goals: w.goals.length, maxSpeed: Math.round(w.maxSpeed), minX, maxX, minY, maxY };
  }
  /* headless AI-vs-AI match (used by tests to show strength ordering) */
  function hkSim(seed, s0, s1) { // s0 may be 'casual' or 'good' (human proxy)
    const w = hkNew(U.rng(seed + "|hockey")() < 0.5 ? 0 : 1);
    const mk = (x, tag) => typeof x === "string" ? hkAI(0.5, U.rng(seed + tag), HK_HUMAN[x]) : hkAI(x, U.rng(seed + tag));
    const ctrl = [mk(s0, "|ai0"), mk(s1, "|ai1")];
    while (!w.over && w.steps < HK.HZ * 400) hkStep(w, ctrl);
    return { score: w.score.slice(), steps: w.steps, clock: r2(w.clock), sudden: w.sudden, escapes: w.escapes, nan: w.nan };
  }

  DG.registerGame({
    id: "hockey", name: "Air Hockey", category: "reflex", kind: "versus", formats: ["1v1", "tournament"],
    skill: 8, luck: 2, cashEligible: true, duration: "2 min", pack: "reflex",
    blurb: "Real-time air hockey. Guard your goal, bank shots off the walls, first to 5.",
    rules: [
      "Move your gold paddle with the mouse or your finger; it stays in your half.",
      "On touch the paddle sits just above your finger so you can see it.",
      "Hit the puck into the red goal at the far end. Paddle speed adds power.",
      "First to 5 goals wins. After 2 minutes the leader wins.",
      "Level after 2 minutes: 30 s sudden death, then a draw.",
      "Serve alternates after every goal.",
    ],
    scoreLabel: "goals",
    play(ctx) {
      const opp = ctx.opponents[0] || { name: "Rival", skill: 0.5 };
      const K = tokens(ctx.root);
      const names = ["You", opp.name || "Rival"], colors = [K.gold, K.rival];
      const view = hkMount(ctx, names, colors);
      ctx.root.querySelector("[data-test=hint]").textContent = "Move over the table to steer your paddle (on touch it sits just above your finger). Score in the red goal.";
      const w = hkNew(U.rng(ctx.seed + "|hockey")() < 0.5 ? 0 : 1);
      const aiOpp = hkAI(opp.skill != null ? opp.skill : 0.5, U.rng(ctx.seed + "|ai1"));
      let target = { x: w.pads[0].x, y: w.pads[0].y };
      const human = () => target;
      const ctrl = [human, aiOpp];
      const status = statusSetter(ctx);
      const cv = view.cv;
      const TOUCH_UP = 56; // css px
      const move = (e) => { if (ctx.signal.ended) return; target = view.toPhys(e, e.pointerType === "touch" ? TOUCH_UP : 0); };
      cv.addEventListener("pointermove", (e) => { e.preventDefault(); move(e); });
      cv.addEventListener("pointerdown", (e) => { e.preventDefault(); try { cv.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ } move(e); });
      const $s0 = ctx.root.querySelector("[data-test=score-0]"), $s1 = ctx.root.querySelector("[data-test=score-1]"), $clk = ctx.root.querySelector("[data-test=clock]");
      const hud = hkHud($s0, $s1, $clk);
      const onFrame = () => {
        hkDraw(view, w, K, colors, names);
        const c = hud(w);
        if (c) status(`${c} · ${w.score[0]}–${w.score[1]}`);
      };
      const onOver = () => {
        view.stop();
        const [a, b] = w.score;
        const outcome = a > b ? "win" : a < b ? "loss" : "draw";
        hkDraw(view, w, K, colors, names, outcome === "win" ? "YOU WIN" : outcome === "loss" ? "YOU LOSE" : "DRAW");
        const played = w.clock;
        ctx.end({
          outcome, myScore: a, oppScore: b,
          detail: `<p class="dg-note"><b class="dg-gold">You ${a}</b> – <b class="dg-rival">${b} ${U.esc(names[1])}</b> · ${mmss(played)} played${w.sudden ? " · sudden death" : ""}</p>`,
        });
      };
      const run = hkRun(ctx, w, ctrl, view, onFrame, onOver);
      ctx.test = {
        state: () => ({ score: w.score.slice(), clock: w.clock, phase: w.phase, sudden: w.sudden, steps: w.steps, puck: Object.assign({}, w.puck),
          pads: w.pads.map((p) => ({ x: p.x, y: p.y })), escapes: w.escapes, nan: w.nan, land: !!view.meta.land, over: w.over }),
        forceGoal(side) { if (!w.over) hkGoal(w, side === "opp" || side === 1 ? 1 : 0); },
        setClock(sec, sdSec) { if (sec != null) w.clock = sec; if (sdSec != null) { w.sudden = true; w.sdClock = sdSec; } },
        autoplay(skill) { ctrl[0] = hkAI(skill == null ? 0.7 : skill, U.rng(ctx.seed + "|auto")); },
        physToClient: (x, y) => view.physToClient(x, y),
        frames: () => run.frames(),
        stress: (n, seed) => hkStress(n || 10000, seed || 1),
        sim: (seed, s0, s1) => hkSim(seed, s0, s1),
      };
    },
    spectate(ctx) {
      const pl = ctx.players || [{ name: "Left", skill: 0.5 }, { name: "Right", skill: 0.5 }];
      const K = tokens(ctx.root);
      const names = [pl[0].name, pl[1].name], colors = [K.ally, K.rival];
      const view = hkMount(ctx, names, colors);
      ctx.root.querySelector("[data-test=hint]").textContent = `${names[0]} (blue) vs ${names[1]} (red). First to 5.`;
      const w = hkNew(U.rng(ctx.seed + "|hockey")() < 0.5 ? 0 : 1);
      const ctrl = [hkAI(pl[0].skill != null ? pl[0].skill : 0.5, U.rng(ctx.seed + "|ai0")), hkAI(pl[1].skill != null ? pl[1].skill : 0.5, U.rng(ctx.seed + "|ai1"))];
      const status = statusSetter(ctx);
      const $s0 = ctx.root.querySelector("[data-test=score-0]"), $s1 = ctx.root.querySelector("[data-test=score-1]"), $clk = ctx.root.querySelector("[data-test=clock]");
      const hud = hkHud($s0, $s1, $clk);
      const onFrame = () => {
        hkDraw(view, w, K, colors, names);
        const c = hud(w);
        if (c) status(`${c} · ${names[0]} ${w.score[0]}–${w.score[1]} ${names[1]}`);
      };
      const onOver = () => {
        view.stop();
        const [a, b] = w.score;
        const winner = a > b ? 0 : a < b ? 1 : -1;
        hkDraw(view, w, K, colors, names, winner < 0 ? "DRAW" : names[winner].toUpperCase() + " WINS");
        ctx.end({ winner, scores: [a, b] });
      };
      const run = hkRun(ctx, w, ctrl, view, onFrame, onOver);
      ctx.test = {
        state: () => ({ score: w.score.slice(), clock: w.clock, steps: w.steps, goals: w.goals.slice(), escapes: w.escapes, nan: w.nan, over: w.over }),
        frames: () => run.frames(),
      };
    },
  });
})();
