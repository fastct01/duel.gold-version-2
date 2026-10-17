/* PlayVault — Pack B: BRAIN.
   Five race games: Sudoku Sprint, Mine Sweep, Royal Grid, Merge 2048, Memory Duel.
   All content comes from the match seed, so both sides always face the identical challenge.
   Each game def also carries a `lab` object (generators, solvers, human reference) used only by tests. */
(function () {
  "use strict";
  if (!window.DG || !DG.registerGame) return;
  const U = DG.util;
  const FORMATS = ["1v1", "2v2", "ffa", "tournament", "mix"];

  /* ---------------- shared helpers ---------------- */
  const clock = (sec) => { sec = Math.max(0, Math.ceil(sec - 1e-9)); return Math.floor(sec / 60) + ":" + String(sec % 60).padStart(2, "0"); };
  const ln = (rng, s) => Math.exp(U.gauss(rng) * s);
  const plural = (n, w, ws) => n + " " + (n === 1 ? w : ws || w + "s");
  const r2 = (x) => Math.round(x * 100) / 100;
  const popc = (m) => { let c = 0; while (m) { m &= m - 1; c++; } return c; };
  const CACHE = new Map();
  function memo(key, fn) {
    if (CACHE.has(key)) return CACHE.get(key);
    const v = fn();
    if (CACHE.size > 80) CACHE.delete(CACHE.keys().next().value);
    CACHE.set(key, v);
    return v;
  }
  function hud(id, items) {
    return `<div class="g-${id}-hud">${items.map(([k, l]) =>
      `<div class="g-${id}-stat"><span>${l}</span><b class="dg-mono" data-k="${k}" data-test="hud-${k}">–</b></div>`).join("")}</div>`;
  }
  const hudCss = (id) => `
    .g-${id}-hud{display:grid;grid-template-columns:repeat(auto-fit,minmax(70px,1fr));gap:6px}
    .g-${id}-stat{background:var(--panel);border:1px solid var(--line);border-radius:var(--r-sm);padding:5px 8px;line-height:1.2;min-width:0;overflow:hidden}
    .g-${id}-stat span{display:block;font-size:10px;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .g-${id}-stat b{display:block;font-size:clamp(14px,4.2vw,17px);white-space:nowrap;overflow:hidden;text-overflow:clip}`;
  /* Stop PageUp/PageDown/Home/End/Space from scrolling the page while a board is shown. Text fields keep their
     keys, and Space on a focused button is left alone so it still activates the button. Removed at end/abort. */
  const SCROLL_KEYS = new Set(["PageUp", "PageDown", "Home", "End", " ", "Spacebar"]);
  const inField = (e) => { const t = e.target; return !!(t && t.closest && t.closest("input,textarea,select,[contenteditable=''],[contenteditable=true]")); };
  /* game key handlers go through this so typing in a text field (e.g. platform chat) never drives the board */
  const gameKeys = (ctx) => (fn) => ctx.onKey((e) => { if (!inField(e)) fn(e); });
  function blockScrollKeys(ctx) {
    ctx.onKey((e) => {
      if (!SCROLL_KEYS.has(e.key) || e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
      const t = e.target;
      if (inField(e)) return;
      if ((e.key === " " || e.key === "Spacebar") && t && t.closest && t.closest("button,[role=button],a[href]")) return;
      e.preventDefault();
    });
  }
  const setHud = (root, k, v) => { const e = root.querySelector(`[data-k="${k}"]`); if (e && e.textContent !== String(v)) e.textContent = v; };
  const detailBox = (lines) => `<div class="dg-stack" style="gap:4px">${lines.map((l, i) => `<p class="${i ? "dg-note" : ""}" style="margin:0">${l}</p>`).join("")}</div>`;

  /* ====================================================================
     1. SUDOKU SPRINT
     ==================================================================== */
  const SDK_SHAPES = {};
  function sdkShape(mode) {
    const key = mode === "mix" ? "mix" : "full";
    if (SDK_SHAPES[key]) return SDK_SHAPES[key];
    const n = key === "mix" ? 6 : 9, br = key === "mix" ? 2 : 3, bc = 3, N = n * n;
    const row = [], col = [], box = [];
    for (let i = 0; i < N; i++) {
      const r = (i / n) | 0, c = i % n;
      row.push(r); col.push(c); box.push(((r / br) | 0) * (n / bc) + ((c / bc) | 0));
    }
    const units = [];
    for (let u = 0; u < n; u++) {
      units.push(row.map((v, i) => (v === u ? i : -1)).filter((i) => i >= 0));
      units.push(col.map((v, i) => (v === u ? i : -1)).filter((i) => i >= 0));
      units.push(box.map((v, i) => (v === u ? i : -1)).filter((i) => i >= 0));
    }
    const peers = [];
    for (let i = 0; i < N; i++) {
      const p = [];
      for (let j = 0; j < N; j++) if (j !== i && (row[j] === row[i] || col[j] === col[i] || box[j] === box[i])) p.push(j);
      peers.push(p);
    }
    return (SDK_SHAPES[key] = { key, n, br, bc, N, row, col, box, units, peers, FULL: (1 << (n + 1)) - 2 });
  }

  /* Bitmask backtracking solver with MRV. Counts solutions up to `limit`. With rng: random digit order. */
  function sdkSolve(grid, S, limit, rng) {
    const { n, N, row, col, box, FULL } = S;
    const g = grid.slice(), R = new Array(n).fill(0), C = new Array(n).fill(0), B = new Array(n).fill(0);
    for (let i = 0; i < N; i++) if (g[i]) {
      const b = 1 << g[i];
      if ((R[row[i]] | C[col[i]] | B[box[i]]) & b) return { count: 0, sol: null, nodes: 0 };
      R[row[i]] |= b; C[col[i]] |= b; B[box[i]] |= b;
    }
    let count = 0, sol = null, nodes = 0;
    (function rec() {
      let best = -1, bm = 0, bcnt = 99;
      for (let i = 0; i < N; i++) if (!g[i]) {
        const m = FULL & ~(R[row[i]] | C[col[i]] | B[box[i]]);
        if (!m) return;
        const k = popc(m);
        if (k < bcnt) { bcnt = k; bm = m; best = i; if (k === 1) break; }
      }
      if (best < 0) { count++; if (!sol) sol = g.slice(); return; }
      let ds = [];
      for (let d = 1; d <= n; d++) if (bm & (1 << d)) ds.push(d);
      if (rng) ds = U.shuffle(rng, ds);
      const r = row[best], c = col[best], x = box[best];
      for (const d of ds) {
        nodes++;
        const b = 1 << d;
        g[best] = d; R[r] |= b; C[c] |= b; B[x] |= b;
        rec();
        g[best] = 0; R[r] &= ~b; C[c] &= ~b; B[x] &= ~b;
        if (count >= limit) return;
      }
    })();
    return { count, sol, nodes };
  }

  /* Human-style rating: rounds of naked/hidden singles; if stuck, one "hard" step. */
  function sdkRate(puz, sol, S) {
    const { N, units, peers, FULL } = S;
    const g = puz.slice(), steps = [];
    let left = g.filter((v) => !v).length, hard = 0;
    while (left > 0) {
      const cand = new Array(N).fill(0);
      for (let i = 0; i < N; i++) if (!g[i]) { let m = FULL; for (const p of peers[i]) if (g[p]) m &= ~(1 << g[p]); cand[i] = m; }
      const found = new Set();
      for (let i = 0; i < N; i++) if (!g[i] && popc(cand[i]) === 1) found.add(i);
      for (const u of units) for (let d = 1; d <= S.n; d++) {
        let cnt = 0, last = -1;
        for (const i of u) if (!g[i] && cand[i] & (1 << d)) { cnt++; last = i; if (cnt > 1) break; }
        if (cnt === 1) found.add(last);
      }
      if (found.size) {
        for (const i of found) { g[i] = sol[i]; left--; steps.push({ i, avail: found.size, hard: false }); }
      } else {
        let best = -1, bc = 99;
        for (let i = 0; i < N; i++) if (!g[i]) { const k = popc(cand[i]); if (k < bc) { bc = k; best = i; } }
        g[best] = sol[best]; left--; hard++;
        steps.push({ i: best, avail: 0, hard: true });
      }
    }
    return { steps, hard };
  }

  function sdkGenerate(seed, mode) {
    mode = mode === "mix" ? "mix" : "full";
    const S = sdkShape(mode);
    return memo("sdk|" + mode + "|" + seed, () => {
      const rng = U.rng("sudoku|" + mode + "|" + seed);
      const sol = sdkSolve(new Array(S.N).fill(0), S, 1, rng).sol;
      const target = mode === "mix" ? U.randInt(rng, 19, 21) : U.randInt(rng, 31, 36);
      const puz = sol.slice();
      let givens = S.N;
      for (const i of U.shuffle(rng, [...Array(S.N).keys()])) {
        if (givens <= target) break;
        const j = S.N - 1 - i;              // 180° symmetric partner
        if (!puz[i] || !puz[j]) continue;
        const k = i === j ? 1 : 2;
        if (givens - k < target - 1) continue;
        const a = puz[i], b = puz[j];
        puz[i] = 0; puz[j] = 0;
        if (sdkSolve(puz, S, 2).count !== 1) { puz[i] = a; puz[j] = b; } else givens -= k;
      }
      const rate = sdkRate(puz, sol, S);
      return { mode, S, puzzle: puz, solution: sol, givens, empties: S.N - givens, steps: rate.steps, hard: rate.hard };
    });
  }

  const SDK_LIMIT = { full: 360, mix: 45 };
  const sdkScore = (solved, leftSec, mistakes, correct) => (solved ? 3000 + leftSec * 5 - 150 * mistakes : 25 * correct);

  /* Simulated solve of the actual puzzle. p = {perCell, mistakeP, startup}; rng null = no noise. */
  function sdkSim(P, p, rng) {
    const LIMIT = SDK_LIMIT[P.mode];
    const tl = [[0, 0]];
    let t = p.startup, filled = 0, m = 0, why = "time";
    for (const st of P.steps) {
      const f = st.hard ? 3.2 : 0.75 + 1.5 / (1 + st.avail);
      let dt = p.perCell * f * (rng ? ln(rng, 0.35) : 1);
      if (rng && rng() < p.mistakeP) {
        const tm = t + dt * 0.6;
        if (tm > LIMIT) break;
        t = tm; m++;
        if (m >= 3) { why = "mistakes"; break; }
      }
      if (t + dt > LIMIT) break;
      t += dt; filled++;
      if (filled === P.empties) {
        const score = sdkScore(true, Math.floor(LIMIT - t), m, filled);
        tl.push([r2(t), score]);
        return { score, timeline: tl, solved: true, t, mistakes: m };
      }
      tl.push([r2(t), 25 * filled]);
    }
    const score = 25 * filled;
    tl.push([r2(why === "mistakes" ? t : LIMIT), score]);
    return { score, timeline: tl, solved: false, t: why === "mistakes" ? t : LIMIT, mistakes: m, why };
  }
  const K_FULL = 7.0, K_MIX = 2.6, SLOPE = 1.8, SPREAD = 0.45;
  function sdkBot(seed, skill, rng, mode) {
    const P = sdkGenerate(seed, mode);
    /* log-linear pace in skill with a wide per-bot spread, so the finish rate climbs gradually with skill
       (roughly 10% at 0.2, 55% at 0.5, 85% at 0.8) instead of jumping from 0 to 100% over a narrow band */
    const K = mode === "mix" ? K_MIX : K_FULL;
    const base = K * Math.exp(-SLOPE * (skill - 0.5)) * ln(rng, SPREAD);
    return sdkSim(P, { perCell: base, mistakeP: 0.04 * Math.pow(1 - skill, 1.5), startup: 2 }, rng);
  }

  DG.css("sudoku", hudCss("sudoku") + `
    .g-sudoku{container-type:inline-size;display:grid;gap:12px;user-select:none;-webkit-user-select:none}
    .g-sudoku-main{display:grid;gap:12px;justify-items:center}
    .g-sudoku-side{display:grid;gap:10px;width:100%;max-width:460px;align-content:start}
    .g-sudoku-board{width:100%;max-width:460px;aspect-ratio:1;display:grid;grid-template-columns:repeat(var(--n),minmax(0,1fr));
      grid-template-rows:repeat(var(--n),minmax(0,1fr));border:2px solid var(--muted);border-radius:var(--r-sm);overflow:hidden;
      background:var(--panel);container-type:inline-size;touch-action:manipulation}
    .g-sudoku-cell{border:0;border-right:1px solid var(--line);border-bottom:1px solid var(--line);background:transparent;padding:0;margin:0;
      display:grid;place-items:center;font-family:var(--f-mono);font-weight:700;font-size:calc(100cqw / var(--n) * .56);line-height:1;
      color:var(--fg);min-width:0;min-height:0;position:relative;border-radius:0}
    .g-sudoku-cell.bx{border-right:2px solid var(--muted)} .g-sudoku-cell.by{border-bottom:2px solid var(--muted)}
    .g-sudoku-cell.ex{border-right:0} .g-sudoku-cell.ey{border-bottom:0}
    .g-sudoku-cell.user{color:var(--gold)}
    .g-sudoku-cell.peer{background:color-mix(in srgb,var(--panel-3) 75%,var(--panel))}
    .g-sudoku-cell.same{background:color-mix(in srgb,var(--gold) 20%,var(--panel))}
    .g-sudoku-cell.wrong{color:var(--bad);background:color-mix(in srgb,var(--bad) 20%,var(--panel))}
    .g-sudoku-cell.sel{background:color-mix(in srgb,var(--gold) 30%,var(--panel));box-shadow:inset 0 0 0 2px var(--gold)}
    .g-sudoku-cell.shake{animation:g-sudoku-shake .3s}
    @keyframes g-sudoku-shake{25%{transform:translateX(-3px)}75%{transform:translateX(3px)}}
    .g-sudoku-notes{display:grid;grid-template-columns:repeat(3,1fr);grid-template-rows:repeat(var(--nr,3),1fr);width:100%;height:100%;padding:1px;
      font-size:calc(100cqw / var(--n) * .24);color:var(--muted);font-weight:500;place-items:center}
    .g-sudoku-pad{display:grid;grid-template-columns:repeat(var(--pc),minmax(0,1fr));gap:6px;width:100%}
    .g-sudoku-key{min-height:52px;padding:4px 0;display:grid;place-items:center;line-height:1.05;text-transform:none;letter-spacing:0}
    .g-sudoku-key b{font-family:var(--f-mono);font-size:23px}
    .g-sudoku-key small{font-size:10px;color:var(--muted);font-weight:500}
    .g-sudoku-key.erase{font-size:13px;text-transform:uppercase;letter-spacing:.04em}
    .g-sudoku-tools{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
    .g-sudoku-tools .dg-chip{min-height:40px}
    .g-sudoku-hint{margin:0}
    @media (pointer:coarse){.g-sudoku-kbd{display:none}}
    @container (min-width:640px){
      .g-sudoku-main{grid-template-columns:minmax(0,460px) minmax(0,1fr);justify-items:stretch;align-items:start}
      .g-sudoku-pad{grid-template-columns:repeat(3,minmax(0,1fr))}
      .g-sudoku-key{min-height:60px}
      .g-sudoku-key.erase{grid-column:span 3;min-height:44px}
    }`);

  function playSudoku(ctx) {
    blockScrollKeys(ctx);
    const onKey = gameKeys(ctx);
    const P = sdkGenerate(ctx.seed, ctx.mode), S = P.S, n = S.n, N = S.N;
    const LIMIT = SDK_LIMIT[P.mode] * 1000, MAXM = 3;
    const given = P.puzzle.map((v) => v > 0), val = P.puzzle.slice();
    const wrong = new Array(N).fill(0), notes = new Array(N).fill(0);
    let sel = val.indexOf(0), noteMode = false, mistakes = 0, correct = 0, done = false;
    const root = ctx.root;
    const border = [];
    let cellsHtml = "";
    for (let i = 0; i < N; i++) {
      const r = S.row[i], c = S.col[i];
      let b = "";
      if (c === n - 1) b += " ex"; else if ((c + 1) % S.bc === 0) b += " bx";
      if (r === n - 1) b += " ey"; else if ((r + 1) % S.br === 0) b += " by";
      border.push(b);
      cellsHtml += `<button class="g-sudoku-cell${b}" data-i="${i}" data-test="cell-${i}" aria-label="Row ${r + 1} column ${c + 1}"></button>`;
    }
    let padHtml = "";
    for (let d = 1; d <= n; d++) padHtml += `<button class="dg-btn g-sudoku-key" data-d="${d}" data-test="num-${d}" aria-label="Enter ${d}"><b>${d}</b><small data-left="${d}"></small></button>`;
    root.innerHTML = `<div class="g-sudoku" data-test="sudoku">
      ${hud("sudoku", [["time", "Time"], ["mist", "Errors"], ["cells", "Cells"], ["score", "Score"]])}
      <div class="g-sudoku-main">
        <div class="g-sudoku-board" style="--n:${n};--nr:${n / 3}" data-test="board">${cellsHtml}</div>
        <div class="g-sudoku-side">
          <div class="g-sudoku-pad" style="--pc:${n === 9 ? 5 : 7}">${padHtml}<button class="dg-btn g-sudoku-key erase" data-act="erase" data-test="erase">Erase</button></div>
          <div class="g-sudoku-tools"><button class="dg-chip" data-act="notes" data-test="notes" aria-pressed="false">Notes: off</button>
            <span class="dg-note g-sudoku-kbd" data-test="hint-keys">Keys: 1–${n}, arrows, Backspace, N</span></div>
          <p class="dg-note g-sudoku-hint">Fill every row, column and box with 1–${n}. Pick a cell, then a number. Wrong numbers cost 150 points; ${MAXM} mistakes end your run.</p>
        </div>
      </div></div>`;
    const cellEls = [...root.querySelectorAll(".g-sudoku-cell")];
    const cache = new Array(N).fill(null);
    const notesBtn = root.querySelector("[data-act=notes]");

    const runScore = () => 25 * correct;
    function paint() {
      const sv = sel >= 0 ? val[sel] || wrong[sel] : 0;
      for (let i = 0; i < N; i++) {
        let cls = "g-sudoku-cell" + border[i];
        if (given[i]) cls += " given"; else if (val[i]) cls += " user"; else if (wrong[i]) cls += " wrong";
        if (sel >= 0) {
          if (i === sel) cls += " sel";
          else {
            if (S.row[i] === S.row[sel] || S.col[i] === S.col[sel] || S.box[i] === S.box[sel]) cls += " peer";
            const v = val[i] || wrong[i];
            if (sv && v === sv) cls += " same";
          }
        }
        if (cellEls[i].classList.contains("shake")) cls += " shake";
        if (cellEls[i].className !== cls) cellEls[i].className = cls;
        const v = val[i] || wrong[i];
        let html = v ? String(v) : "";
        if (!v && notes[i]) {
          html = '<span class="g-sudoku-notes">';
          for (let d = 1; d <= n; d++) html += "<span>" + (notes[i] & (1 << d) ? d : "") + "</span>";
          html += "</span>";
        }
        if (cache[i] !== html) { cellEls[i].innerHTML = html; cache[i] = html; }
      }
      for (let d = 1; d <= n; d++) {
        const left = n - val.filter((v) => v === d).length;
        const b = root.querySelector(`[data-d="${d}"]`);
        b.disabled = left === 0;
        b.querySelector("small").textContent = left ? left + " left" : "done";
      }
      notesBtn.setAttribute("aria-pressed", String(noteMode));
      notesBtn.textContent = "Notes: " + (noteMode ? "on" : "off");
      setHud(root, "mist", mistakes + "/" + MAXM);
      setHud(root, "cells", correct + "/" + P.empties);
      setHud(root, "score", U.fmt(runScore()));
    }
    function select(i) { if (done || i < 0 || i >= N) return; sel = i; paint(); }
    function place(d) {
      if (done || ctx.signal.ended) return;
      const i = sel;
      if (i < 0 || given[i] || val[i] || d < 1 || d > n) return;
      if (noteMode) { notes[i] ^= 1 << d; paint(); return; }
      if (P.solution[i] === d) {
        val[i] = d; wrong[i] = 0; notes[i] = 0; correct++;
        for (const p of S.peers[i]) notes[p] &= ~(1 << d);
        ctx.progress(runScore());
        if (correct === P.empties) { paint(); return finish(true); }
      } else {
        if (wrong[i] === d) return;
        wrong[i] = d; mistakes++;
        cellEls[i].classList.add("shake");
        ctx.timeout(() => cellEls[i].classList.remove("shake"), 320);
        if (mistakes >= MAXM) { paint(); return finish(false, "mistakes"); }
      }
      paint(); status();
    }
    function erase() {
      if (done) return;
      const i = sel;
      if (i < 0 || given[i] || val[i]) return;
      wrong[i] = 0; notes[i] = 0; paint();
    }
    function toggleNotes() { if (done) return; noteMode = !noteMode; paint(); }
    function status() {
      const left = Math.max(0, LIMIT - ctx.now());
      setHud(root, "time", clock(left / 1000));
      ctx.setStatus(clock(left / 1000) + " · Mistakes " + mistakes + "/" + MAXM);
    }
    function finish(solved, why) {
      if (done) return;
      done = true;
      const el = Math.min(LIMIT, ctx.now()), leftSec = Math.max(0, Math.floor((LIMIT - el) / 1000));
      const score = sdkScore(solved, leftSec, mistakes, correct);
      ctx.progress(score);
      setHud(root, "score", U.fmt(score));
      const detail = solved
        ? detailBox([`<b>Solved in ${clock(el / 1000)}</b> · ${plural(mistakes, "mistake")}`,
          `3,000 + ${leftSec} s left × 5${mistakes ? " − " + 150 * mistakes + " for mistakes" : ""} = <b class="dg-gold">${U.fmt(score)}</b>`])
        : detailBox([`<b>${why === "mistakes" ? "Three mistakes" : "Time up"}</b> · ${correct} of ${P.empties} cells filled`,
          `25 points per correct cell = <b class="dg-gold">${U.fmt(score)}</b>`]);
      ctx.setStatus(solved ? "Solved " + clock(el / 1000) : why === "mistakes" ? "Out of mistakes" : "Time up");
      ctx.end({ score, detail });
    }
    root.querySelector(".g-sudoku-board").addEventListener("click", (e) => {
      const b = e.target.closest("[data-i]"); if (b) select(+b.dataset.i);
    });
    root.querySelector(".g-sudoku-side").addEventListener("click", (e) => {
      const b = e.target.closest("button"); if (!b || done) return;
      if (b.dataset.d) place(+b.dataset.d);
      else if (b.dataset.act === "erase") erase();
      else if (b.dataset.act === "notes") toggleNotes();
    });
    onKey((e) => {
      if (done) return;
      const k = e.key;
      if (/^[1-9]$/.test(k) && +k <= n) { e.preventDefault(); place(+k); }
      else if (k === "Backspace" || k === "Delete" || k === "0") { e.preventDefault(); erase(); }
      else if (k === "n" || k === "N") toggleNotes();
      else if (k.startsWith("Arrow")) {
        e.preventDefault();
        let r = sel < 0 ? 0 : S.row[sel], c = sel < 0 ? 0 : S.col[sel];
        if (k === "ArrowUp") r = (r + n - 1) % n; if (k === "ArrowDown") r = (r + 1) % n;
        if (k === "ArrowLeft") c = (c + n - 1) % n; if (k === "ArrowRight") c = (c + 1) % n;
        select(r * n + c);
        if (root.contains(document.activeElement) && document.activeElement.closest(".g-sudoku-board")) cellEls[sel].focus({ preventScroll: true });
      }
    });
    ctx.interval(() => { if (done) return; status(); if (ctx.now() >= LIMIT) finish(false, "time"); }, 250);
    paint(); status(); ctx.progress(0);
    ctx.test = {
      solution: () => P.solution.slice(),
      puzzle: () => P.puzzle.slice(),
      select, place, erase, toggleNotes,
      state: () => ({ values: val.slice(), wrong: wrong.slice(), notes: notes.slice(), selected: sel, noteMode, mistakes, correct, empties: P.empties, givens: P.givens, done }),
      solve() { if (noteMode) toggleNotes(); for (let i = 0; i < N && !done; i++) if (!val[i]) { select(i); place(P.solution[i]); } },
      mistake() { const i = val.findIndex((v, k) => !v && !given[k] && !wrong[k]); if (i < 0) return; select(i); place((P.solution[i] % n) + 1); },
    };
  }

  DG.registerGame({
    id: "sudoku", name: "Sudoku Sprint", category: "puzzle", kind: "race", formats: FORMATS,
    skill: 9, luck: 0, cashEligible: true, duration: "up to 6 min", pack: "brain", scoreLabel: "points",
    blurb: "The same unique-solution sudoku for everyone. Solve it clean and fast.",
    rules: [
      "Fill every row, column and 3×3 box with 1–9 (Duel Mix: 6×6 with 1–6, 45 s).",
      "Pick a cell, then a number. Notes mode lets you pencil in candidates.",
      "Wrong numbers show in red and cost 150 points each. Three mistakes end your run.",
      "Solved: 3,000 + 5 per second left − mistakes. Not solved: 25 per correct cell.",
      "Time limit: 6 minutes.",
    ],
    play: playSudoku,
    bot: sdkBot,
    lab: {
      generate: (seed, mode) => { const P = sdkGenerate(seed, mode); return { puzzle: P.puzzle, solution: P.solution, givens: P.givens, hard: P.hard, n: P.S.n }; },
      count: (puzzle, mode, limit) => sdkSolve(puzzle, sdkShape(mode), limit || 2).count,
      genTime(seed, mode) { CACHE.delete("sdk|" + (mode === "mix" ? "mix" : "full") + "|" + seed); const t = performance.now(); sdkGenerate(seed, mode); return performance.now() - t; },
      human: (seed, mode) => { const r = sdkSim(sdkGenerate(seed, mode), { perCell: mode === "mix" ? 1.5 : 3.6, mistakeP: 0, startup: 2 }, null); return { score: r.score, t: r.t }; },
    },
  });

  /* ====================================================================
     2. MINE SWEEP
     ==================================================================== */
  const MN_NB = {};
  function mnNb(R, C) {
    const key = R + "x" + C;
    if (MN_NB[key]) return MN_NB[key];
    const nb = [];
    for (let r = 0; r < R; r++) for (let c = 0; c < C; c++) {
      const a = [];
      for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
        if (!dr && !dc) continue;
        const rr = r + dr, cc = c + dc;
        if (rr >= 0 && rr < R && cc >= 0 && cc < C) a.push(rr * C + cc);
      }
      nb.push(a);
    }
    return (MN_NB[key] = nb);
  }
  function mnOpen(B, open, i) {
    let n = 0;
    const st = [i];
    while (st.length) {
      const k = st.pop();
      if (open[k] || B.mine[k]) continue;
      open[k] = 1; n++;
      if (B.num[k] === 0) for (const j of B.nb[k]) if (!open[j]) st.push(j);
    }
    return n;
  }
  /* Logic step: basic single-cell rule, then subset rule, then global mine count. */
  function mnDeduce(B, open, known) {
    const safe = new Set(), mines = new Set(), cons = [];
    for (let i = 0; i < B.N; i++) {
      if (!open[i] || B.num[i] === 0) continue;
      let need = B.num[i];
      const unk = [];
      for (const j of B.nb[i]) { if (open[j]) continue; if (known[j]) need--; else unk.push(j); }
      if (!unk.length) continue;
      if (need === 0) unk.forEach((j) => safe.add(j));
      else if (need === unk.length) unk.forEach((j) => mines.add(j));
      else cons.push({ cells: unk, need, set: new Set(unk) });
    }
    if (safe.size || mines.size) return { safe: [...safe], mines: [...mines], kind: "basic" };
    for (const a of cons) for (const b of cons) {
      if (a === b || a.cells.length >= b.cells.length) continue;
      if (!a.cells.every((x) => b.set.has(x))) continue;
      const diff = b.cells.filter((x) => !a.set.has(x)), dn = b.need - a.need;
      if (dn === 0) diff.forEach((x) => safe.add(x));
      else if (dn === diff.length) diff.forEach((x) => mines.add(x));
    }
    if (safe.size || mines.size) return { safe: [...safe], mines: [...mines], kind: "subset" };
    const unkAll = [];
    let kn = 0;
    for (let i = 0; i < B.N; i++) if (!open[i]) { if (known[i]) kn++; else unkAll.push(i); }
    const left = B.M - kn;
    if (unkAll.length && left === 0) return { safe: unkAll, mines: [], kind: "global" };
    if (unkAll.length && left === unkAll.length) return { safe: [], mines: unkAll, kind: "global" };
    return null;
  }
  function mnLogic(B) {
    const open = new Uint8Array(B.N), known = new Uint8Array(B.N);
    let opened = mnOpen(B, open, B.start);
    const safeTotal = B.N - B.M;
    while (opened < safeTotal) {
      const d = mnDeduce(B, open, known);
      if (!d) break;
      d.mines.forEach((i) => (known[i] = 1));
      for (const i of d.safe) opened += mnOpen(B, open, i);
    }
    return { solved: opened === safeTotal, open: opened };
  }
  function mnGenerate(seed, mode) {
    mode = mode === "mix" ? "mix" : "full";
    return memo("mn|" + mode + "|" + seed, () => {
      const R = mode === "mix" ? 8 : 12, C = R, M = mode === "mix" ? 10 : 22, N = R * C, nb = mnNb(R, C);
      const rng = U.rng("mines|" + mode + "|" + seed);
      let best = null;
      for (let a = 0; a < 60; a++) {
        const start = U.randInt(rng, 1, R - 2) * C + U.randInt(rng, 1, C - 2);
        const banned = new Set([start, ...nb[start]]);
        const pool = [];
        for (let i = 0; i < N; i++) if (!banned.has(i)) pool.push(i);
        const mine = new Uint8Array(N);
        U.shuffle(rng, pool).slice(0, M).forEach((i) => (mine[i] = 1));
        const num = new Int8Array(N);
        for (let i = 0; i < N; i++) num[i] = mine[i] ? -1 : nb[i].reduce((s, j) => s + mine[j], 0);
        const B = { mode, R, C, M, N, nb, mine, num, start };
        const res = mnLogic(B);
        B.logicOpen = res.open; B.solvable = res.solved; B.attempts = a + 1;
        if (!best || res.open > best.logicOpen) best = B;
        if (res.solved) break;
      }
      return best;
    });
  }
  const MN_LIMIT = { full: 180, mix: 45 };
  /* p = {click, think, thinkHard, flag, blunder, startup}; rng null => noiseless reference */
  function mnSim(B, p, rng) {
    const LIMIT = MN_LIMIT[B.mode], open = new Uint8Array(B.N), known = new Uint8Array(B.N), safeTotal = B.N - B.M;
    let opened = mnOpen(B, open, B.start), t = p.startup;
    const tl = [[0, 10 * opened]];
    const R = (s) => (rng ? ln(rng, s) : 1);
    const fin = (score, tt, extra) => { tl.push([r2(Math.min(tt, LIMIT)), score]); return Object.assign({ score, timeline: tl, t: Math.min(tt, LIMIT) }, extra); };
    for (;;) {
      const d = mnDeduce(B, open, known);
      if (!d) {
        const unk = [];
        for (let i = 0; i < B.N; i++) if (!open[i] && !known[i]) unk.push(i);
        t += p.thinkHard * 1.5 * R(0.3);
        if (t > LIMIT) break;
        const g = rng ? unk[Math.floor(rng() * unk.length)] : unk.find((i) => !B.mine[i]);
        if (B.mine[g]) return fin(10 * opened, t, { boom: true });
        opened += mnOpen(B, open, g);
        tl.push([r2(t), 10 * opened]);
        continue;
      }
      d.mines.forEach((i) => (known[i] = 1));
      t += d.mines.length * p.flag * R(0.2);
      const think = d.kind === "basic" ? p.think : p.thinkHard;
      const order = rng ? U.shuffle(rng, d.safe) : d.safe;
      for (const i of order) {
        if (open[i]) continue;
        const dt = (p.click + think) * R(0.3);
        if (t + dt > LIMIT) { t = LIMIT + 1; break; }
        t += dt;
        if (rng && rng() < p.blunder) return fin(10 * opened, t, { boom: true });
        opened += mnOpen(B, open, i);
        if (opened === safeTotal) { const score = 2000 + Math.floor(LIMIT - t) * 10; return fin(score, t, { cleared: true }); }
        tl.push([r2(t), 10 * opened]);
      }
      if (t > LIMIT) break;
    }
    return fin(10 * opened, LIMIT, { timeout: true });
  }
  function mnBot(seed, skill, rng, mode) {
    const B = mnGenerate(seed, mode), q = 1 - skill, f = ln(rng, 0.15);
    return mnSim(B, {
      click: (0.4 + 1.4 * Math.pow(q, 1.3)) * f, think: (0.3 + 1.5 * q) * f, thinkHard: (1.5 + 5 * q) * f,
      flag: 0.8 * q * (0.3 + 1.4 * Math.pow(q, 1.3)), blunder: 0.012 * q * q, startup: 1.5,
    }, rng);
  }

  DG.css("mines", hudCss("mines") + `
    .g-mines{display:grid;gap:10px;user-select:none;-webkit-user-select:none;-webkit-touch-callout:none}
    .g-mines-tools{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
    .g-mines-tools .dg-chip{min-height:40px}
    .g-mines-wrap{overflow:auto;max-width:100%;border-radius:var(--r-sm)}
    .g-mines-board{display:grid;grid-template-columns:repeat(var(--c),minmax(0,1fr));gap:2px;width:100%;max-width:calc(var(--c) * 42px);
      margin:0 auto;padding:4px;background:var(--line);border-radius:var(--r-sm);touch-action:manipulation;container-type:inline-size}
    .g-mines.zoom .g-mines-board{width:calc(var(--c) * 40px + 8px);max-width:none}
    .g-mines-cell{aspect-ratio:1;min-width:0;min-height:0;padding:0;border:0;border-radius:3px;background:var(--panel-3);
      box-shadow:inset 0 2px 0 rgba(255,255,255,.07),inset 0 -2px 0 rgba(0,0,0,.25);font-family:var(--f-mono);font-weight:700;
      font-size:calc(100cqw / var(--c) * .5);line-height:1;display:grid;place-items:center;position:relative}
    .g-mines-cell:hover{filter:brightness(1.12)}
    .g-mines-cell.o{background:var(--panel);box-shadow:none;cursor:default}
    .g-mines-cell.o:hover{filter:none}
    .g-mines-cell.cur{outline:2px solid var(--gold);outline-offset:-2px}
    .g-mines-cell.st::after{content:"";position:absolute;right:3px;top:3px;width:5px;height:5px;border-radius:50%;background:var(--gold)}
    .g-mines-cell.n1{color:#6FC3FF}.g-mines-cell.n2{color:#5AD690}.g-mines-cell.n3{color:#FF6275}.g-mines-cell.n4{color:#C39BFF}
    .g-mines-cell.n5{color:#FFB35C}.g-mines-cell.n6{color:#4FD8D0}.g-mines-cell.n7{color:#EEEAF7}.g-mines-cell.n8{color:#9D9BC0}
    .g-mines-cell svg{width:58%;height:58%}
    .g-mines-mine{width:52%;height:52%;border-radius:50%;background:radial-gradient(circle at 35% 35%,#9D9BC0 0 14%,#10111F 16%);
      box-shadow:0 0 0 2px rgba(16,17,31,.5)}
    .g-mines-cell.m{background:color-mix(in srgb,var(--bad) 18%,var(--panel-3))}
    .g-mines-cell.m.boom{background:var(--bad);box-shadow:0 0 0 2px var(--bad)}
    .g-mines-cell.badflag{background:color-mix(in srgb,var(--bad) 35%,var(--panel-3))}
    .g-mines.flagmode .g-mines-cell:not(.o){box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--gold) 45%,transparent)}`);

  const FLAG = '<svg viewBox="0 0 20 20" aria-hidden="true"><rect x="5" y="2.5" width="2" height="15" rx="1" fill="#EEEAF7"/><path d="M7 3h9l-2.6 3.6L16 10H7z" fill="#F2C14E"/><rect x="3" y="16" width="9" height="2" rx="1" fill="#EEEAF7"/></svg>';
  function playMines(ctx) {
    blockScrollKeys(ctx);
    const onKey = gameKeys(ctx);
    const B = mnGenerate(ctx.seed, ctx.mode), { R, C, M, N } = B, safeTotal = N - M;
    const LIMIT = MN_LIMIT[B.mode] * 1000;
    const open = new Uint8Array(N), flag = new Uint8Array(N);
    let opened = mnOpen(B, open, B.start), done = false, flagMode = false, zoom = false, cursor = B.start, boomAt = -1, result = "";
    const root = ctx.root;
    let cells = "";
    for (let i = 0; i < N; i++) cells += `<button class="g-mines-cell" data-i="${i}" data-test="cell-${i}" aria-label="Row ${((i / C) | 0) + 1} column ${(i % C) + 1}"></button>`;
    root.innerHTML = `<div class="g-mines" data-test="mines">
      ${hud("mines", [["time", "Time"], ["mines", "Mines"], ["open", "Cleared"], ["score", "Score"]])}
      <div class="g-mines-tools">
        <button class="dg-chip" data-act="flag" data-test="flagmode" aria-pressed="false">Flag mode: off</button>
        <button class="dg-chip" data-act="zoom" data-test="zoom" aria-pressed="false">Zoom</button>
        <span class="dg-note">Tap to reveal. Long-press or right-click to flag.</span>
      </div>
      <div class="g-mines-wrap"><div class="g-mines-board" style="--c:${C}" data-test="board">${cells}</div></div>
      <p class="dg-note" style="margin:0">Clear every safe square. The gold dot marks the free start. Tap a number with all its flags placed to open its other neighbours.</p>
    </div>`;
    const wrapEl = root.querySelector(".g-mines"), board = root.querySelector(".g-mines-board");
    const cellEls = [...board.children];
    const cache = new Array(N).fill(null);
    const flagsNear = (i) => B.nb[i].reduce((s, j) => s + (flag[j] && !open[j] ? 1 : 0), 0);

    function paint() {
      const reveal = done;
      for (let i = 0; i < N; i++) {
        let cls = "g-mines-cell", html = "";
        if (open[i]) { cls += " o"; if (B.num[i] > 0) { cls += " n" + B.num[i]; html = String(B.num[i]); } }
        else if (reveal && B.mine[i]) {
          if (flag[i] || result === "cleared") html = FLAG;
          else { cls += " m"; html = '<i class="g-mines-mine"></i>'; }
          if (i === boomAt) cls += " boom";
        } else if (flag[i]) { html = FLAG; if (reveal) cls += " badflag"; }
        if (i === B.start) cls += " st";
        if (i === cursor && !done) cls += " cur";
        const key = cls + "|" + html;
        if (cache[i] !== key) { cellEls[i].className = cls; cellEls[i].innerHTML = html; cache[i] = key; }
      }
      const nf = flag.reduce((s, v, i) => s + (v && !open[i] ? 1 : 0), 0);
      setHud(root, "mines", M - nf);
      setHud(root, "open", opened + "/" + safeTotal);
      setHud(root, "score", U.fmt(result === "cleared" ? finalScore : 10 * opened));
    }
    let finalScore = 0;
    function status() {
      const left = Math.max(0, LIMIT - ctx.now());
      setHud(root, "time", clock(left / 1000));
      const nf = flag.reduce((s, v, i) => s + (v && !open[i] ? 1 : 0), 0);
      ctx.setStatus(clock(left / 1000) + " · " + (M - nf) + " mines left");
    }
    function finish(kind) {
      if (done) return;
      done = true; result = kind;
      const el = Math.min(LIMIT, ctx.now()), leftSec = Math.max(0, Math.floor((LIMIT - el) / 1000));
      finalScore = kind === "cleared" ? 2000 + leftSec * 10 : 10 * opened;
      ctx.progress(finalScore);
      paint();
      const detail = kind === "cleared"
        ? detailBox([`<b>Cleared in ${clock(el / 1000)}</b>`, `2,000 + ${leftSec} s left × 10 = <b class="dg-gold">${U.fmt(finalScore)}</b>`])
        : detailBox([`<b>${kind === "boom" ? "Hit a mine" : "Time up"}</b> · ${opened} of ${safeTotal} safe squares cleared`,
          `10 points per cleared square = <b class="dg-gold">${U.fmt(finalScore)}</b>`]);
      ctx.setStatus(kind === "cleared" ? "Cleared " + clock(el / 1000) : kind === "boom" ? "Boom" : "Time up");
      ctx.timeout(() => ctx.end({ score: finalScore, detail }), ctx.reducedMotion ? 150 : 700);
      // make sure a pending end is not lost if timers are throttled: ctx.end is idempotent
    }
    function reveal(i) {
      if (done || open[i] || flag[i]) return;
      if (B.mine[i]) { boomAt = i; return finish("boom"); }
      opened += mnOpen(B, open, i);
      for (let k = 0; k < N; k++) if (open[k]) flag[k] = 0;
      ctx.progress(10 * opened);
      if (opened === safeTotal) return finish("cleared");
      paint();
    }
    function chord(i) {
      if (done || !open[i] || B.num[i] <= 0 || flagsNear(i) !== B.num[i]) return;
      for (const j of B.nb[i]) { if (done) return; if (!open[j] && !flag[j]) reveal(j); }
    }
    function toggleFlag(i) { if (done || open[i]) return; flag[i] ^= 1; paint(); status(); }
    function primary(i) { cursor = i; if (open[i]) chord(i); else if (flagMode) toggleFlag(i); else reveal(i); if (!done) paint(); }

    let press = null;
    board.addEventListener("pointerdown", (e) => {
      const el = e.target.closest("[data-i]");
      if (!el || done) return;
      const i = +el.dataset.i;
      if (e.button === 2) { e.preventDefault(); cursor = i; toggleFlag(i); return; }
      if (e.button !== 0) return;
      const p = { i, fired: false, x: e.clientX, y: e.clientY };
      p.tid = ctx.timeout(() => { if (press === p && !open[i] && !done) { p.fired = true; cursor = i; toggleFlag(i); } }, 450 * ctx.speed);
      press = p;
    });
    board.addEventListener("pointerup", (e) => {
      const p = press; press = null;
      if (!p || done) return;
      ctx.clearTimeout(p.tid);
      if (p.fired || Math.hypot(e.clientX - p.x, e.clientY - p.y) > 16) return;
      primary(p.i);
    });
    const cancel = () => { if (press) { ctx.clearTimeout(press.tid); press = null; } };
    board.addEventListener("pointercancel", cancel);
    board.addEventListener("pointerleave", cancel);
    board.addEventListener("contextmenu", (e) => e.preventDefault());
    root.querySelector(".g-mines-tools").addEventListener("click", (e) => {
      const b = e.target.closest("[data-act]"); if (!b || done) return;
      if (b.dataset.act === "flag") { flagMode = !flagMode; b.setAttribute("aria-pressed", String(flagMode)); b.textContent = "Flag mode: " + (flagMode ? "on" : "off"); wrapEl.classList.toggle("flagmode", flagMode); }
      if (b.dataset.act === "zoom") { zoom = !zoom; b.setAttribute("aria-pressed", String(zoom)); wrapEl.classList.toggle("zoom", zoom); }
    });
    onKey((e) => {
      if (done) return;
      const k = e.key;
      let r = (cursor / C) | 0, c = cursor % C;
      if (k.startsWith("Arrow")) {
        e.preventDefault();
        if (k === "ArrowUp") r = Math.max(0, r - 1); if (k === "ArrowDown") r = Math.min(R - 1, r + 1);
        if (k === "ArrowLeft") c = Math.max(0, c - 1); if (k === "ArrowRight") c = Math.min(C - 1, c + 1);
        cursor = r * C + c; paint();
        if (root.contains(document.activeElement) && document.activeElement.closest(".g-mines-board")) cellEls[cursor].focus({ preventScroll: true });
      } else if (k === " " || k === "Enter") { e.preventDefault(); primary(cursor); }
      else if (k === "f" || k === "F") toggleFlag(cursor);
    });
    ctx.interval(() => { if (done) return; status(); if (ctx.now() >= LIMIT) finish("time"); }, 250);
    paint(); status(); ctx.progress(10 * opened);
    ctx.test = {
      solution: () => Array.from(B.mine),
      numbers: () => Array.from(B.num),
      start: B.start,
      reveal, toggleFlag, chord, primary,
      state: () => ({ open: Array.from(open), flags: Array.from(flag), opened, safeTotal, done, result, cursor, R, C, M }),
      safeReveal(n) { let k = 0; for (let i = 0; i < N && k < (n || 1) && !done; i++) if (!open[i] && !B.mine[i]) { reveal(i); k++; } return k; },
      solve() { for (let i = 0; i < N && !done; i++) if (!open[i] && !B.mine[i]) reveal(i); },
      boom() { const i = B.mine.indexOf(1); flag[i] = 0; reveal(i); },
    };
  }

  DG.registerGame({
    id: "mines", name: "Mine Sweep", category: "puzzle", kind: "race", formats: FORMATS,
    skill: 8, luck: 1, cashEligible: true, duration: "up to 3 min", pack: "brain", scoreLabel: "points",
    blurb: "Same minefield, same safe start. Clear it by logic before your rival does.",
    rules: [
      "Numbers show how many mines touch that square. Clear every safe square.",
      "Tap to reveal. Long-press, right-click or Flag mode to plant a flag.",
      "Tap a number whose flags are all placed to open its other neighbours.",
      "Cleared: 2,000 + 10 per second left. A mine or the clock ends it: 10 per cleared square.",
      "12×12 with 22 mines in 3 minutes (Duel Mix: 8×8, 10 mines, 45 s). Boards are picked to be solvable without guessing.",
    ],
    play: playMines,
    bot: mnBot,
    lab: {
      generate: (seed, mode) => { const B = mnGenerate(seed, mode); return { R: B.R, C: B.C, M: B.M, start: B.start, mine: Array.from(B.mine), solvable: B.solvable, attempts: B.attempts }; },
      genTime(seed, mode) { CACHE.delete("mn|" + (mode === "mix" ? "mix" : "full") + "|" + seed); const t = performance.now(); mnGenerate(seed, mode); return performance.now() - t; },
      human: (seed, mode) => { const r = mnSim(mnGenerate(seed, mode), { click: 0.5, think: 0.5, thinkHard: 2.5, flag: 0.15, blunder: 0, startup: 1.5 }, null); return { score: r.score, t: r.t }; },
    },
  });

  /* ====================================================================
     3. ROYAL GRID  (one crown per row, column and region; crowns never touch)
     ==================================================================== */
  function qnSolve(N, reg, limit) {
    const sols = [], colUsed = new Array(N).fill(false), regUsed = new Array(N).fill(false), pos = new Array(N);
    let count = 0, nodes = 0;
    (function rec(r) {
      if (r === N) { count++; if (sols.length < 2) sols.push(pos.slice()); return; }
      for (let c = 0; c < N; c++) {
        const g = reg[r * N + c];
        if (colUsed[c] || regUsed[g] || (r > 0 && Math.abs(pos[r - 1] - c) < 2)) continue;
        nodes++;
        pos[r] = c; colUsed[c] = regUsed[g] = true;
        rec(r + 1);
        colUsed[c] = regUsed[g] = false;
        if (count >= limit) return;
      }
    })(0);
    return { count, sols, nodes };
  }
  function qnPerm(N, rng) {
    const pos = [], used = new Array(N).fill(false);
    (function rec(r) {
      if (r === N) return true;
      for (const c of U.shuffle(rng, [...Array(N).keys()])) {
        if (used[c] || (r > 0 && Math.abs(pos[r - 1] - c) < 2)) continue;
        used[c] = true; pos[r] = c;
        if (rec(r + 1)) return true;
        used[c] = false;
      }
      return false;
    })(0);
    return pos;
  }
  const qn4 = (N, i) => { const r = (i / N) | 0, c = i % N, a = []; if (r > 0) a.push(i - N); if (r < N - 1) a.push(i + N); if (c > 0) a.push(i - 1); if (c < N - 1) a.push(i + 1); return a; };
  function qnConnectedWithout(N, reg, g, skip) {
    const cells = [];
    for (let i = 0; i < N * N; i++) if (reg[i] === g && i !== skip) cells.push(i);
    if (!cells.length) return false;
    const seen = new Set([cells[0]]), st = [cells[0]];
    while (st.length) { const k = st.pop(); for (const j of qn4(N, k)) if (j !== skip && reg[j] === g && !seen.has(j)) { seen.add(j); st.push(j); } }
    return seen.size === cells.length;
  }
  /* Human-style difficulty: forced placements (cheap), what-if eliminations (medium), guesses (expensive). */
  function qnRate(N, reg, sol) {
    const NN = N * N, cand = new Uint8Array(NN).fill(1);
    const groups = [];
    for (let k = 0; k < N; k++) {
      groups.push([...Array(N).keys()].map((c) => k * N + c));
      groups.push([...Array(N).keys()].map((r) => r * N + k));
    }
    for (let g = 0; g < N; g++) groups.push([...Array(NN).keys()].filter((i) => reg[i] === g));
    const gdone = new Array(groups.length).fill(false);
    const hits = (i, j) => { const ri = (i / N) | 0, ci = i % N, rj = (j / N) | 0, cj = j % N; return ri === rj || ci === cj || reg[i] === reg[j] || (Math.abs(ri - rj) <= 1 && Math.abs(ci - cj) <= 1); };
    let placed = 0, basic = 0, look = 0, guess = 0;
    const place = (i) => {
      for (let j = 0; j < NN; j++) if (hits(i, j)) cand[j] = 0;
      groups.forEach((g, k) => { if (g.includes(i)) gdone[k] = true; });
      placed++;
    };
    while (placed < N) {
      let did = false;
      for (let k = 0; k < groups.length && !did; k++) {
        if (gdone[k]) continue;
        const cs = groups[k].filter((i) => cand[i]);
        if (cs.length === 1) { place(cs[0]); basic++; did = true; }
      }
      if (did) continue;
      let elim = 0;
      for (let i = 0; i < NN; i++) {
        if (!cand[i]) continue;
        for (let k = 0; k < groups.length; k++) {
          if (gdone[k] || groups[k].includes(i)) continue;
          if (groups[k].every((j) => !cand[j] || hits(i, j))) { cand[i] = 0; elim++; break; }
        }
      }
      if (elim) { look++; continue; }
      for (let r = 0; r < N; r++) if (!gdone[2 * r]) { place(r * N + sol[r]); guess++; break; }
    }
    return { basic, look, guess, D: basic + 3 * look + 8 * guess };
  }
  function qnGenerate(seed, idx, N) {
    return memo(`qn|${seed}|${idx}|${N}`, () => {
      const rng = U.rng(`queens|${seed}|${idx}|${N}`), NN = N * N;
      let reg, perm;
      for (let attempt = 0; attempt < 40; attempt++) {
        perm = qnPerm(N, rng);
        reg = new Int8Array(NN).fill(-1);
        perm.forEach((c, r) => (reg[r * N + c] = r));
        let un = NN - N;
        while (un > 0) {
          const front = [];
          for (let i = 0; i < NN; i++) if (reg[i] < 0 && qn4(N, i).some((j) => reg[j] >= 0)) front.push(i);
          const i = front[Math.floor(rng() * front.length)];
          const opts = qn4(N, i).filter((j) => reg[j] >= 0);
          reg[i] = reg[opts[Math.floor(rng() * opts.length)]];
          un--;
        }
        for (let it = 0; it < 120; it++) {
          const res = qnSolve(N, reg, 2);
          if (res.count === 1) {
            const rate = qnRate(N, reg, perm);
            return { N, reg: Array.from(reg), sol: perm.slice(), D: rate.D, rate, attempts: attempt + 1, fixes: it };
          }
          const other = res.sols.find((s) => s.some((c, r) => c !== perm[r]));
          const cand = U.shuffle(rng, other.map((c, r) => r * N + c).filter((i) => perm[(i / N) | 0] !== i % N));
          let moved = false;
          for (const i of cand) {
            const old = reg[i];
            const nr = U.shuffle(rng, [...new Set(qn4(N, i).map((j) => reg[j]).filter((g) => g !== old))]);
            if (!nr.length || !qnConnectedWithout(N, reg, old, i)) continue;
            reg[i] = nr[0]; moved = true; break;
          }
          if (!moved) break;
        }
      }
      throw new Error("Royal Grid: could not generate a unique puzzle");
    });
  }
  const QN_SIZES = { full: [6, 7, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8], mix: [6] };
  const QN_LIMIT = { full: 90, mix: 45 };
  /* p = {unit, read}; returns solved count, timeline. */
  function qnSim(seed, mode, p, rng) {
    mode = mode === "mix" ? "mix" : "full";
    const LIMIT = QN_LIMIT[mode], sizes = QN_SIZES[mode], tl = [[0, 0]];
    let t = 0, solved = 0, score = 0;
    for (let k = 0; k < sizes.length; k++) {
      const P = qnGenerate(seed, k, sizes[k]);
      const dt = (p.read * (sizes[k] / 6) + (P.D + sizes[k]) * p.unit) * (rng ? ln(rng, 0.3) : 1);
      if (t + dt > LIMIT) {
        /* unfinished grid: crowns go down at an even pace through the solve; each wrong guess (skill-based) is
           placed and later removed, so the partial credit counts only right crowns */
        const N = sizes[k], got = Math.min(N - 1, Math.floor((N * (LIMIT - t)) / dt));
        const base = score;
        let right = 0;
        for (let c = 1; c <= got; c++) {
          if (rng && rng() < (p.wrong || 0)) continue;
          right++;
          tl.push([r2(Math.min(t + (dt * c) / N, LIMIT)), base + 100 * right]);
        }
        score = base + 100 * right;
        break;
      }
      t += dt + (k ? 0.6 : 0); solved++;
      score = 1000 * solved + 10 * Math.max(0, Math.floor(LIMIT - t));
      tl.push([r2(Math.min(t, LIMIT)), score]);
      t += 0.6;
    }
    if (tl[tl.length - 1][0] < LIMIT && (mode === "full" || solved === 0)) tl.push([LIMIT, score]);
    return { score, timeline: tl, solved };
  }
  function qnBot(seed, skill, rng, mode) {
    const q = 1 - skill, f = ln(rng, 0.15);
    return qnSim(seed, mode, { unit: (0.45 + 3.0 * Math.pow(q, 1.5)) * f, read: (1.8 + 2.4 * q) * f, wrong: 0.3 * q }, rng);
  }
  /* Paul Tol "light" palette: colour-blind safe, 9 distinct hues; plus per-region texture. */
  const QN_COLORS = ["#77AADD", "#EE8866", "#EEDD88", "#FFAABB", "#99DDFF", "#44BB99", "#BBCC33", "#AAAA00", "#DDDDDD"];
  const QN_PAT = [
    "none",
    "repeating-linear-gradient(45deg,rgba(0,0,0,.09) 0 3px,transparent 3px 9px)",
    "radial-gradient(rgba(0,0,0,.14) 1.5px,transparent 1.8px) 0 0/9px 9px",
    "repeating-linear-gradient(-45deg,rgba(0,0,0,.09) 0 3px,transparent 3px 9px)",
    "repeating-linear-gradient(0deg,rgba(0,0,0,.09) 0 2px,transparent 2px 8px)",
    "repeating-linear-gradient(90deg,rgba(0,0,0,.09) 0 2px,transparent 2px 8px)",
    "radial-gradient(rgba(255,255,255,.35) 1.5px,transparent 1.8px) 0 0/8px 8px",
    "repeating-linear-gradient(45deg,rgba(0,0,0,.08) 0 1px,transparent 1px 5px)",
    "repeating-linear-gradient(0deg,rgba(0,0,0,.07) 0 1px,transparent 1px 6px),repeating-linear-gradient(90deg,rgba(0,0,0,.07) 0 1px,transparent 1px 6px)",
  ];
  const CROWN = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7l4.5 4L12 4l4.5 7L21 7l-2 11H5z" /><rect x="5" y="19" width="14" height="2.4" rx="1"/></svg>';

  DG.css("queens", hudCss("queens") + `
    .g-queens{display:grid;gap:10px;user-select:none;-webkit-user-select:none;position:relative}
    .g-queens-board{width:100%;max-width:470px;margin:0 auto;aspect-ratio:1;display:grid;grid-template-columns:repeat(var(--n),minmax(0,1fr));
      grid-template-rows:repeat(var(--n),minmax(0,1fr));border:3px solid #10111F;border-radius:var(--r-sm);overflow:hidden;background:#10111F;
      touch-action:manipulation;position:relative}
    .g-queens-cell{border:0;padding:0;margin:0;min-width:0;min-height:0;border-radius:0;display:grid;place-items:center;position:relative;
      background:var(--pat),var(--rc);border-right:1px solid rgba(16,17,31,.35);border-bottom:1px solid rgba(16,17,31,.35);color:#10111F}
    .g-queens-cell.br{border-right:3px solid #10111F} .g-queens-cell.bb{border-bottom:3px solid #10111F}
    .g-queens-cell:hover{filter:brightness(1.08)}
    .g-queens-cell svg{width:62%;height:62%;fill:#10111F}
    .g-queens-x{font-family:var(--f-mono);font-weight:700;font-size:min(22px,4.2vw);opacity:.55;line-height:1}
    .g-queens-cell.bad{box-shadow:inset 0 0 0 3px #B0102A}
    .g-queens-cell.bad svg{fill:#B0102A}
    .g-queens-cell.ok svg{fill:#10111F}
    .g-queens-tools{display:flex;gap:8px;flex-wrap:wrap;align-items:center;justify-content:space-between}
    .g-queens-banner{position:absolute;inset:auto 0 45% 0;margin:auto;width:max-content;max-width:90%;padding:10px 22px;border-radius:var(--r-md);
      background:var(--gold);color:var(--on-gold);font-family:var(--f-display);font-weight:800;font-size:30px;text-transform:uppercase;
      pointer-events:none;opacity:0;transition:opacity .15s}
    .g-queens-banner.on{opacity:1}`);

  function playQueens(ctx) {
    blockScrollKeys(ctx);
    const onKey = gameKeys(ctx);
    const mode = ctx.mode === "mix" ? "mix" : "full", LIMIT = QN_LIMIT[mode] * 1000, sizes = QN_SIZES[mode];
    let idx = 0, P = null, N = 0, marks = null, solved = 0, lastLeft = 0, score = 0, done = false, busy = false, conflicts = new Set();
    const root = ctx.root;
    root.innerHTML = `<div class="g-queens" data-test="queens">
      ${hud("queens", [["time", "Time"], ["puz", "Grid"], ["solved", "Solved"], ["score", "Score"]])}
      <div class="g-queens-board" data-test="board"></div>
      <div class="g-queens-tools"><span class="dg-note">Tap once for ×, twice for a crown, again to clear.</span>
        <button class="dg-btn" data-act="clear" data-test="clear">Clear board</button></div>
      <p class="dg-note" style="margin:0">Place one crown in every row, column and colour region. Crowns may not touch, not even diagonally.${mode === "full" ? " Solve as many grids as you can in 90 s." : ""}</p>
      <div class="g-queens-banner" data-test="banner">Solved</div>
    </div>`;
    const board = root.querySelector(".g-queens-board"), banner = root.querySelector(".g-queens-banner");
    let cellEls = [];
    function load(k) {
      idx = k; P = qnGenerate(ctx.seed, k, sizes[k]); N = P.N; marks = new Int8Array(N * N);
      board.style.setProperty("--n", N);
      let html = "";
      for (let i = 0; i < N * N; i++) {
        const r = (i / N) | 0, c = i % N, g = P.reg[i];
        let b = "";
        if (c < N - 1 && P.reg[i + 1] !== g) b += " br";
        if (r < N - 1 && P.reg[i + N] !== g) b += " bb";
        html += `<button class="g-queens-cell${b}" data-i="${i}" data-test="cell-${i}" data-region="${g}" style="--rc:${QN_COLORS[g % 9]};--pat:${QN_PAT[g % 9]}" aria-label="Row ${r + 1} column ${c + 1}"></button>`;
      }
      board.innerHTML = html;
      cellEls = [...board.children];
      paint();
      if (k + 1 < sizes.length) ctx.timeout(() => qnGenerate(ctx.seed, k + 1, sizes[k + 1]), 30);
    }
    function computeConflicts() {
      const crowns = [];
      for (let i = 0; i < N * N; i++) if (marks[i] === 2) crowns.push(i);
      const bad = new Set();
      for (let a = 0; a < crowns.length; a++) for (let b = a + 1; b < crowns.length; b++) {
        const i = crowns[a], j = crowns[b], ri = (i / N) | 0, ci = i % N, rj = (j / N) | 0, cj = j % N;
        if (ri === rj || ci === cj || P.reg[i] === P.reg[j] || (Math.abs(ri - rj) <= 1 && Math.abs(ci - cj) <= 1)) { bad.add(i); bad.add(j); }
      }
      return { crowns, bad };
    }
    function paint() {
      const { crowns, bad } = computeConflicts();
      conflicts = bad;
      for (let i = 0; i < N * N; i++) {
        const el = cellEls[i], m = marks[i];
        const want = m === 2 ? CROWN : m === 1 ? '<span class="g-queens-x">×</span>' : "";
        if (el.dataset.m !== String(m)) { el.innerHTML = want; el.dataset.m = String(m); }
        el.classList.toggle("bad", bad.has(i));
      }
      setHud(root, "puz", N + "×" + N);
      setHud(root, "solved", String(solved));
      setHud(root, "score", U.fmt(score));
      return { crowns, bad };
    }
    /* partial credit on the unfinished grid: +100 per crown on its solution square, −100 per misplaced crown, floor 0 */
    function partial() {
      if (!P) return 0;
      let good = 0, badc = 0;
      for (let i = 0; i < N * N; i++) if (marks[i] === 2) { if (P.sol[(i / N) | 0] === i % N) good++; else badc++; }
      return Math.max(0, good - badc);
    }
    const running = () => 1000 * solved + 10 * lastLeft + 100 * partial();
    function tap(i) {
      if (done || busy || i < 0 || i >= N * N) return;
      const was = running();
      marks[i] = (marks[i] + 1) % 3;
      const { crowns, bad } = paint();
      if (crowns.length === N && bad.size === 0) return onSolved();
      score = running();
      if (score !== was) { ctx.progress(score); setHud(root, "score", U.fmt(score)); }
    }
    function onSolved() {
      solved++;
      lastLeft = Math.max(0, Math.floor((LIMIT - ctx.now()) / 1000));
      score = 1000 * solved + 10 * lastLeft;
      marks.fill(0);
      ctx.progress(score);
      paint();
      if (mode === "mix" || idx + 1 >= sizes.length) return finish("done");
      busy = true;
      banner.classList.add("on");
      ctx.timeout(() => { banner.classList.remove("on"); busy = false; if (!done) load(idx + 1); }, ctx.reducedMotion ? 250 : 650);
    }
    function status() {
      const left = Math.max(0, LIMIT - ctx.now());
      setHud(root, "time", clock(left / 1000));
      ctx.setStatus(clock(left / 1000) + " · " + (mode === "mix" ? "Grid " + N + "×" + N : "Solved " + solved));
    }
    function finish(why) {
      if (done) return;
      done = true;
      const part = why === "time" ? partial() : 0;
      score = 1000 * solved + 10 * lastLeft + 100 * part;
      ctx.progress(score);
      const partTxt = why === "time" ? ` + ${part} × 100 for crowns on the unfinished grid` : "";
      const detail = mode === "mix"
        ? (solved ? detailBox([`<b>Solved</b> with ${lastLeft} s left`, `1,000 + ${lastLeft} × 10 = <b class="dg-gold">${U.fmt(score)}</b>`])
          : detailBox([`<b>Time up</b> · grid not solved · ${plural(part, "crown")} placed right`, `${part} × 100 = <b class="dg-gold">${U.fmt(score)}</b>`]))
        : detailBox([`<b>${plural(solved, "grid")} solved</b>${solved ? ` · last one with ${lastLeft} s left` : ""}`,
          `${solved} × 1,000 + ${lastLeft} × 10${partTxt} = <b class="dg-gold">${U.fmt(score)}</b>`]);
      ctx.setStatus(why === "time" ? "Time up" : "Solved");
      ctx.end({ score, detail });
    }
    board.addEventListener("click", (e) => { const b = e.target.closest("[data-i]"); if (b) tap(+b.dataset.i); });
    root.querySelector("[data-act=clear]").addEventListener("click", () => { if (done || busy) return; marks.fill(0); paint(); });
    let cursor = 0;
    onKey((e) => {
      if (done || !N) return;
      const k = e.key;
      let r = (cursor / N) | 0, c = cursor % N;
      if (k.startsWith("Arrow")) {
        e.preventDefault();
        if (k === "ArrowUp") r = Math.max(0, r - 1); if (k === "ArrowDown") r = Math.min(N - 1, r + 1);
        if (k === "ArrowLeft") c = Math.max(0, c - 1); if (k === "ArrowRight") c = Math.min(N - 1, c + 1);
        cursor = r * N + c; if (cellEls[cursor]) cellEls[cursor].focus({ preventScroll: true });
      } else if (k === " " || k === "Enter") {
        const a = document.activeElement;
        if (a && a.closest && a.closest(".g-queens-board")) return; // native button click handles it
        e.preventDefault(); tap(cursor);
      }
    });
    ctx.interval(() => { if (done) return; status(); if (ctx.now() >= LIMIT) finish("time"); }, 250);
    load(0); status(); ctx.progress(0);
    ctx.test = {
      solution: () => P.sol.map((c, r) => r * N + c),
      regions: () => P.reg.slice(),
      tap,
      state: () => ({ idx, N, solved, score, marks: Array.from(marks), conflicts: [...conflicts], done, busy }),
      solve() {
        if (done || busy) return false;
        const want = new Set(P.sol.map((c, r) => r * N + c));
        for (let i = 0; i < N * N; i++) if (!want.has(i)) while (marks[i] !== 0) tap(i);
        for (const i of want) { let g = 0; while (marks[i] !== 2 && g++ < 3 && !busy && !done) tap(i); }
        return true;
      },
    };
  }

  DG.registerGame({
    id: "queens", name: "Royal Grid", category: "puzzle", kind: "race", formats: FORMATS,
    skill: 9, luck: 0, cashEligible: true, duration: "90 s", pack: "brain", scoreLabel: "points",
    blurb: "One crown per row, column and colour. No two crowns touch. Solve as many grids as you can.",
    rules: [
      "Place exactly one crown in every row, every column and every colour region.",
      "Crowns may not touch each other, not even diagonally.",
      "Tap a square once for an ×, twice for a crown, a third time to clear it. Clashing crowns turn red.",
      "90 s: grids grow from 6×6 to 8×8. 1,000 per grid solved + 10 per second left when you solved your last one.",
      "When time runs out, each crown in the right square of your unfinished grid scores 100; each wrong crown takes 100 off that.",
      "Duel Mix: one 6×6 grid in 45 s.",
    ],
    play: playQueens,
    bot: qnBot,
    lab: {
      generate: (seed, idx, n) => { const P = qnGenerate(seed, idx, n); return { N: P.N, reg: P.reg, sol: P.sol, D: P.D, rate: P.rate, attempts: P.attempts, fixes: P.fixes }; },
      count: (N, reg, limit) => qnSolve(N, reg, limit || 2).count,
      genTime(seed, idx, n) { CACHE.delete(`qn|${seed}|${idx}|${n}`); const t = performance.now(); qnGenerate(seed, idx, n); return performance.now() - t; },
      human: (seed, mode) => { const r = qnSim(seed, mode, { unit: 0.8, read: 2.5 }, null); return { score: r.score, solved: r.solved }; },
    },
  });

  /* ====================================================================
     4. MERGE 2048
     ==================================================================== */
  const TZ_LINES = [0, 1, 2, 3].map((dir) => [0, 1, 2, 3].map((k) => [0, 1, 2, 3].map((j) => {
    if (dir === 0) return j * 4 + k;          // up
    if (dir === 2) return (3 - j) * 4 + k;    // down
    if (dir === 3) return k * 4 + j;          // left
    return k * 4 + (3 - j);                   // right
  })));
  function tzSlide(b, dir) {
    const nb = b.slice(), moves = [];
    let gain = 0, moved = false;
    for (const line of TZ_LINES[dir]) {
      const out = [0, 0, 0, 0], merged = [false, false, false, false];
      let w = -1;
      for (let j = 0; j < 4; j++) {
        const v = b[line[j]];
        if (!v) continue;
        if (w >= 0 && out[w] === v && !merged[w]) { out[w] *= 2; gain += out[w]; merged[w] = true; moves.push({ from: line[j], to: line[w], merge: true }); }
        else { w++; out[w] = v; moves.push({ from: line[j], to: line[w], merge: false }); }
      }
      for (let j = 0; j < 4; j++) { if (out[j] !== b[line[j]]) moved = true; nb[line[j]] = out[j]; }
    }
    return { b: nb, gain, moved, moves };
  }
  function tzSpawn(st) {
    const empt = [];
    for (let i = 0; i < 16; i++) if (!st.b[i]) empt.push(i);
    if (!empt.length) return -1;
    const r1 = st.rng(), r2v = st.rng();
    const pos = empt[Math.floor(r1 * empt.length)];
    st.b[pos] = r2v < 0.9 ? 2 : 4;
    return pos;
  }
  function tzNew(seed) {
    const st = { rng: U.rng("2048|" + seed), b: new Array(16).fill(0), score: 0, moves: 0 };
    tzSpawn(st); tzSpawn(st);
    return st;
  }
  const tzCanMove = (b) => [0, 1, 2, 3].some((d) => tzSlide(b, d).moved);
  const LOG2 = (v) => (v ? Math.log2(v) : 0);
  function tzEval(b) {
    let empty = 0, merges = 0, mono = 0, maxV = 0;
    for (let i = 0; i < 16; i++) { if (!b[i]) empty++; if (b[i] > maxV) maxV = b[i]; }
    for (let k = 0; k < 4; k++) {
      for (const line of [TZ_LINES[3][k], TZ_LINES[0][k]]) {
        let inc = 0, dec = 0, prev = -1;
        for (let j = 0; j < 4; j++) {
          const v = LOG2(b[line[j]]);
          if (j) { if (v > prev) inc += v - prev; else dec += prev - v; }
          if (b[line[j]] && j < 3 && b[line[j]] === b[line[j + 1]]) merges++;
          prev = v;
        }
        mono -= Math.min(inc, dec);
      }
    }
    const corner = [0, 3, 12, 15].some((i) => b[i] === maxV) ? LOG2(maxV) : 0;
    return 2.7 * empty + 1.2 * merges + 1.0 * mono + 1.0 * corner;
  }
  function tzBest(b) {
    let best = -1, bv = -Infinity;
    for (let d = 0; d < 4; d++) {
      const r = tzSlide(b, d);
      if (!r.moved) continue;
      let v2 = -Infinity;
      for (let d2 = 0; d2 < 4; d2++) { const r2x = tzSlide(r.b, d2); if (r2x.moved) v2 = Math.max(v2, tzEval(r2x.b) + LOG2(r2x.gain) * 0.4); }
      const v = tzEval(r.b) + LOG2(r.gain) * 0.6 + (v2 === -Infinity ? -20 : 0.8 * v2);
      if (v > bv) { bv = v; best = d; }
    }
    return best;
  }
  const TZ_LIMIT = { full: 90, mix: 40 };
  /* p = {rate (moves/s), pBest, startup}; rng null => noiseless reference */
  function tzSim(seed, mode, p, rng) {
    mode = mode === "mix" ? "mix" : "full";
    const LIMIT = TZ_LIMIT[mode], st = tzNew(seed), tl = [[0, 0]];
    let t = p.startup, lastT = 0, over = false;
    for (;;) {
      const dt = (1 / p.rate) * (rng ? ln(rng, 0.35) : 1);
      if (t + dt > LIMIT) break;
      t += dt;
      let d = tzBest(st.b);
      if (d < 0) { over = true; break; }
      if (rng && rng() > p.pBest) {
        const legal = [0, 1, 2, 3].filter((x) => tzSlide(st.b, x).moved);
        d = legal[Math.floor(rng() * legal.length)];
      }
      const r = tzSlide(st.b, d);
      st.b = r.b; st.score += r.gain; st.moves++;
      tzSpawn(st);
      if (r.gain && t - lastT >= 1) { tl.push([r2(t), st.score]); lastT = t; }
    }
    tl.push([r2(over ? t : LIMIT), st.score]);
    return { score: st.score, timeline: tl, moves: st.moves, maxTile: Math.max(...st.b), over };
  }
  function tzBot(seed, skill, rng, mode) {
    const rate = (0.9 + 2.6 * skill) * ln(rng, 0.1);
    return tzSim(seed, mode, { rate, pBest: 0.3 + 0.68 * Math.pow(skill, 0.8), startup: 1 }, rng);
  }
  const TZ_COL = { 2: ["#2A2E52", "#EEEAF7"], 4: ["#383D6B", "#EEEAF7"], 8: ["#7B4A2A", "#FFF3E0"], 16: ["#9A5427", "#FFF3E0"],
    32: ["#B85A2E", "#FFF3E0"], 64: ["#CF4F3A", "#FFF3E0"], 128: ["#C99A3C", "#1A1406"], 256: ["#D9AA43", "#1A1406"],
    512: ["#E6B748", "#1A1406"], 1024: ["#F2C14E", "#1A1406"], 2048: ["#FFD66E", "#1A1406"] };
  const tzCol = (v) => TZ_COL[v] || ["#FFE9A8", "#1A1406"];

  DG.css("tiles2048", hudCss("tiles2048") + `
    .g-tiles2048{display:grid;gap:10px;user-select:none;-webkit-user-select:none}
    .g-tiles2048-board{--g:2.4%;position:relative;width:100%;max-width:420px;margin:0 auto;aspect-ratio:1;background:var(--line);
      border-radius:var(--r-md);touch-action:none;container-type:inline-size;overflow:hidden;cursor:grab}
    .g-tiles2048-slot,.g-tiles2048-tile{position:absolute;left:var(--g);top:var(--g);width:calc((100% - 5 * var(--g)) / 4);height:calc((100% - 5 * var(--g)) / 4)}
    .g-tiles2048-slot{background:var(--panel);border-radius:8px}
    .g-tiles2048-tile{transform:translate(calc(var(--c) * var(--step)), calc(var(--r) * var(--step)));transition:transform .11s ease-out;z-index:1}
    .g-tiles2048-tile.die{z-index:0}
    .g-tiles2048-in{width:100%;height:100%;border-radius:8px;display:grid;place-items:center;font-family:var(--f-mono);font-weight:700;
      font-size:var(--fs,9cqw);background:var(--bg);color:var(--fg2);box-shadow:inset 0 -3px 0 rgba(0,0,0,.2)}
    .g-tiles2048-tile.hi .g-tiles2048-in{box-shadow:0 0 18px color-mix(in srgb,var(--gold) 55%,transparent),inset 0 -3px 0 rgba(0,0,0,.2)}
    .g-tiles2048-tile.new .g-tiles2048-in{animation:g-tiles2048-new .16s ease-out}
    .g-tiles2048-tile.pop .g-tiles2048-in{animation:g-tiles2048-pop .16s ease-out}
    @keyframes g-tiles2048-new{from{transform:scale(.3);opacity:.2}to{transform:scale(1);opacity:1}}
    @keyframes g-tiles2048-pop{50%{transform:scale(1.14)}}
    .g-tiles2048-over{position:absolute;inset:0;display:none;place-items:center;background:rgba(16,17,31,.72);z-index:3;
      font-family:var(--f-display);font-weight:800;font-size:9cqw;text-transform:uppercase;color:var(--fg)}
    .g-tiles2048-over.on{display:grid}
    @media (pointer:coarse){.g-tiles2048-kbd{display:none}}
    .g-tiles2048-pad{display:none;grid-template-columns:repeat(4,1fr);gap:6px;max-width:420px;margin:0 auto;width:100%}`);

  function playTiles(ctx) {
    blockScrollKeys(ctx);
    const onKey = gameKeys(ctx);
    const mode = ctx.mode === "mix" ? "mix" : "full", LIMIT = TZ_LIMIT[mode] * 1000;
    const st = tzNew(ctx.seed);
    let done = false, pending = null, tiles = new Map(), maxTile = Math.max(...st.b);
    const root = ctx.root;
    let slots = "";
    for (let i = 0; i < 16; i++) slots += `<div class="g-tiles2048-slot" style="transform:translate(calc(${i % 4} * var(--step)),calc(${(i / 4) | 0} * var(--step)))"></div>`;
    root.innerHTML = `<div class="g-tiles2048" data-test="tiles2048">
      ${hud("tiles2048", [["time", "Time"], ["score", "Score"], ["best", "Best tile"], ["moves", "Moves"]])}
      <div class="g-tiles2048-board" data-test="board" tabindex="0" aria-label="2048 board. Swipe or use arrow keys.">${slots}<div class="g-tiles2048-over" data-test="over">No moves left</div></div>
      <p class="dg-note dg-center" style="margin:0">Swipe<span class="g-tiles2048-kbd">, or use arrow keys / WASD</span>. Equal tiles merge and add their value to your score.</p>
    </div>`;
    const board = root.querySelector(".g-tiles2048-board");
    const setStep = () => { const w = board.clientWidth || 300, g = w * 0.024, s = (w - 5 * g) / 4; board.style.setProperty("--step", s + g + "px"); };
    setStep();
    const ro = typeof ResizeObserver === "function" ? new ResizeObserver(() => { if (!ctx.signal.ended) setStep(); }) : null;
    if (ro) { ro.observe(board); if (ctx.onCleanup) ctx.onCleanup(() => ro.disconnect()); }

    function styleTile(el, v) {
      const [bg, fg] = tzCol(v), dg = String(v).length;
      el.style.setProperty("--bg", bg); el.style.setProperty("--fg2", fg);
      el.style.setProperty("--fs", dg <= 2 ? "9.5cqw" : dg === 3 ? "8cqw" : dg === 4 ? "6.4cqw" : "5.2cqw");
      el.classList.toggle("hi", v >= 128);
      el.firstChild.textContent = v;
    }
    function makeTile(cell, v, cls) {
      const el = document.createElement("div");
      el.className = "g-tiles2048-tile" + (cls && !ctx.reducedMotion ? " " + cls : "");
      el.innerHTML = '<div class="g-tiles2048-in"></div>';
      el.style.setProperty("--r", (cell / 4) | 0); el.style.setProperty("--c", cell % 4);
      el.dataset.v = v;
      styleTile(el, v);
      board.appendChild(el);
      return { el, v };
    }
    for (let i = 0; i < 16; i++) if (st.b[i]) tiles.set(i, makeTile(i, st.b[i], "new"));
    function flush() {
      if (!pending) return;
      const p = pending; pending = null;
      ctx.clearTimeout(p.tid);
      p.dying.forEach((t) => t.el.remove());
      for (const [cell, t] of tiles) {
        if (t.v !== st.b[cell]) { t.v = st.b[cell]; t.el.dataset.v = t.v; styleTile(t.el, t.v); t.el.classList.remove("new", "pop"); if (!ctx.reducedMotion) { void t.el.offsetWidth; t.el.classList.add("pop"); } }
      }
      for (let i = 0; i < 16; i++) if (st.b[i] && !tiles.has(i)) tiles.set(i, makeTile(i, st.b[i], "new"));
    }
    function hudUpdate() {
      setHud(root, "score", U.fmt(st.score)); setHud(root, "best", String(maxTile)); setHud(root, "moves", String(st.moves));
    }
    function move(dir) {
      if (done || ctx.signal.ended) return false;
      flush();
      const res = tzSlide(st.b, dir);
      if (!res.moved) return false;
      const next = new Map(), dying = [];
      for (const m of res.moves) {
        const t = tiles.get(m.from);
        if (!t) continue;
        t.el.style.setProperty("--r", (m.to / 4) | 0); t.el.style.setProperty("--c", m.to % 4);
        if (m.merge) { t.el.classList.add("die"); dying.push(t); } else next.set(m.to, t);
      }
      tiles = next;
      st.b = res.b; st.score += res.gain; st.moves++;
      tzSpawn(st);
      maxTile = Math.max(maxTile, ...st.b);
      pending = { dying, tid: ctx.timeout(flush, ctx.reducedMotion ? 0 : 115) };
      if (ctx.reducedMotion) flush();
      if (res.gain) ctx.progress(st.score);
      hudUpdate();
      if (!tzCanMove(st.b)) { flush(); root.querySelector(".g-tiles2048-over").classList.add("on"); finish("over"); }
      return true;
    }
    function status() {
      const left = Math.max(0, LIMIT - ctx.now());
      setHud(root, "time", clock(left / 1000));
      ctx.setStatus(clock(left / 1000) + " · " + U.fmt(st.score) + " pts");
    }
    function finish(why) {
      if (done) return;
      done = true;
      if (ro) ro.disconnect();
      const el = Math.min(LIMIT, ctx.now());
      ctx.progress(st.score);
      const detail = detailBox([`<b>${U.fmt(st.score)} points</b> · best tile ${maxTile} · ${plural(st.moves, "move")}`,
        why === "over" ? `No moves left after ${clock(el / 1000)}.` : "Time up."]);
      ctx.setStatus(why === "over" ? "No moves left" : "Time up");
      const endIt = () => ctx.end({ score: st.score, detail });
      if (why === "over") ctx.timeout(endIt, ctx.reducedMotion ? 150 : 900); else endIt();
    }
    let sw = null;
    board.addEventListener("pointerdown", (e) => { if (done) return; sw = { x: e.clientX, y: e.clientY, id: e.pointerId }; try { board.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ } });
    board.addEventListener("pointerup", (e) => {
      if (!sw || done) { sw = null; return; }
      const dx = e.clientX - sw.x, dy = e.clientY - sw.y; sw = null;
      if (Math.max(Math.abs(dx), Math.abs(dy)) < 24) return;
      move(Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 1 : 3) : dy > 0 ? 2 : 0);
    });
    board.addEventListener("pointercancel", () => { sw = null; });
    const KEYS = { ArrowUp: 0, w: 0, W: 0, ArrowRight: 1, d: 1, D: 1, ArrowDown: 2, s: 2, S: 2, ArrowLeft: 3, a: 3, A: 3 };
    onKey((e) => { if (done) return; if (e.key in KEYS) { e.preventDefault(); move(KEYS[e.key]); } });
    ctx.interval(() => { if (done) return; status(); if (ctx.now() >= LIMIT) { flush(); finish("time"); } }, 250);
    hudUpdate(); status(); ctx.progress(0);
    if (!tzCanMove(st.b)) finish("over");
    ctx.test = {
      move: (dir) => move(typeof dir === "string" ? { up: 0, right: 1, down: 2, left: 3 }[dir] : dir),
      best: () => tzBest(st.b),
      state: () => ({ board: st.b.slice(), score: st.score, moves: st.moves, maxTile, done, canMove: tzCanMove(st.b) }),
      solution: () => ({ bestMove: tzBest(st.b) }),
      solve() { let k = 0; while (!done && k++ < 5000) { const d = tzBest(st.b); if (d < 0 || !move(d)) break; } return st.score; },
      tiles: () => [...board.querySelectorAll(".g-tiles2048-tile:not(.die)")].length,
    };
  }

  DG.registerGame({
    id: "tiles2048", name: "Merge 2048", category: "numbers", kind: "race", formats: FORMATS,
    skill: 7, luck: 1, cashEligible: true, duration: "90 s", pack: "brain", scoreLabel: "points",
    blurb: "Slide and merge number tiles. Same tile drops for everyone. Biggest score in 90 s wins.",
    rules: [
      "Swipe or use arrow keys / WASD to slide every tile.",
      "Two equal tiles merge into one; the new value is added to your score.",
      "New tiles (2 or 4) appear in a fixed seeded order, identical for every player.",
      "90 s (Duel Mix: 40 s). If no move is left, your score stands.",
    ],
    play: playTiles,
    bot: tzBot,
    lab: {
      sim: (seed, moves) => { const st = tzNew(seed); for (const d of moves) { const r = tzSlide(st.b, d); if (!r.moved) continue; st.b = r.b; st.score += r.gain; tzSpawn(st); } return { board: st.b, score: st.score }; },
      initial: (seed) => tzNew(seed).b,
      human: (seed, mode) => { const r = tzSim(seed, mode, { rate: 2.8, pBest: 1, startup: 1 }, null); return { score: r.score, moves: r.moves, maxTile: r.maxTile }; },
    },
  });

  /* ====================================================================
     5. MEMORY DUEL
     ==================================================================== */
  const MEM_CAP = { full: 240, mix: 45 };
  const MEM_STEP = { full: 0.62, mix: 0.48 }, MEM_ON = { full: 0.42, mix: 0.32 };
  const memGrid = (level) => (level <= 8 ? 3 : 4);
  const memLen = (level) => level + 2;
  function memSeq(seed) {
    return memo("mem|" + seed, () => {
      const rng = U.rng("memory|" + seed), seq = [];
      for (let k = 0; k < 80; k++) {
        const g = k < memLen(8) ? 3 : 4;
        let r, c;
        do { r = Math.floor(rng() * g); c = Math.floor(rng() * g); }
        while (seq.length && seq[k - 1][0] === r && seq[k - 1][1] === c);
        seq.push([r, c]);
      }
      return seq;
    });
  }
  const memBonus = (len, avgTap) => Math.round(len * 10 * U.clamp(1.5 - avgTap, 0, 1));
  /* p = {levels (completed before the mistake), tap (s/tap)} */
  function memSim(seed, mode, p, rng) {
    mode = mode === "mix" ? "mix" : "full";
    const CAP = MEM_CAP[mode], tl = [[0, 0]];
    let t = 0.9, score = 0, longest = 0, bonus = 0;
    for (let L = 1; ; L++) {
      const len = memLen(L);
      t += len * MEM_STEP[mode] + 0.2;
      if (t >= CAP) break;
      if (L > p.levels) { t += (rng ? rng() : 0.5) * len * p.tap + 0.3; break; }
      const inp = len * p.tap * (rng ? ln(rng, 0.1) : 1);
      if (t + inp > CAP) { t = CAP; break; }
      t += inp; longest = len; bonus += memBonus(len, inp / len);
      score = 100 * longest + bonus;
      tl.push([r2(t), score]);
      t += 0.7;
    }
    tl.push([r2(Math.min(t, CAP)), score]);
    return { score, timeline: tl, longest };
  }
  function memBot(seed, skill, rng, mode) {
    const levels = Math.max(0, Math.round(5 + 8 * skill + 1.5 * U.gauss(rng)));
    const tap = U.clamp(0.9 - 0.55 * skill + 0.07 * U.gauss(rng), 0.3, 1.4);
    return memSim(seed, mode, { levels, tap }, rng);
  }

  DG.css("memory", hudCss("memory") + `
    .g-memory{display:grid;gap:12px;user-select:none;-webkit-user-select:none}
    .g-memory-msg{text-align:center;font-family:var(--f-display);font-weight:800;font-size:26px;text-transform:uppercase;letter-spacing:.02em;min-height:32px;margin:0}
    .g-memory-msg.go{color:var(--gold)}
    .g-memory-grid{display:grid;grid-template-columns:repeat(var(--g),minmax(0,1fr));gap:10px;width:100%;max-width:380px;margin:0 auto;aspect-ratio:1;touch-action:manipulation}
    .g-memory-cell{border:1px solid var(--line);border-radius:var(--r-md);background:var(--panel-2);padding:0;min-width:0;min-height:0;
      transition:background .12s,box-shadow .12s,transform .12s;position:relative}
    .g-memory-cell:disabled{cursor:default;opacity:1}
    .g-memory.input .g-memory-cell:hover{background:var(--panel-3)}
    .g-memory-cell.lit{background:var(--gold);border-color:var(--gold);box-shadow:0 0 26px color-mix(in srgb,var(--gold) 60%,transparent);transform:scale(1.03)}
    .g-memory-cell.tap{background:color-mix(in srgb,var(--gold) 55%,var(--panel-2));border-color:var(--gold)}
    .g-memory-cell.bad{background:var(--bad);border-color:var(--bad)}
    .g-memory-cell.want{box-shadow:inset 0 0 0 4px var(--good)}
    .g-memory-cell small{position:absolute;left:8px;top:5px;font-size:11px;color:var(--muted);font-family:var(--f-mono)}
    .g-memory-dots{display:flex;gap:5px;justify-content:center;flex-wrap:wrap;min-height:10px}
    .g-memory-dots i{width:9px;height:9px;border-radius:50%;background:var(--panel-3)}
    .g-memory-dots i.on{background:var(--gold)}`);

  function playMemory(ctx) {
    blockScrollKeys(ctx);
    const onKey = gameKeys(ctx);
    const mode = ctx.mode === "mix" ? "mix" : "full", CAP = MEM_CAP[mode] * 1000;
    const SEQ = memSeq(ctx.seed);
    let level = 0, grid = 0, phase = "intro", idx = 0, inputStart = 0, longest = 0, bonus = 0, score = 0, done = false;
    const root = ctx.root;
    root.innerHTML = `<div class="g-memory" data-test="memory">
      ${hud("memory", [["time", "Time"], ["level", "Level"], ["long", "Longest"], ["score", "Score"]])}
      <p class="g-memory-msg" data-test="msg">Get ready</p>
      <div class="g-memory-grid" data-test="grid"></div>
      <div class="g-memory-dots" data-test="dots"></div>
      <p class="dg-note dg-center" style="margin:0">Watch the squares light up, then tap them in the same order. One wrong tap ends the run. After level 8 the grid grows to 4×4.</p>
    </div>`;
    const wrap = root.querySelector(".g-memory"), gridEl = root.querySelector(".g-memory-grid"), msg = root.querySelector(".g-memory-msg"), dots = root.querySelector(".g-memory-dots");
    let cellEls = [];
    const KEYS3 = ["1", "2", "3", "4", "5", "6", "7", "8", "9"], KEYS4 = ["1", "2", "3", "4", "q", "w", "e", "r", "a", "s", "d", "f", "z", "x", "c", "v"];
    const KEYS3B = ["q", "w", "e", "a", "s", "d", "z", "x", "c"];
    function build(g) {
      grid = g;
      gridEl.style.setProperty("--g", g);
      const keys = g === 3 ? KEYS3 : KEYS4;
      let h = "";
      for (let i = 0; i < g * g; i++) h += `<button class="g-memory-cell" data-i="${i}" data-test="cell-${i}" aria-label="Square ${i + 1}" disabled><small>${keys[i].toUpperCase()}</small></button>`;
      gridEl.innerHTML = h;
      cellEls = [...gridEl.children];
    }
    const seqCells = () => SEQ.slice(0, memLen(level)).map(([r, c]) => r * grid + c);
    function setMsg(t, go) { msg.textContent = t; msg.classList.toggle("go", !!go); }
    function paintDots() {
      const len = memLen(level);
      let h = "";
      for (let k = 0; k < len; k++) h += `<i class="${k < idx ? "on" : ""}"></i>`;
      dots.innerHTML = h;
    }
    function hudUpdate() {
      setHud(root, "level", String(level || 1)); setHud(root, "long", String(longest)); setHud(root, "score", U.fmt(score));
    }
    function setInput(on) { cellEls.forEach((b) => (b.disabled = !on)); wrap.classList.toggle("input", on); }
    function startLevel() {
      if (done) return;
      level++; idx = 0;
      const g = memGrid(level);
      if (g !== grid) build(g);
      phase = "show"; setInput(false);
      setMsg("Level " + level + " · watch");
      paintDots(); hudUpdate(); status();
      const cells = seqCells(), step = MEM_STEP[mode] * 1000, on = MEM_ON[mode] * 1000;
      cells.forEach((ci, k) => {
        ctx.timeout(() => { cellEls[ci].classList.add("lit"); }, 250 + k * step);
        ctx.timeout(() => { cellEls[ci].classList.remove("lit"); }, 250 + k * step + on);
      });
      ctx.timeout(() => {
        phase = "input"; idx = 0; inputStart = ctx.now();
        setInput(true); setMsg("Your turn", true); paintDots();
      }, 250 + (cells.length - 1) * step + on + 120);
    }
    function tap(ci) {
      if (done || phase !== "input" || ci < 0 || ci >= grid * grid) return;
      const cells = seqCells(), want = cells[idx], el = cellEls[ci];
      if (ci === want) {
        el.classList.remove("tap"); void el.offsetWidth; el.classList.add("tap");
        ctx.timeout(() => el.classList.remove("tap"), 180);
        idx++; paintDots();
        if (idx === cells.length) {
          const len = cells.length, avg = (ctx.now() - inputStart) / 1000 / len;
          longest = len; bonus += memBonus(len, avg);
          score = 100 * longest + bonus;
          ctx.progress(score); hudUpdate();
          phase = "pause"; setInput(false); setMsg("Level " + level + " cleared", true);
          ctx.timeout(startLevel, 700);
        }
      } else {
        phase = "over"; setInput(false);
        el.classList.add("bad"); cellEls[want].classList.add("want");
        setMsg("Wrong square");
        finish("mistake");
      }
    }
    function status() {
      const left = Math.max(0, CAP - ctx.now());
      setHud(root, "time", clock(left / 1000));
      ctx.setStatus("Level " + Math.max(1, level) + " · " + clock(left / 1000) + (phase === "input" ? " · your turn" : phase === "show" ? " · watch" : ""));
    }
    function finish(why) {
      if (done) return;
      done = true;
      ctx.progress(score);
      const detail = detailBox([`<b>${why === "mistake" ? "Missed on level " + level : "Time cap reached on level " + level}</b> · longest sequence ${longest}`,
        `${longest} × 100 + ${bonus} speed bonus = <b class="dg-gold">${U.fmt(score)}</b>`]);
      ctx.setStatus(why === "mistake" ? "Wrong square" : "Time up");
      const endIt = () => ctx.end({ score, detail });
      if (why === "mistake") ctx.timeout(endIt, ctx.reducedMotion ? 200 : 1000); else endIt();
    }
    gridEl.addEventListener("pointerdown", (e) => {
      const b = e.target.closest("[data-i]");
      if (!b || b.disabled) return;
      e.preventDefault(); tap(+b.dataset.i);
    });
    onKey((e) => {
      if (done || phase !== "input") return;
      const k = e.key.toLowerCase();
      let i = (grid === 3 ? KEYS3 : KEYS4).indexOf(k);
      if (i < 0 && grid === 3) i = KEYS3B.indexOf(k);
      if (i >= 0) { e.preventDefault(); tap(i); }
    });
    ctx.interval(() => { if (done) return; status(); if (ctx.now() >= CAP) finish("time"); }, 250);
    build(3); hudUpdate(); status(); ctx.progress(0);
    ctx.timeout(startLevel, 900);
    ctx.test = {
      sequence: () => (level ? seqCells() : []),
      tap,
      state: () => ({ level, grid, phase, idx, longest, bonus, score, done }),
      solution: () => (level ? seqCells() : []),
      solve() { if (phase !== "input") return false; const s = seqCells(); for (let k = idx; k < s.length; k++) tap(s[k]); return true; },
      mistake() { if (phase !== "input") return false; const s = seqCells(); tap((s[idx] + 1) % (grid * grid)); return true; },
    };
  }

  DG.registerGame({
    id: "memory", name: "Memory Duel", category: "puzzle", kind: "race", formats: FORMATS,
    skill: 9, luck: 0, cashEligible: true, duration: "1–4 min", pack: "brain", scoreLabel: "points",
    blurb: "Watch the squares flash, repeat the order. The sequence grows by one every level.",
    rules: [
      "Squares light up in order. Tap them back in the same order.",
      "Every level adds one more step. After level 8 the grid grows from 3×3 to 4×4.",
      "One wrong tap ends your run.",
      "Score: 100 × your longest sequence + a speed bonus for quick, correct input.",
      "Everyone gets the same sequence. Cap: 4 min (Duel Mix: 45 s).",
    ],
    play: playMemory,
    bot: memBot,
    lab: {
      sequence: (seed, n) => memSeq(seed).slice(0, n || 20),
      human: (seed, mode) => { const r = memSim(seed, mode, { levels: 11, tap: 0.45 }, null); return { score: r.score, longest: r.longest }; },
    },
  });
})();
