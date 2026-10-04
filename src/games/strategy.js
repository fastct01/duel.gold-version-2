/* Duel.gold — Pack A: STRATEGY (chess, four, reversi, gomoku).
   All games are kind 'versus' with our own AI, plus spectate(ctx) for bot-vs-bot viewing.
   The human (or players[0] in spectate) is gold; the opponent is rival red. */
(function () {
  "use strict";
  const U = DG.util;
  const esc = U.esc;
  const PACK = "strategy";
  const ABORT = { abort: true };
  /* CPU budget measurement only (never game logic): the AI must stay under ~150 ms per move. */
  const cpuNow = () => (typeof performance !== "undefined" ? performance.now() : Date.now());
  const clamp = U.clamp;

  function fmtClock(ms) {
    ms = Math.max(0, ms);
    if (ms < 10000) return (Math.floor(ms / 100) / 10).toFixed(1);
    const s = Math.ceil(ms / 1000);
    return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
  }

  /* ---------- shared per-game CSS (namespaced per game id) ---------- */
  function commonCss(P) {
    return `
.${P}{display:grid;gap:10px;min-width:0;user-select:none;-webkit-user-select:none}
.${P}-bar{--c:var(--gold);display:flex;align-items:center;gap:10px;background:var(--panel);border:1px solid var(--line);
  border-radius:var(--r-md);padding:7px 12px;min-height:50px;min-width:0;transition:border-color .2s,box-shadow .2s}
.${P}-opp{--c:var(--rival)}
.${P}-bar.on{border-color:var(--c);box-shadow:inset 4px 0 0 var(--c)}
.${P}-dot{width:14px;height:14px;border-radius:50%;background:var(--c);flex:none}
.${P}-who{flex:1;min-width:0}
.${P}-name{font-weight:700;color:var(--c);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;line-height:1.25}
.${P}-name span{color:var(--muted);font-weight:500;font-family:var(--f-mono);font-size:12px;margin-left:4px}
.${P}-sub{font-size:12px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-height:1.2em}
.${P}-right{display:flex;align-items:center;gap:8px;flex:none}
.${P}-score{font-family:var(--f-mono);font-weight:700;font-size:20px;font-variant-numeric:tabular-nums}
.${P}-clock{font-family:var(--f-mono);font-weight:700;font-size:17px;background:var(--panel-2);border-radius:var(--r-sm);
  padding:3px 8px;min-width:60px;text-align:center;font-variant-numeric:tabular-nums}
.${P}-bar.on .${P}-clock{background:color-mix(in srgb,var(--c) 22%,var(--panel-2))}
.${P}-clock.low{color:var(--bad)}
.${P}-clock:empty{display:none}
.${P}-note{margin:0;min-height:1.5em;text-align:center;font-size:13px;color:var(--muted)}
.${P}-note b{color:var(--fg)}
.${P}-stage{position:relative;display:flex;justify-content:center;min-width:0}
.${P}-banner{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);background:color-mix(in srgb,var(--ink) 88%,transparent);
  border:1px solid var(--line);border-radius:var(--r-lg);padding:14px 22px;text-align:center;z-index:5;min-width:200px;max-width:90%;pointer-events:none}
.${P}-banner .dg-h{font-size:30px}
`;
  }
  function barHtml(P, who, pl) {
    return `<div class="${P}-bar ${P}-${who}" data-test="${who}-bar"><i class="${P}-dot"></i>
      <div class="${P}-who"><div class="${P}-name">${esc(pl.name || (who === "me" ? "You" : "Rival"))}<span>${pl.rating ? Math.round(pl.rating) : ""}</span></div>
      <div class="${P}-sub"></div></div>
      <div class="${P}-right"><span class="${P}-score"></span><span class="${P}-clock"></span></div></div>`;
  }
  function setBar(el, P, o) {
    if (!el) return;
    el.classList.toggle("on", !!o.on);
    const sub = el.querySelector("." + P + "-sub"), sc = el.querySelector("." + P + "-score"), ck = el.querySelector("." + P + "-clock");
    if (o.sub !== undefined && sub.innerHTML !== o.sub) sub.innerHTML = o.sub;
    if (o.score !== undefined) sc.textContent = o.score;
    if (o.clock !== undefined) { ck.textContent = o.clock; ck.classList.toggle("low", !!o.low); }
  }
  function playersFor(ctx, spectate) {
    if (spectate) return [Object.assign({ name: "Gold", skill: 0.5 }, ctx.players[0]), Object.assign({ name: "Red", skill: 0.5 }, ctx.players[1])];
    const opp = Object.assign({ name: "Rival", rating: 1200, skill: 0.5 }, ctx.opponents && ctx.opponents[0]);
    return [{ name: (ctx.me && ctx.me.name) || "You", rating: ctx.me && ctx.me.rating, skill: null }, opp];
  }
  function banner(P, title, sub, cls) {
    return `<div class="${P}-banner" data-test="banner"><div class="dg-h ${cls || ""}">${esc(title)}</div><div class="dg-note">${esc(sub || "")}</div></div>`;
  }

  /* =====================================================================
     CHESS ENGINE (0x88, negamax alpha-beta + quiescence + iterative deepening)
     chess.js is the rules authority for the actual game; this engine only picks moves.
     ===================================================================== */
  const CE = (function () {
    const b = new Int8Array(128);
    let side = 0, castle = 0, ep = -1, sp = 0, nodes = 0, deadline = 0;
    const kings = [0, 0];
    const US = new Int32Array(512), UC = new Int8Array(512), UCa = new Int8Array(512), UE = new Int16Array(512);
    const VAL = [0, 100, 320, 330, 500, 900, 0];
    const NO = [-33, -31, -18, -14, 14, 18, 31, 33], BO = [-17, -15, 15, 17], RO = [-16, -1, 1, 16], KO = [-17, -16, -15, -1, 1, 15, 16, 17];
    const CM = new Int8Array(128).fill(15);
    CM[0x74] = 12; CM[0x77] = 14; CM[0x70] = 13; CM[0x04] = 3; CM[0x07] = 11; CM[0x00] = 7;
    const MATE = 100000;
    const PST = [null,
      [0,0,0,0,0,0,0,0, 50,50,50,50,50,50,50,50, 10,10,20,30,30,20,10,10, 5,5,10,25,25,10,5,5, 0,0,0,20,20,0,0,0, 5,-5,-10,0,0,-10,-5,5, 5,10,10,-20,-20,10,10,5, 0,0,0,0,0,0,0,0],
      [-50,-40,-30,-30,-30,-30,-40,-50, -40,-20,0,0,0,0,-20,-40, -30,0,10,15,15,10,0,-30, -30,5,15,20,20,15,5,-30, -30,0,15,20,20,15,0,-30, -30,5,10,15,15,10,5,-30, -40,-20,0,5,5,0,-20,-40, -50,-40,-30,-30,-30,-30,-40,-50],
      [-20,-10,-10,-10,-10,-10,-10,-20, -10,0,0,0,0,0,0,-10, -10,0,5,10,10,5,0,-10, -10,5,5,10,10,5,5,-10, -10,0,10,10,10,10,0,-10, -10,10,10,10,10,10,10,-10, -10,5,0,0,0,0,5,-10, -20,-10,-10,-10,-10,-10,-10,-20],
      [0,0,0,0,0,0,0,0, 5,10,10,10,10,10,10,5, -5,0,0,0,0,0,0,-5, -5,0,0,0,0,0,0,-5, -5,0,0,0,0,0,0,-5, -5,0,0,0,0,0,0,-5, -5,0,0,0,0,0,0,-5, 0,0,0,5,5,0,0,0],
      [-20,-10,-10,-5,-5,-10,-10,-20, -10,0,0,0,0,0,0,-10, -10,0,5,5,5,5,0,-10, -5,0,5,5,5,5,0,-5, 0,0,5,5,5,5,0,-5, -10,5,5,5,5,5,0,-10, -10,0,5,0,0,0,0,-10, -20,-10,-10,-5,-5,-10,-10,-20],
      [-30,-40,-40,-50,-50,-40,-40,-30, -30,-40,-40,-50,-50,-40,-40,-30, -30,-40,-40,-50,-50,-40,-40,-30, -30,-40,-40,-50,-50,-40,-40,-30, -20,-30,-30,-40,-40,-30,-30,-20, -10,-20,-20,-20,-20,-20,-20,-10, 20,20,0,0,0,0,20,20, 20,30,10,0,0,10,30,20],
    ];
    const KEND = [-50,-40,-30,-20,-20,-30,-40,-50, -30,-20,-10,0,0,-10,-20,-30, -30,-10,20,30,30,20,-10,-30, -30,-10,30,40,40,30,-10,-30, -30,-10,30,40,40,30,-10,-30, -30,-10,20,30,30,20,-10,-30, -30,-30,0,0,0,0,-30,-30, -50,-30,-30,-30,-30,-30,-30,-50];

    function load(fen) {
      b.fill(0); sp = 0;
      const f = fen.split(" ");
      let r = 0, c = 0;
      for (const ch of f[0]) {
        if (ch === "/") { r++; c = 0; continue; }
        if (ch >= "1" && ch <= "8") { c += +ch; continue; }
        const lo = ch.toLowerCase(), t = "pnbrqk".indexOf(lo) + 1, col = ch === lo ? 8 : 0;
        b[r * 16 + c] = t | col;
        if (t === 6) kings[col ? 1 : 0] = r * 16 + c;
        c++;
      }
      side = f[1] === "b" ? 1 : 0;
      const cs = f[2] || "-";
      castle = (cs.includes("K") ? 1 : 0) | (cs.includes("Q") ? 2 : 0) | (cs.includes("k") ? 4 : 0) | (cs.includes("q") ? 8 : 0);
      ep = !f[3] || f[3] === "-" ? -1 : (8 - +f[3][1]) * 16 + (f[3].charCodeAt(0) - 97);
    }
    function att(sq, by) {
      const cb = by << 3;
      let x;
      if (by === 0) {
        x = sq + 15; if (!(x & 0x88) && b[x] === 1) return true;
        x = sq + 17; if (!(x & 0x88) && b[x] === 1) return true;
      } else {
        x = sq - 15; if (!(x & 0x88) && b[x] === 9) return true;
        x = sq - 17; if (!(x & 0x88) && b[x] === 9) return true;
      }
      for (let i = 0; i < 8; i++) {
        x = sq + NO[i]; if (!(x & 0x88) && b[x] === (2 | cb)) return true;
        x = sq + KO[i]; if (!(x & 0x88) && b[x] === (6 | cb)) return true;
      }
      for (let i = 0; i < 4; i++) {
        let o = BO[i]; x = sq + o;
        while (!(x & 0x88)) { const q = b[x]; if (q) { if (q === (3 | cb) || q === (5 | cb)) return true; break; } x += o; }
        o = RO[i]; x = sq + o;
        while (!(x & 0x88)) { const q = b[x]; if (q) { if (q === (4 | cb) || q === (5 | cb)) return true; break; } x += o; }
      }
      return false;
    }
    function gen(list, caps) {
      const us = side, cb = us << 3, them = us ^ 1;
      for (let sq = 0; sq < 120; sq++) {
        if (sq & 0x88) { sq += 7; continue; }
        const p = b[sq];
        if (!p || (p & 8) !== cb) continue;
        const t = p & 7;
        if (t === 1) {
          const d = us ? 16 : -16, pr = us ? 7 : 0, to = sq + d;
          if (!(to & 0x88) && !b[to]) {
            if ((to >> 4) === pr) { list.push(sq | (to << 7) | (5 << 14)); if (!caps) list.push(sq | (to << 7) | (2 << 14), sq | (to << 7) | (4 << 14), sq | (to << 7) | (3 << 14)); }
            else if (!caps) {
              list.push(sq | (to << 7));
              if ((sq >> 4) === (us ? 1 : 6) && !b[to + d]) list.push(sq | ((to + d) << 7) | (4 << 17));
            }
          }
          for (let k = 0; k < 2; k++) {
            const x = sq + d + (k ? 1 : -1);
            if (x & 0x88) continue;
            const q = b[x];
            if (q && (q & 8) !== cb) {
              if ((x >> 4) === pr) { list.push(sq | (x << 7) | (5 << 14)); if (!caps) list.push(sq | (x << 7) | (2 << 14), sq | (x << 7) | (4 << 14), sq | (x << 7) | (3 << 14)); }
              else list.push(sq | (x << 7));
            } else if (x === ep) list.push(sq | (x << 7) | (1 << 17));
          }
        } else if (t === 2 || t === 6) {
          const offs = t === 2 ? NO : KO;
          for (let i = 0; i < 8; i++) {
            const x = sq + offs[i]; if (x & 0x88) continue;
            const q = b[x];
            if (!q) { if (!caps) list.push(sq | (x << 7)); } else if ((q & 8) !== cb) list.push(sq | (x << 7));
          }
          if (t === 6 && !caps) {
            if (us === 0 && sq === 0x74) {
              if ((castle & 1) && !b[0x75] && !b[0x76] && b[0x77] === 4 && !att(0x74, them) && !att(0x75, them) && !att(0x76, them)) list.push(0x74 | (0x76 << 7) | (2 << 17));
              if ((castle & 2) && !b[0x73] && !b[0x72] && !b[0x71] && b[0x70] === 4 && !att(0x74, them) && !att(0x73, them) && !att(0x72, them)) list.push(0x74 | (0x72 << 7) | (2 << 17));
            } else if (us === 1 && sq === 0x04) {
              if ((castle & 4) && !b[0x05] && !b[0x06] && b[0x07] === 12 && !att(0x04, them) && !att(0x05, them) && !att(0x06, them)) list.push(0x04 | (0x06 << 7) | (2 << 17));
              if ((castle & 8) && !b[0x03] && !b[0x02] && !b[0x01] && b[0x00] === 12 && !att(0x04, them) && !att(0x03, them) && !att(0x02, them)) list.push(0x04 | (0x02 << 7) | (2 << 17));
            }
          }
        } else {
          const offs = t === 3 ? BO : t === 4 ? RO : KO;
          for (let i = 0; i < offs.length; i++) {
            const o = offs[i]; let x = sq + o;
            while (!(x & 0x88)) {
              const q = b[x];
              if (!q) { if (!caps) list.push(sq | (x << 7)); }
              else { if ((q & 8) !== cb) list.push(sq | (x << 7)); break; }
              x += o;
            }
          }
        }
      }
    }
    function make(m) {
      const f = m & 127, t = (m >> 7) & 127, pr = (m >> 14) & 7, fl = m >> 17, p = b[f];
      US[sp] = m; UC[sp] = b[t]; UCa[sp] = castle; UE[sp] = ep; sp++;
      b[t] = pr ? (pr | (p & 8)) : p; b[f] = 0;
      if (fl & 1) b[t + (side ? -16 : 16)] = 0;
      else if (fl & 2) {
        if (t === 0x76) { b[0x75] = b[0x77]; b[0x77] = 0; } else if (t === 0x72) { b[0x73] = b[0x70]; b[0x70] = 0; }
        else if (t === 0x06) { b[0x05] = b[0x07]; b[0x07] = 0; } else { b[0x03] = b[0x00]; b[0x00] = 0; }
      }
      ep = fl & 4 ? (f + t) >> 1 : -1;
      castle &= CM[f] & CM[t];
      if ((p & 7) === 6) kings[side] = t;
      side ^= 1;
    }
    function unmake() {
      sp--;
      const m = US[sp], f = m & 127, t = (m >> 7) & 127, pr = (m >> 14) & 7, fl = m >> 17;
      side ^= 1;
      const p = b[t];
      b[f] = pr ? (1 | (side << 3)) : p; b[t] = UC[sp];
      if (fl & 1) b[t + (side ? -16 : 16)] = 1 | ((side ^ 1) << 3);
      else if (fl & 2) {
        if (t === 0x76) { b[0x77] = b[0x75]; b[0x75] = 0; } else if (t === 0x72) { b[0x70] = b[0x73]; b[0x73] = 0; }
        else if (t === 0x06) { b[0x07] = b[0x05]; b[0x05] = 0; } else { b[0x00] = b[0x03]; b[0x03] = 0; }
      }
      castle = UCa[sp]; ep = UE[sp];
      if ((b[f] & 7) === 6) kings[side] = f;
    }
    function evaluate() {
      let s = 0, np0 = 0, np1 = 0, m0 = 0, m1 = 0, b0 = 0, b1 = 0, k0 = 0, k1 = 0;
      for (let sq = 0; sq < 120; sq++) {
        if (sq & 0x88) { sq += 7; continue; }
        const p = b[sq]; if (!p) continue;
        const t = p & 7, black = p & 8;
        const idx = black ? ((7 - (sq >> 4)) << 3) | (sq & 7) : ((sq >> 4) << 3) | (sq & 7);
        if (t === 6) { if (black) k1 = idx; else k0 = idx; continue; }
        const v = VAL[t] + PST[t][idx];
        if (black) { s -= v; m1 += VAL[t]; if (t > 1) np1 += VAL[t]; if (t === 3) b1++; }
        else { s += v; m0 += VAL[t]; if (t > 1) np0 += VAL[t]; if (t === 3) b0++; }
      }
      if (b0 >= 2) s += 30; if (b1 >= 2) s -= 30;
      const end = np0 + np1 <= 1400;
      const KT = end ? KEND : PST[6];
      s += KT[k0] - KT[k1];
      if (end && Math.abs(m0 - m1) >= 300) {
        /* mop-up: drive the losing king to the edge and bring our king close */
        const wk = kings[0], bk = kings[1];
        const cd = (sq) => Math.max(3 - (sq >> 4), (sq >> 4) - 4) + Math.max(3 - (sq & 7), (sq & 7) - 4);
        const dist = Math.abs((wk >> 4) - (bk >> 4)) + Math.abs((wk & 7) - (bk & 7));
        const bonus = (m0 > m1 ? cd(bk) : cd(wk)) * 12 + (14 - dist) * 5;
        s += m0 > m1 ? bonus : -bonus;
      }
      return side ? -s : s;
    }
    let killers = [];
    function oscore(m, ply) {
      const f = m & 127, t = (m >> 7) & 127, pr = (m >> 14) & 7, fl = m >> 17;
      let s = 0;
      const v = b[t];
      if (v) s = 10000 + (v & 7) * 100 - (b[f] & 7);
      else if (fl & 1) s = 10099;
      if (pr) s += 9000 + pr;
      if (!s) { const k = killers[ply]; if (k) { if (k[0] === m) s = 5000; else if (k[1] === m) s = 4000; } }
      return s;
    }
    function order(list, ply) {
      const sc = new Array(list.length);
      for (let i = 0; i < list.length; i++) sc[i] = oscore(list[i], ply);
      const idx = list.map((_, i) => i).sort((a, c) => sc[c] - sc[a]);
      return idx.map((i) => list[i]);
    }
    function qs(alpha, beta, ply) {
      if ((++nodes & 1023) === 0 && cpuNow() > deadline) throw ABORT;
      const stand = evaluate();
      if (stand >= beta) return stand;
      if (stand > alpha) alpha = stand;
      if (ply > 40) return stand;
      const list = []; gen(list, true);
      const ms = order(list, ply);
      for (let i = 0; i < ms.length; i++) {
        make(ms[i]);
        if (att(kings[side ^ 1], side)) { unmake(); continue; }
        const s = -qs(-beta, -alpha, ply + 1);
        unmake();
        if (s >= beta) return s;
        if (s > alpha) alpha = s;
      }
      return alpha;
    }
    function search(depth, alpha, beta, ply) {
      if ((++nodes & 1023) === 0 && cpuNow() > deadline) throw ABORT;
      const inCheck = att(kings[side], side ^ 1);
      if (inCheck && ply < 16) depth++;
      if (depth <= 0) return qs(alpha, beta, ply);
      const list = []; gen(list, false);
      const ms = order(list, ply);
      let legal = 0, best = -MATE * 2;
      for (let i = 0; i < ms.length; i++) {
        const m = ms[i];
        make(m);
        if (att(kings[side ^ 1], side)) { unmake(); continue; }
        legal++;
        const s = -search(depth - 1, -beta, -alpha, ply + 1);
        unmake();
        if (s > best) {
          best = s;
          if (s > alpha) {
            alpha = s;
            if (s >= beta) {
              if (!b[(m >> 7) & 127] && !((m >> 17) & 1) && killers[ply]) { const k = killers[ply]; if (k[0] !== m) { k[1] = k[0]; k[0] = m; } }
              break;
            }
          }
        }
      }
      if (!legal) return inCheck ? -MATE + ply : 0;
      return best;
    }
    function key() { return String.fromCharCode.apply(null, b) + side + "|" + castle + "|" + ep; }
    function legalRoot() {
      const all = [], out = [];
      gen(all, false);
      for (const m of all) { make(m); if (!att(kings[side ^ 1], side)) out.push(m); unmake(); }
      return out;
    }
    /* o = { skill, rng, budget(ms), seen:Set of position keys already reached in the game } */
    function think(fen, o) {
      load(fen);
      killers = Array.from({ length: 64 }, () => [0, 0]);
      const skill = clamp(o.skill == null ? 0.5 : o.skill, 0, 1);
      const rng = o.rng || Math.random;
      const root = order(legalRoot(), 0).map((m) => {
        make(m); const rep = !!(o.seen && o.seen.has(key())); unmake();
        return { m, s: 0, rep };
      });
      if (!root.length) return null;
      const t0 = cpuNow();
      if (root.length === 1) return { move: root[0].m, depth: 0, nodes: 0, score: 0, ms: 0 };
      /* strength: 0.05-0.24 depth 1, -0.54 depth 2, -0.74 depth 3, above: as deep as the time budget allows */
      const maxDepth = o.maxDepth || (skill < 0.25 ? 1 : skill < 0.55 ? 2 : skill < 0.75 ? 3 : 7);
      const margin = Math.round(6 + Math.pow(1 - skill, 1.5) * 260);
      deadline = t0 + (o.budget || 120);
      nodes = 0;
      let done = null, depthDone = 0;
      for (let d = 1; d <= maxDepth; d++) {
        try {
          let best = -Infinity;
          for (const r of root) {
            make(r.m);
            let s, bound = false;
            if (r.rep) s = 0;
            else {
              /* moves that cannot come within `margin` of the best are only proven to be <= a (upper bound) */
              const a = best === -Infinity ? -MATE * 2 : best - margin - 1;
              s = -search(d - 1, -MATE * 2, -a, 1);
              if (s <= a) { bound = true; s = Math.min(s, a) - 1; }
            }
            unmake();
            r.s = s; r.bound = bound;
            if (s > best) best = s;
          }
          root.sort((x, y) => y.s - x.s);
          done = root.map((r) => ({ m: r.m, s: r.s, bound: r.bound }));
          depthDone = d;
          if (best > MATE - 200 || best < -MATE + 200) break;
        } catch (e) {
          if (e !== ABORT) throw e;
          while (sp > 0) unmake();
          break;
        }
      }
      if (!done) done = root.map((r) => ({ m: r.m, s: 0 }));
      let pick = done[0];
      const top = done[0].s;
      if (top < MATE - 200) {
        const sigma = margin * 0.45;
        let bv = -Infinity;
        for (const c of done) {
          if (c.bound || c.s < top - margin) continue;
          const v = c.s + U.gauss(rng) * sigma;
          if (v > bv) { bv = v; pick = c; }
        }
        /* occasional human-like blunder at low skill: a random move among the top few */
        if (rng() < 0.3 * (1 - skill) * (1 - skill)) {
          const pool = done.filter((c) => c.s > -MATE + 200 && !c.bound).slice(0, 6);
          if (pool.length) pick = pool[Math.floor(rng() * pool.length)];
        }
      }
      return { move: pick.m, depth: depthDone, nodes, score: pick.s, best: top, ms: cpuNow() - t0 };
    }
    function perft(d) {
      if (d === 0) return 1;
      const list = []; gen(list, false);
      let n = 0;
      for (const m of list) { make(m); if (!att(kings[side ^ 1], side)) n += perft(d - 1); unmake(); }
      return n;
    }
    const sqName = (s) => "abcdefgh"[s & 7] + (8 - (s >> 4));
    function toObj(m) {
      const o = { from: sqName(m & 127), to: sqName((m >> 7) & 127) };
      const pr = (m >> 14) & 7;
      if (pr) o.promotion = " pnbrq"[pr];
      return o;
    }
    function keyOf(fen) { load(fen); return key(); }
    return { think, perft: (fen, d) => { load(fen); return perft(d); }, toObj, keyOf, MATE };
  })();

  /* =====================================================================
     CHESS UI
     ===================================================================== */
  const GLYPH = { k: "♚", q: "♛", r: "♜", b: "♝", n: "♞", p: "♟" };
  const G = (t) => GLYPH[t] + "︎";
  const PVAL = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
  const START_COUNT = { p: 8, n: 2, b: 2, r: 2, q: 1 };

  DG.css("chess", commonCss("g-chess") + `
.g-chess-wrap{container-type:inline-size}
.g-chess{grid-template-columns:minmax(0,1fr)}
.g-chess-main{display:grid;gap:8px;min-width:0}
.g-chess-side{display:grid;gap:8px;align-content:start;min-width:0}
@container (min-width:640px){.g-chess{grid-template-columns:minmax(0,1fr) 210px;align-items:start}}
.g-chess-bwrap{position:relative;width:100%;max-width:560px;margin:0 auto;touch-action:none}
.g-chess-board{display:grid;grid-template-columns:repeat(8,1fr);grid-template-rows:repeat(8,1fr);aspect-ratio:1;width:100%;
  border-radius:var(--r-sm);overflow:hidden;border:2px solid var(--line);container-type:inline-size;touch-action:none;cursor:pointer}
.g-chess-sq{position:relative;display:flex;align-items:center;justify-content:center;min-width:0;min-height:0}
.g-chess-sq.l{background:#C9C3E6}.g-chess-sq.d{background:#6A6AA8}
.g-chess-sq.last.l{background:#E6D38C}.g-chess-sq.last.d{background:#B39A4E}
.g-chess-sq.sel{box-shadow:inset 0 0 0 3px var(--gold)}
.g-chess-sq.chk{background:radial-gradient(circle,#FF6275 0%,#FF627599 45%,transparent 75%)!important}
.g-chess-sq.tg::after{content:"";position:absolute;width:30%;height:30%;border-radius:50%;background:rgba(20,18,40,.38)}
.g-chess-sq.tg.cap::after{width:88%;height:88%;background:transparent;border:4px solid rgba(20,18,40,.4);box-sizing:border-box}
.g-chess-pc{font-size:10.4cqw;line-height:1;font-family:"DejaVu Sans","Segoe UI Symbol","Noto Sans Symbols 2",serif;position:relative;z-index:1;pointer-events:none}
.g-chess-pc.w{color:#FFF9EA;-webkit-text-stroke:1.2px #1A1406;paint-order:stroke fill;text-shadow:0 2px 2px rgba(0,0,0,.35)}
.g-chess-pc.b{color:#161428;-webkit-text-stroke:1px #F2EEFF55;text-shadow:0 2px 2px rgba(0,0,0,.25)}
.g-chess-pc.drag{opacity:.25}
.g-chess-co{position:absolute;font:600 9px/1 var(--f-mono);color:rgba(20,18,40,.6);pointer-events:none}
.g-chess-sq.d .g-chess-co{color:rgba(255,255,255,.7)}
.g-chess-co.f{right:3px;bottom:2px}.g-chess-co.r{left:3px;top:3px}
.g-chess-ghost{position:absolute;pointer-events:none;z-index:6;transform:translate(-50%,-55%);line-height:1;font-family:"DejaVu Sans","Segoe UI Symbol",serif}
.g-chess-promo{position:absolute;inset:0;z-index:8;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;
  background:color-mix(in srgb,var(--ink) 80%,transparent);border-radius:var(--r-sm)}
.g-chess-promo .row{display:flex;gap:8px}
.g-chess-promo button{width:58px;height:58px;font-size:40px;line-height:1;border-radius:var(--r-md);background:var(--panel-2);border:1px solid var(--gold);
  display:flex;align-items:center;justify-content:center;padding:0}
.g-chess-cap{font-family:"DejaVu Sans","Segoe UI Symbol",serif;font-size:15px;letter-spacing:-1px;color:var(--fg)}
.g-chess-moves{margin:0;padding:8px 10px;background:var(--panel);border:1px solid var(--line);border-radius:var(--r-md);
  font:13px/1.6 var(--f-mono);max-height:300px;overflow:auto;list-style:none;display:grid;grid-template-columns:2.4em 1fr 1fr;column-gap:4px}
.g-chess-moves li{display:contents}
.g-chess-moves .n{color:var(--muted)}
.g-chess-moves .cur{color:var(--gold)}
.g-chess-moves .g-chess-empty{grid-column:1/-1;white-space:nowrap}
@container (max-width:639px){.g-chess-moves{max-height:92px;grid-template-columns:2.4em 1fr 1fr 2.4em 1fr 1fr}}
.g-chess-err{padding:24px;text-align:center}
`);

  /* tc = { base, inc (ms), color: "w"|"b"|"random", rated, label } — defaults are Chess Blitz: 3+2, coin toss */
  function chessGame(ctx, spectate, tc) {
    tc = Object.assign({ base: 180000, inc: 2000, color: "random", rated: true, label: "" }, tc || {});
    const P = "g-chess";
    guardScrollKeys(ctx);
    const players = playersFor(ctx, spectate);
    if (typeof window.Chess !== "function") {
      ctx.root.innerHTML = `<div class="dg-box ${P}-err" data-test="chess-error"><div class="dg-h" style="font-size:28px">Chess is unavailable</div>
        <p class="dg-muted">The chess rules library did not load. No moves can be played. Leave this match; nothing has been played yet.</p></div>`;
      ctx.setStatus("Chess unavailable");
      ctx.test = { state: () => ({ error: "no-chess" }) };
      if (spectate) ctx.timeout(() => ctx.end({ winner: -1, scores: [0, 0] }), 1500);
      return;
    }
    const rng = ctx.rng;
    const g = new window.Chess();
    const toss = rng();
    const goldColor = spectate || (tc.color !== "w" && tc.color !== "b") ? (toss < 0.5 ? "w" : "b") : tc.color;
    const colorOf = [goldColor, goldColor === "w" ? "b" : "w"];
    const flip = goldColor === "b";
    const INC = tc.inc;
    const LOW = Math.min(20000, tc.base * 0.25); // clock turns red: 20 s, or a quarter of very short controls
    const clocksOn = !spectate;
    let clocksFrozen = false;
    const rem = { w: tc.base, b: tc.base };
    let turnStart = ctx.now();
    let selected = null, targets = [], lastMove = null, over = false, pendingAi = false, promo = null, autoSkill = null, drag = null, result = null;
    const sans = [];
    const seen = new Set([CE.keyOf(g.fen())]);
    const stats = { thinkMs: [], depths: [] };
    const idxOfColor = (c) => (c === colorOf[0] ? 0 : 1);
    const isHuman = (i) => !spectate && i === 0 && autoSkill == null;
    const colorName = (c) => (c === "w" ? "White" : "Black");

    ctx.root.innerHTML = `<div class="${P}-wrap"><div class="${P}">
      <div class="${P}-main">
        ${barHtml(P, "opp", players[1])}
        <div class="${P}-stage"><div class="${P}-bwrap"><div class="${P}-board" data-test="board"></div></div></div>
        ${barHtml(P, "me", players[0])}
        <p class="${P}-note" data-test="note"></p>
      </div>
      <div class="${P}-side">
        <div class="dg-eyebrow">Moves</div>
        <ol class="${P}-moves" data-test="moves"></ol>
      </div></div></div>`;
    const $ = (s) => ctx.root.querySelector(s);
    const boardEl = $("." + P + "-board"), bwrap = $("." + P + "-bwrap"), meBar = $("[data-test=me-bar]"), oppBar = $("[data-test=opp-bar]");
    const noteEl = $("[data-test=note]"), movesEl = $("[data-test=moves]");
    let note = spectate
      ? `<b>${esc(players[0].name)}</b> plays ${colorName(colorOf[0])}. <b>${esc(players[1].name)}</b> plays ${colorName(colorOf[1])}.`
      : `You play <b>${colorName(goldColor)}</b>${tc.label ? ` · ${esc(tc.label)}` : ""}. Tap a piece, then a highlighted square (or drag it).`;

    function clockLeft(c) {
      let v = rem[c];
      if (!over && !clocksFrozen && g.turn() === c) v -= ctx.now() - turnStart;
      return v;
    }
    function captures() {
      const cnt = { w: { p: 0, n: 0, b: 0, r: 0, q: 0, k: 0 }, b: { p: 0, n: 0, b: 0, r: 0, q: 0, k: 0 } };
      for (const row of g.board()) for (const pc of row) if (pc) cnt[pc.color][pc.type]++;
      const mat = { w: 0, b: 0 };
      for (const c of ["w", "b"]) for (const t in PVAL) mat[c] += cnt[c][t] * PVAL[t];
      const took = (c) => { /* pieces captured BY color c */
        const o = c === "w" ? "b" : "w"; let s = "";
        for (const t of ["q", "r", "b", "n", "p"]) { const n = Math.max(0, START_COUNT[t] - cnt[o][t]); s += G(t).repeat(n); }
        return s;
      };
      return { mat, took, cnt };
    }
    function render() {
      if (ctx.signal.ended && !over) return;
      const cap = captures();
      const inCheck = g.in_check();
      const turn = g.turn();
      let kingSq = null;
      let html = "";
      for (let r = 0; r < 8; r++) {
        for (let c = 0; c < 8; c++) {
          const file = flip ? 7 - c : c, rank = flip ? r + 1 : 8 - r;
          const sq = "abcdefgh"[file] + rank;
          const pc = g.get(sq);
          const light = (file + rank) % 2 === 1;
          let cls = light ? "l" : "d";
          if (lastMove && (lastMove.from === sq || lastMove.to === sq)) cls += " last";
          if (selected === sq) cls += " sel";
          if (targets.includes(sq)) cls += " tg" + (pc ? " cap" : "");
          if (inCheck && pc && pc.type === "k" && pc.color === turn) { cls += " chk"; kingSq = sq; }
          let inner = pc ? `<span class="${P}-pc ${pc.color}${drag && drag.moved && drag.sq === sq ? " drag" : ""}">${G(pc.type)}</span>` : "";
          if (r === 7) inner += `<span class="${P}-co f">${"abcdefgh"[file]}</span>`;
          if (c === 0) inner += `<span class="${P}-co r">${rank}</span>`;
          html += `<div class="${P}-sq ${cls}" data-sq="${sq}" data-test="sq-${sq}">${inner}</div>`;
        }
      }
      boardEl.innerHTML = html;
      void kingSq;
      /* bars */
      for (let i = 0; i < 2; i++) {
        const c = colorOf[i], o = colorOf[1 - i];
        const diff = cap.mat[c] - cap.mat[o];
        const sub = `${colorName(c)} <span class="${P}-cap">${cap.took(c)}</span>${diff > 0 ? ` <b class="dg-mono">+${diff}</b>` : ""}`
          + (!over && pendingAi && turn === c ? " · thinking…" : "");
        const left = clockLeft(c);
        setBar(i === 0 ? meBar : oppBar, P, { on: !over && turn === c, sub, clock: clocksOn ? fmtClock(left) : "", low: clocksOn && left < LOW });
      }
      /* move list */
      let ml = "";
      for (let i = 0; i < sans.length; i += 2) {
        ml += `<li><span class="n">${i / 2 + 1}.</span><span class="${i === sans.length - 1 ? "cur" : ""}">${esc(sans[i])}</span><span class="${i + 1 === sans.length - 1 ? "cur" : ""}">${esc(sans[i + 1] || "")}</span></li>`;
      }
      movesEl.innerHTML = ml || `<li><span class="dg-muted ${P}-empty">No moves yet</span></li>`;
      movesEl.scrollTop = movesEl.scrollHeight;
      noteEl.innerHTML = note;
      /* promotion picker */
      const old = bwrap.querySelector("." + P + "-promo"); if (old) old.remove();
      if (promo) {
        const el = DG.util.el(`<div class="${P}-promo" data-test="promo"><div class="dg-eyebrow">Promote to</div><div class="row">${["q", "r", "b", "n"].map((t) =>
          `<button type="button" data-test="promo-${t}" data-p="${t}" aria-label="${{ q: "Queen", r: "Rook", b: "Bishop", n: "Knight" }[t]}"><span class="${P}-pc ${colorOf[0]}" style="font-size:40px">${G(t)}</span></button>`).join("")}</div>
          <button type="button" class="dg-btn" data-test="promo-cancel" style="width:auto;height:auto;font-size:13px">Cancel</button></div>`);
        el.addEventListener("pointerdown", (e) => e.stopPropagation());
        el.querySelectorAll("[data-p]").forEach((btn) => btn.addEventListener("click", () => {
          if (!promo || ctx.signal.ended) return;
          const m = { from: promo.from, to: promo.to, promotion: btn.dataset.p }; promo = null; humanMove(m);
        }));
        el.querySelector("[data-test=promo-cancel]").addEventListener("click", () => { promo = null; selected = null; targets = []; render(); });
        bwrap.appendChild(el);
      }
      const ob = bwrap.querySelector("." + P + "-banner"); if (ob) ob.remove();
      if (over && result) bwrap.insertAdjacentHTML("beforeend", banner(P, result.title, result.sub, result.cls));
      status();
    }
    function status() {
      if (ctx.signal.ended) return;
      if (over) { ctx.setStatus(result ? result.title : "Game over"); return; }
      const turn = g.turn(), i = idxOfColor(turn);
      if (spectate) { ctx.setStatus(`${players[i].name} to move · move ${Math.floor(sans.length / 2) + 1}`); return; }
      const mine = fmtClock(clockLeft(colorOf[0])), theirs = fmtClock(clockLeft(colorOf[1]));
      ctx.setStatus(`${i === 0 ? "Your move" : players[1].name + " to move"} · You ${mine} | ${theirs}`);
    }

    function insufficientToMate(color) {
      let minors = 0;
      for (const row of g.board()) for (const pc of row) {
        if (!pc || pc.color !== color || pc.type === "k") continue;
        if (pc.type === "n" || pc.type === "b") minors++; else return false;
      }
      return minors <= 1;
    }
    function finish(winnerIdx, reason) {
      if (over) return;
      over = true; pendingAi = false; promo = null; selected = null; targets = [];
      if (drag) { removeGhost(); drag = null; }
      const moves = Math.ceil(sans.length / 2);
      let title, cls;
      if (winnerIdx === -1) { title = "Draw"; cls = ""; }
      else if (spectate) { title = players[winnerIdx].name + " wins"; cls = winnerIdx === 0 ? "dg-gold" : "dg-rival"; }
      else { title = winnerIdx === 0 ? "You win" : "You lose"; cls = winnerIdx === 0 ? "dg-gold" : "dg-rival"; }
      result = { title, sub: reason + " · " + moves + " moves", cls, winnerIdx };
      note = `<b>${esc(title)}</b>: ${esc(reason)}.`;
      render();
      const scores = winnerIdx === -1 ? [0.5, 0.5] : winnerIdx === 0 ? [1, 0] : [0, 1];
      ctx.timeout(() => {
        if (spectate) ctx.end({ winner: winnerIdx, scores });
        else ctx.end({
          outcome: winnerIdx === 0 ? "win" : winnerIdx === 1 ? "loss" : "draw", myScore: scores[0], oppScore: scores[1],
          detail: `<p class="dg-note">${esc(reason)} after ${moves} moves. You played ${colorName(colorOf[0])}${tc.label ? ` · ${esc(tc.label)}` : ""}.</p>`,
        });
      }, 1100);
    }
    function checkEnd() {
      if (g.in_checkmate()) { const winner = g.turn() === "w" ? "b" : "w"; finish(idxOfColor(winner), "Checkmate"); return true; }
      if (g.in_stalemate()) { finish(-1, "Stalemate"); return true; }
      if (g.insufficient_material()) { finish(-1, "Insufficient material"); return true; }
      if (g.in_threefold_repetition()) { finish(-1, "Threefold repetition"); return true; }
      if (g.in_draw()) { finish(-1, "50-move rule"); return true; }
      if (spectate && sans.length >= 120) {
        const cap = captures();
        const d = cap.mat[colorOf[0]] - cap.mat[colorOf[1]];
        finish(d >= 3 ? 0 : d <= -3 ? 1 : -1, "Adjudicated on material after 120 plies");
        return true;
      }
      return false;
    }
    function flag(c) {
      const other = c === "w" ? "b" : "w";
      if (insufficientToMate(other)) finish(-1, `${colorName(c)} ran out of time, but ${colorName(other)} cannot mate`);
      else finish(idxOfColor(other), `${colorName(c)} ran out of time`);
    }
    function applyMove(m) {
      if (over || ctx.signal.ended) return false;
      const turn = g.turn();
      if (clocksOn && !clocksFrozen) {
        rem[turn] -= ctx.now() - turnStart;
        if (rem[turn] <= 0) { rem[turn] = 0; flag(turn); return false; }
      }
      const res = g.move(m);
      if (!res) return false;
      if (clocksOn && !clocksFrozen) rem[turn] += INC;
      sans.push(res.san);
      lastMove = { from: res.from, to: res.to };
      selected = null; targets = []; promo = null;
      seen.add(CE.keyOf(g.fen()));
      turnStart = ctx.now();
      if (!spectate && sans.length <= 2 && note.startsWith("You play")) note = `You play <b>${colorName(goldColor)}</b>${tc.label ? ` · ${esc(tc.label)}` : ""}.`;
      if (!checkEnd()) next();
      return true;
    }
    function aiSkill(i) { return i === 0 ? (spectate ? players[0].skill : autoSkill) : players[1].skill; }
    function next() {
      if (over || ctx.signal.ended) return;
      const i = idxOfColor(g.turn());
      if (isHuman(i)) { render(); return; }
      pendingAi = true;
      render();
      const lowTime = clocksOn && !clocksFrozen && clockLeft(g.turn()) < 15000;
      const delay = spectate ? 600 + rng() * 300 : lowTime ? 120 : 300 + rng() * 500;
      ctx.timeout(() => {
        pendingAi = false;
        if (over) return;
        const skill = aiSkill(i);
        if (skill == null) { render(); return; } /* autoplay switched off meanwhile */
        const budget = clamp(30 + skill * 110, 25, 140);
        const r = CE.think(g.fen(), { skill, rng, budget, seen });
        if (!r) return;
        stats.thinkMs.push(r.ms); stats.depths.push(r.depth);
        applyMove(CE.toObj(r.move));
      }, delay);
    }
    function humanMove(m) {
      if (over || ctx.signal.ended || !isHuman(idxOfColor(g.turn()))) return false;
      return applyMove(m);
    }
    function canHumanAct() { return !over && !ctx.signal.ended && !promo && isHuman(idxOfColor(g.turn())); }
    function selectSq(sq) {
      selected = sq;
      targets = g.moves({ square: sq, verbose: true }).map((m) => m.to);
    }
    function tryMove(from, to) {
      const ms = g.moves({ square: from, verbose: true }).filter((m) => m.to === to);
      if (!ms.length) return false;
      if (ms.some((m) => m.promotion)) { promo = { from, to }; render(); return true; }
      return humanMove({ from, to });
    }
    function sqFromPoint(x, y) {
      const r = boardEl.getBoundingClientRect();
      if (x < r.left || y < r.top || x >= r.right || y >= r.bottom) return null;
      const c = Math.floor(((x - r.left) / r.width) * 8), rr = Math.floor(((y - r.top) / r.height) * 8);
      const file = flip ? 7 - c : c, rank = flip ? rr + 1 : 8 - rr;
      if (file < 0 || file > 7 || rank < 1 || rank > 8) return null;
      return "abcdefgh"[file] + rank;
    }
    function removeGhost() { const gh = bwrap.querySelector("." + P + "-ghost"); if (gh) gh.remove(); }
    function placeGhost(x, y) {
      let gh = bwrap.querySelector("." + P + "-ghost");
      const br = boardEl.getBoundingClientRect(), wr = bwrap.getBoundingClientRect();
      if (!gh) {
        const pc = g.get(drag.sq);
        gh = DG.util.el(`<span class="${P}-ghost ${P}-pc ${pc.color}" style="font-size:${(br.width / 8) * 0.95}px">${G(pc.type)}</span>`);
        bwrap.appendChild(gh);
      }
      gh.style.left = x - wr.left + "px"; gh.style.top = y - wr.top + "px";
    }
    if (!spectate) {
      boardEl.addEventListener("pointerdown", (e) => {
        if (!canHumanAct()) return;
        const sq = sqFromPoint(e.clientX, e.clientY);
        if (!sq) return;
        e.preventDefault();
        if (selected && targets.includes(sq)) { tryMove(selected, sq); return; }
        const pc = g.get(sq);
        if (pc && pc.color === colorOf[0]) {
          if (selected === sq) { drag = { sq, x: e.clientX, y: e.clientY, moved: false, wasSel: true, id: e.pointerId }; }
          else { selectSq(sq); drag = { sq, x: e.clientX, y: e.clientY, moved: false, wasSel: false, id: e.pointerId }; render(); }
          try { boardEl.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
        } else { selected = null; targets = []; render(); }
      });
      boardEl.addEventListener("pointermove", (e) => {
        if (!drag || e.pointerId !== drag.id || ctx.signal.ended) return;
        if (!drag.moved && Math.hypot(e.clientX - drag.x, e.clientY - drag.y) > 6) { drag.moved = true; render(); }
        if (drag.moved) placeGhost(e.clientX, e.clientY);
      });
      const endDrag = (e, cancel) => {
        if (!drag || e.pointerId !== drag.id) return;
        const d = drag; drag = null; removeGhost();
        if (ctx.signal.ended || over) return;
        const to = cancel ? null : sqFromPoint(e.clientX, e.clientY);
        if (d.moved) {
          if (to && to !== d.sq && targets.includes(to) && canHumanAct()) { tryMove(d.sq, to); return; }
          render();
        } else if (d.wasSel && to === d.sq) { selected = null; targets = []; render(); }
      };
      boardEl.addEventListener("pointerup", (e) => endDrag(e, false));
      boardEl.addEventListener("pointercancel", (e) => endDrag(e, true));
      ctx.onKey((e) => { if (e.key === "Escape" && (selected || promo)) { selected = null; targets = []; promo = null; render(); } });
    }

    ctx.interval(() => {
      if (over) return;
      if (clocksOn && !clocksFrozen) {
        const t = g.turn();
        if (clockLeft(t) <= 0) { rem[t] = 0; flag(t); return; }
        for (let i = 0; i < 2; i++) {
          const c = colorOf[i], left = clockLeft(c);
          setBar(i === 0 ? meBar : oppBar, P, { clock: fmtClock(left), low: left < LOW });
        }
      }
      status();
    }, 200);

    ctx.test = {
      state: () => ({ fen: g.fen(), turn: g.turn(), human: colorOf[0], over, sans: sans.slice(), clocks: { w: clockLeft("w"), b: clockLeft("b") }, result }),
      legalMoves: () => (isHuman(idxOfColor(g.turn())) && !over ? g.moves({ verbose: true }) : []),
      playMove: (m) => humanMove(m),
      autoplay: (skill) => { autoSkill = skill == null ? 0.5 : skill; if (!over && !pendingAi && idxOfColor(g.turn()) === 0) next(); },
      freezeClocks: () => { if (!clocksFrozen) { rem[g.turn()] -= ctx.now() - turnStart; clocksFrozen = true; } },
      setClock: (color, ms) => { rem[color] = ms; turnStart = ctx.now(); },
      stats: () => stats,
      /* test-only: jump to a position (e.g. to exercise promotion / castling / en passant through the UI) */
      loadFen: (fen) => {
        if (over || !g.load(fen)) return false;
        sans.length = 0; lastMove = null; selected = null; targets = []; promo = null;
        seen.clear(); seen.add(CE.keyOf(g.fen())); turnStart = ctx.now();
        next(); render();
        return true;
      },
    };
    next();
  }

  /* Headless chess game for tests: engine vs engine through chess.js (no DOM). */
  function chessSimulate(o) {
    const g = new window.Chess(o.fen || undefined);
    const rng = U.rng(o.seed || 1);
    const seen = new Set([CE.keyOf(g.fen())]);
    const flags = {};
    const times = [];
    let plies = 0;
    const maxPlies = o.maxPlies || 400;
    while (!g.game_over() && plies < maxPlies) {
      const skill = g.turn() === "w" ? o.white : o.black;
      const r = CE.think(g.fen(), { skill, rng, budget: o.budget || clamp(30 + skill * 110, 25, 140), seen });
      times.push(r.ms);
      const res = g.move(CE.toObj(r.move));
      if (!res) return { error: "illegal engine move " + JSON.stringify(CE.toObj(r.move)) + " in " + g.fen() };
      for (const f of res.flags) flags[f] = (flags[f] || 0) + 1;
      seen.add(CE.keyOf(g.fen()));
      plies++;
    }
    let winner = "draw", reason = "ply cap";
    if (g.in_checkmate()) { winner = g.turn() === "w" ? "b" : "w"; reason = "checkmate"; }
    else if (g.in_stalemate()) reason = "stalemate";
    else if (g.insufficient_material()) reason = "insufficient";
    else if (g.in_threefold_repetition()) reason = "threefold";
    else if (g.in_draw()) reason = "50-move";
    return { winner, reason, plies, flags, maxMs: Math.max(0, ...times), avgMs: times.reduce((a, c) => a + c, 0) / Math.max(1, times.length), fen: g.fen() };
  }

  const chessDef = DG.registerGame({
    id: "chess", name: "Chess Blitz", category: "strategy", kind: "versus", formats: ["1v1", "tournament"],
    skill: 10, luck: 1, cashEligible: true, duration: "6 min", pack: PACK, scoreLabel: "points",
    blurb: "Three-minute blitz with a 2-second increment. Checkmate or out-time your rival.",
    rules: [
      "Standard chess rules, including castling, en passant and promotion.",
      "A coin toss decides who plays White. White moves first.",
      "Each side has 3 minutes plus 2 seconds per move. Run out of time and you lose, unless your rival cannot mate.",
      "Stalemate, threefold repetition, the 50-move rule and insufficient material are draws.",
      "Tap a piece, then a highlighted square. You can also drag.",
    ],
    play(ctx) { chessGame(ctx, false); },
    spectate(ctx) { chessGame(ctx, true); },
  });
  chessDef._engine = { think: CE.think, perft: CE.perft, simulate: chessSimulate, toObj: CE.toObj };

  /* ---------------- Chess (your settings): the game-setup section shown in Duel setup ----------------
     Time control (Bullet / Blitz / Rapid presets, more presets, or custom minutes + increment), which colour you play,
     rated or unrated, and how far your opponent's rating may be from yours. The platform renders html(), calls bind(),
     keeps the values per game, and hands them to play() as ctx.options. */
  const TC_CLASSES = [
    { id: "bullet", name: "Bullet", main: [[60, 0], [60, 1], [120, 1]], more: [[30, 0], [20, 1], [120, 0]] },
    { id: "blitz", name: "Blitz", main: [[180, 0], [180, 2], [300, 0]], more: [[180, 1], [300, 2], [300, 5]] },
    { id: "rapid", name: "Rapid", main: [[600, 0], [900, 10], [1800, 0]], more: [[600, 5], [1200, 0], [3600, 0]] },
  ];
  const TC_MINUTES = [0.5, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 15, 20, 25, 30, 45, 60, 90, 120, 180];
  const TC_INCS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 10, 12, 15, 20, 25, 30, 45, 60];
  const TC_PRESETS = TC_CLASSES.flatMap((c) => c.main.concat(c.more));
  const CS_RANGES = [50, 100, 200, 400, 0]; // 0 = any rating
  const CS_ANY = 800;
  const CS_COLORS = ["white", "random", "black"];
  const CS_KEY = "dg.chess.setup";
  const CS_ICON = {
    bullet: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.2 12.8l-.9-.9 7.4-7.4a2.6 2.6 0 0 1 3.7 3.7l-7.4 7.4-.9-.9z"/><path d="M2 14l2.2-2.2" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>',
    blitz: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M9.6 1L3.4 9.2h4.1L6.4 15l6.2-8.3H8.5z"/></svg>',
    rapid: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3.6a5.6 5.6 0 1 0 0 11.2A5.6 5.6 0 0 0 8 3.6zm.7 5.9H7.3V6h1.4zM6 1h4v1.5H6z"/></svg>',
  };
  const tcClass = (base, inc) => { const est = base + 40 * inc; return est < 180 ? "bullet" : est < 600 ? "blitz" : "rapid"; };
  const tcClassName = (base, inc) => TC_CLASSES.find((c) => c.id === tcClass(base, inc)).name;
  function tcLabel(base, inc) {
    const b = base < 60 ? base + " sec" : String(base / 60);
    return inc ? b + " | " + inc : base < 60 ? b : b + " min";
  }
  const csDefaults = () => ({ base: 600, inc: 0, custom: false, more: false, color: "random", rated: true, range: 200 });
  function csValid(v) {
    if (!v || typeof v !== "object") return false;
    const preset = TC_PRESETS.some(([b, i]) => b === v.base && i === v.inc);
    const custom = TC_MINUTES.includes(v.base / 60) && TC_INCS.includes(v.inc);
    return (preset || custom) && CS_COLORS.includes(v.color) && typeof v.rated === "boolean" && CS_RANGES.includes(v.range);
  }
  function csClean(raw) {
    const d = csDefaults();
    if (!raw || typeof raw !== "object") return d;
    const v = { base: Number(raw.base), inc: Number(raw.inc), custom: raw.custom === true, more: raw.more === true,
      color: String(raw.color), rated: raw.rated !== false, range: Number(raw.range) };
    return csValid(v) ? v : d;
  }
  const csSummary = (v) => tcLabel(v.base, v.inc) + " " + tcClassName(v.base, v.inc) + (v.rated ? "" : " · Unrated") +
    (v.color === "random" ? "" : " · as " + (v.color === "white" ? "White" : "Black"));
  const CHESS_SETUP = {
    defaults: csDefaults,
    load() { try { const s = localStorage.getItem(CS_KEY); return s ? csClean(JSON.parse(s)) : null; } catch (e) { return null; } },
    save(v) { try { localStorage.setItem(CS_KEY, JSON.stringify(v)); } catch (e) { /* storage blocked: keep for this session */ } },
    validate: (v) => (csValid(v) ? "" : "Pick a time control."),
    summary: csSummary,
    rated: (v) => v.rated !== false,
    ratingRange: (v) => (v.range > 0 ? v.range : CS_ANY),
    html(v, o) {
      DG.css("chess-setup", `
.cs-sec{display:grid;gap:6px}
.dn-gset{container-type:inline-size}
.cs-sec+.cs-sec{margin-top:12px}
.cs-tc{display:grid;gap:6px}
.cs-row{display:grid;grid-template-columns:78px minmax(0,1fr);gap:8px;align-items:center}
.cs-cls{display:flex;align-items:center;gap:6px;font-size:13px;font-weight:600;color:var(--muted);white-space:nowrap}
.cs-cls svg{width:15px;height:15px;flex:none;fill:currentColor}
.cs-cls.bullet svg{color:#F5C94A}.cs-cls.blitz svg{color:#FFB35C}.cs-cls.rapid svg{color:#5AD690}
.cs-row .chips .dg-chip,.cs-sec>.chips .dg-chip{min-width:58px;justify-content:center}
.cs-custom{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}
.cs-custom label{display:grid;gap:4px;font-size:12px;color:var(--muted)}
.cs-k{font-family:"DejaVu Sans","Segoe UI Symbol","Noto Sans Symbols 2",serif;font-size:17px;line-height:1;margin-right:5px}
.cs-k.w{color:#FFF9EA;-webkit-text-stroke:.8px #1A1406;paint-order:stroke fill}.cs-k.b{color:#161428;-webkit-text-stroke:.8px #F2EEFF88;paint-order:stroke fill}
.cs-k.r{background:linear-gradient(90deg,#FFF9EA 50%,#161428 50%);-webkit-background-clip:text;background-clip:text;color:transparent;-webkit-text-stroke:.8px #888}
.cs-hint{margin:0;font-size:12px;color:var(--muted)}
/* narrow panels: class name above its chips (after .cs-row so it wins) */
@container (max-width:460px){.cs-row{grid-template-columns:minmax(0,1fr);gap:4px}.cs-row .chips .dg-chip,.cs-sec>.chips .dg-chip{min-width:0}}
`);
      const px = o.px, esc = o.esc, cur = tcClass(v.base, v.inc);
      const chip = (attr, val, label, pressed, extra) => `<button type="button" class="dg-chip" ${attr}="${esc(val)}" aria-pressed="${pressed}"${extra || ""}>${label}</button>`;
      const tcChip = ([b, i]) => chip("data-cs-tc", b + "+" + i, esc(tcLabel(b, i)), !v.custom && v.base === b && v.inc === i, ` data-test="cs-tc-${b}-${i}"`);
      const rows = TC_CLASSES.map((c) => `<div class="cs-row"><span class="cs-cls ${c.id}">${CS_ICON[c.id]}${c.name}</span>` +
        `<div class="chips" role="group" aria-label="${c.name} time controls">${c.main.concat(v.more ? c.more : []).map(tcChip).join("")}</div></div>`).join("");
      const opt = (list, sel, fmt) => list.map((x) => `<option value="${x}"${x === sel ? " selected" : ""}>${fmt(x)}</option>`).join("");
      const custom = v.custom ? `<div class="cs-custom" data-test="cs-custom">
          <label for="${px}CsMin">Minutes per side<select class="inp" id="${px}CsMin" data-cs-min>${opt(TC_MINUTES, v.base / 60, (m) => (m < 1 ? m * 60 + " sec" : m + " min"))}</select></label>
          <label for="${px}CsInc">Increment per move<select class="inp" id="${px}CsInc" data-cs-inc>${opt(TC_INCS, v.inc, (s) => s + " sec")}</select></label></div>` : "";
      const kings = { white: '<span class="cs-k w">♚︎</span>White', random: '<span class="cs-k r">♚︎</span>Random', black: '<span class="cs-k b">♚︎</span>Black' };
      const lo = Math.max(100, o.rating - v.range), hi = o.rating + v.range;
      return `<div class="cs-sec"><span class="dg-eyebrow" id="${px}CsTcL">Time control <b class="dn-pick" data-test="cs-summary">${esc(tcLabel(v.base, v.inc))} · ${esc(tcClassName(v.base, v.inc))}</b></span>
          <div class="cs-tc" aria-labelledby="${px}CsTcL">${rows}</div>
          <div class="chips">${chip("data-cs", "more", v.more ? "Fewer time controls" : "More time controls", v.more, ' data-test="cs-more"')}${chip("data-cs", "custom", "Custom", v.custom, ' data-test="cs-custom-btn"')}</div>${custom}
          ${v.custom ? `<p class="cs-hint">Counts as ${esc(TC_CLASSES.find((c) => c.id === cur).name)}: starting time + 40 × increment${cur === "rapid" ? " is 10 minutes or more" : cur === "blitz" ? " is under 10 minutes" : " is under 3 minutes"}.</p>` : ""}</div>
        <div class="cs-sec"><span class="dg-eyebrow" id="${px}CsColL">I play as</span>
          <div class="chips" role="group" aria-labelledby="${px}CsColL">${CS_COLORS.map((c) => chip("data-cs-color", c, kings[c], v.color === c, ` data-test="cs-color-${c}"`)).join("")}</div></div>
        <div class="cs-sec"><span class="dg-eyebrow" id="${px}CsRatL">Game type</span>
          <div class="chips" role="group" aria-labelledby="${px}CsRatL">${chip("data-cs-rated", "1", "Rated", v.rated, ' data-test="cs-rated"')}${chip("data-cs-rated", "0", "Unrated", !v.rated, ' data-test="cs-unrated"')}</div>
          <p class="cs-hint">${v.rated ? "Your Chess rating goes up or down with the result." : "Your rating stays the same whatever happens. Stakes still apply."}</p></div>
        <div class="cs-sec"><span class="dg-eyebrow" id="${px}CsRngL">Opponent rating <b class="dn-pick" data-test="cs-range">${v.range ? lo + " – " + hi : "Any rating"}</b></span>
          <div class="chips" role="group" aria-labelledby="${px}CsRngL">${CS_RANGES.map((r) => chip("data-cs-range", r, r ? "± " + r : "Any", v.range === r, ` data-test="cs-range-${r || "any"}"`)).join("")}</div></div>`;
    },
    bind(root, v, o) {
      const on = (sel, fn) => root.querySelectorAll(sel).forEach((el) => fn(el));
      on("[data-cs-tc]", (b) => (b.onclick = () => { const [bb, ii] = b.dataset.csTc.split("+").map(Number); v.base = bb; v.inc = ii; v.custom = false; o.change(); }));
      on('[data-cs="more"]', (b) => (b.onclick = () => { v.more = !v.more; o.change(); }));
      on('[data-cs="custom"]', (b) => (b.onclick = () => {
        v.custom = !v.custom;
        if (v.custom && !TC_MINUTES.includes(v.base / 60)) v.base = 600;
        if (v.custom && !TC_INCS.includes(v.inc)) v.inc = 0;
        o.change();
      }));
      on("[data-cs-min]", (s) => (s.onchange = () => { v.base = Math.round(Number(s.value) * 60); o.change(); }));
      on("[data-cs-inc]", (s) => (s.onchange = () => { v.inc = Number(s.value); o.change(); }));
      on("[data-cs-color]", (b) => (b.onclick = () => { v.color = b.dataset.csColor; o.change(); }));
      on("[data-cs-rated]", (b) => (b.onclick = () => { v.rated = b.dataset.csRated === "1"; o.change(); }));
      on("[data-cs-range]", (b) => (b.onclick = () => { v.range = Number(b.dataset.csRange); o.change(); }));
    },
  };
  /* ctx.options (from the setup above) → chessGame's time-control config; anything invalid falls back to the defaults */
  function tcFrom(opts) {
    const v = csClean(opts);
    return { base: v.base * 1000, inc: v.inc * 1000, color: v.color === "white" ? "w" : v.color === "black" ? "b" : "random", rated: v.rated,
      label: tcLabel(v.base, v.inc) + " " + tcClassName(v.base, v.inc) + (v.rated ? " · Rated" : " · Unrated") };
  }
  const chessCustomDef = DG.registerGame({
    id: "chess-custom", name: "Chess", category: "strategy", kind: "versus", formats: ["1v1", "tournament"],
    skill: 10, luck: 1, cashEligible: true, duration: "Your choice (30 s to 3 h per side)", pack: PACK, scoreLabel: "points",
    blurb: "Set up the game your way: Bullet, Blitz, Rapid or a custom clock, your colour, rated or unrated.",
    rules: [
      "Standard chess rules, including castling, en passant and promotion.",
      "Before you duel, pick a time control (Bullet, Blitz, Rapid or Custom), the colour you play, rated or unrated, and how far your opponent's rating may be from yours.",
      "Each side starts with the chosen time and gains the increment after every move. Run out of time and you lose, unless your rival cannot mate.",
      "Unrated games never change your rating. Stakes still apply.",
      "Stalemate, threefold repetition, the 50-move rule and insufficient material are draws.",
      "Tap a piece, then a highlighted square. You can also drag.",
    ],
    setup: CHESS_SETUP,
    play(ctx) { chessGame(ctx, false, tcFrom(ctx.options)); },
    spectate(ctx) { chessGame(ctx, true, tcFrom(null)); },
  });
  if (chessCustomDef) chessCustomDef._setup = { tcFrom, tcLabel, tcClass, csValid, TC_CLASSES };

  /* =====================================================================
     GENERIC TURN CONTROLLER for four / reversi / gomoku.
     D = { id, moveMs, init(rng), legal(st), apply(st,m)->info, result(st)->null|{winner,scores,reason},
           ai(st,skill,rng,budget)->{move,depth,ms}, randomMove(st,rng), barScore(st,i), view(stage, api),
           snapshot(st), sideName(i) }
     st.turn is the player index to move (0 = gold / players[0], 1 = rival / players[1]).
     ===================================================================== */
  /* Arrow keys and Space must never scroll the page/overlay while a board is on screen.
     Form fields keep their keys; Space on a focused button still activates it (it does not scroll). */
  function guardScrollKeys(ctx) {
    ctx.onKey((e) => {
      const k = e.key;
      const arrow = k === "ArrowUp" || k === "ArrowDown" || k === "ArrowLeft" || k === "ArrowRight";
      if (!arrow && k !== " " && k !== "Spacebar" && k !== "PageUp" && k !== "PageDown") return;
      const t = e.target;
      if (t && t.closest && t.closest("input,textarea,select,[contenteditable=''],[contenteditable='true']")) return;
      const space = k === " " || k === "Spacebar";
      if (space && t && t.closest && t.closest("button,a[href],[role=button]")) return;
      e.preventDefault();
    });
  }
  function turnGame(ctx, spectate, D) {
    guardScrollKeys(ctx);
    const P = "g-" + D.id;
    const players = playersFor(ctx, spectate);
    const rng = ctx.rng;
    const st = D.init(rng);
    let over = false, pendingAi = false, autoSkill = null, result = null, turnT0 = ctx.now(), timerFrozen = false;
    const stats = { thinkMs: [], depths: [] };
    const isHuman = (i) => !spectate && i === 0 && autoSkill == null;
    const moveMs = spectate ? 0 : D.moveMs || 0;
    ctx.root.innerHTML = `<div class="${P}">${barHtml(P, "opp", players[1])}<div class="${P}-stage" data-test="stage"></div>${barHtml(P, "me", players[0])}<p class="${P}-note" data-test="note"></p></div>`;
    const $ = (s) => ctx.root.querySelector(s);
    const stage = $("[data-test=stage]"), meBar = $("[data-test=me-bar]"), oppBar = $("[data-test=opp-bar]"), noteEl = $("[data-test=note]");
    let note = "", stickyNote = null;
    const view = D.view(stage, {
      P, spectate, ctx,
      canAct: () => !over && !ctx.signal.ended && isHuman(st.turn),
      pick: (m) => humanMove(m),
    });
    function left() { return moveMs - (ctx.now() - turnT0); }
    function status() {
      if (ctx.signal.ended) return;
      if (over) { ctx.setStatus(result ? result.title : "Game over"); return; }
      let s = spectate ? `${players[st.turn].name} to move` : st.turn === 0 ? "Your move" : `${players[1].name} to move`;
      if (moveMs && isHuman(st.turn) && !timerFrozen) s += " · " + Math.max(0, Math.ceil(left() / 1000)) + "s";
      if (D.statusExtra) s += " · " + D.statusExtra(st);
      ctx.setStatus(s);
    }
    function bars() {
      for (let i = 0; i < 2; i++) {
        const o = { on: !over && st.turn === i, sub: D.sideName(i, players) + (!over && pendingAi && st.turn === i ? " · thinking…" : ""), score: D.barScore(st, i) };
        if (moveMs) {
          const showClock = !over && st.turn === i && isHuman(i) && !timerFrozen;
          o.clock = showClock ? Math.max(0, Math.ceil(left() / 1000)) + "s" : "";
          o.low = showClock && left() < 5000;
        }
        setBar(i === 0 ? meBar : oppBar, P, o);
      }
    }
    function render(info) {
      view.render(st, info || null, { over, result });
      bars();
      noteEl.innerHTML = note;
      const ob = stage.querySelector("." + P + "-banner"); if (ob) ob.remove();
      if (over && result) stage.insertAdjacentHTML("beforeend", banner(P, result.title, result.sub, result.cls));
      status();
    }
    function finish(r) {
      over = true; pendingAi = false;
      const w = r.winner;
      let title, cls = w === 0 ? "dg-gold" : w === 1 ? "dg-rival" : "";
      if (w === -1) title = "Draw";
      else if (spectate) title = players[w].name + " wins";
      else title = w === 0 ? "You win" : "You lose";
      result = { title, sub: r.reason, cls, winner: w, scores: r.scores };
      note = `<b>${esc(title)}</b>: ${esc(r.reason)}.`;
    }
    function after(info) {
      const r = D.result(st);
      if (r) finish(r);
      else if (info && info.note) note = info.note;
      else if (stickyNote) note = stickyNote;
      else if (info && info.pass != null) note = `${spectate ? "<b>" + esc(players[info.pass].name) + "</b> has" : info.pass === 0 ? "<b>You</b> have" : "<b>" + esc(players[1].name) + "</b> has"} no legal move and must pass.`;
      else note = D.hint ? D.hint(st, spectate, players) : "";
      turnT0 = ctx.now();
      render(info);
      if (over) {
        ctx.timeout(() => {
          const sc = result.scores;
          if (spectate) ctx.end({ winner: result.winner, scores: sc });
          else ctx.end({
            outcome: result.winner === 0 ? "win" : result.winner === 1 ? "loss" : "draw", myScore: sc[0], oppScore: sc[1],
            detail: `<p class="dg-note">${esc(result.sub)}.</p>`,
          });
        }, 1200);
        return;
      }
      next();
    }
    function doMove(m) {
      if (over || ctx.signal.ended) return false;
      const info = D.apply(st, m);
      if (!info) return false;
      after(info);
      return true;
    }
    function humanMove(m) {
      if (over || ctx.signal.ended || !isHuman(st.turn)) return false;
      if (!D.isLegal(st, m)) return false;
      stickyNote = null;
      return doMove(m);
    }
    function aiSkill(i) { return i === 0 ? (spectate ? players[0].skill : autoSkill) : players[1].skill; }
    function next() {
      if (over || ctx.signal.ended) return;
      const i = st.turn;
      if (isHuman(i)) return;
      pendingAi = true; bars();
      const delay = spectate ? 600 + rng() * 300 : 300 + rng() * 500;
      ctx.timeout(() => {
        pendingAi = false;
        if (over || st.turn !== i) return;
        const skill = aiSkill(i);
        if (skill == null) { bars(); status(); return; }
        const r = D.ai(st, skill, rng, clamp(30 + skill * 110, 25, 140));
        stats.thinkMs.push(r.ms); stats.depths.push(r.depth);
        doMove(r.move);
      }, delay);
    }
    ctx.interval(() => {
      if (over) return;
      if (moveMs && isHuman(st.turn) && !timerFrozen && left() <= 0) {
        const m = D.randomMove(st, rng);
        const info = D.apply(st, m);
        info.note = stickyNote = "Time ran out, so a random move was played for you.";
        after(info);
        return;
      }
      bars(); status();
    }, 250);
    ctx.test = {
      state: () => Object.assign(D.snapshot(st), { turn: st.turn, over, result }),
      legalMoves: () => (isHuman(st.turn) && !over ? D.legal(st) : []),
      playMove: (m) => humanMove(m),
      autoplay: (skill) => { autoSkill = skill == null ? 0.5 : skill; if (!over && !pendingAi && st.turn === 0) next(); },
      freezeTimer: () => { timerFrozen = true; },
      stats: () => stats,
    };
    note = D.hint ? D.hint(st, spectate, players, true) : "";
    render(null);
    next();
  }
  /* Headless game (no DOM) through the same rules code, for tests: returns {winner, scores, moves, maxMs}. */
  function turnSim(D, seed, s0, s1) {
    const rng = U.rng(seed);
    const st = D.init(rng);
    let maxMs = 0, n = 0, r = null;
    while (!(r = D.result(st))) {
      if (++n > 400) return { error: "no end after 400 moves" };
      const sk = st.turn === 0 ? s0 : s1;
      const a = D.ai(st, sk, rng, clamp(30 + sk * 110, 25, 140));
      maxMs = Math.max(maxMs, a.ms);
      if (!D.isLegal(st, a.move)) return { error: "illegal AI move " + a.move };
      D.apply(st, a.move);
    }
    return { winner: r.winner, scores: r.scores, reason: r.reason, moves: n, maxMs, first: D.id === "four" ? st.first : undefined };
  }
  /* iterative-deepening helper: search(depth) may throw ABORT once cpuNow() > deadline */
  function deepen(maxDepth, budget, fn) {
    const t0 = cpuNow();
    let best = null, depth = 0;
    for (let d = 1; d <= maxDepth; d++) {
      try { const r = fn(d, t0 + budget); best = r; depth = d; if (r.solved) break; }
      catch (e) { if (e !== ABORT) throw e; break; }
      if (cpuNow() - t0 > budget * 0.55) break; /* next depth would not finish */
    }
    return { best, depth, ms: cpuNow() - t0 };
  }
  /* choose among scored root moves: best, or a noisy near-best depending on skill */
  function skillPick(scored, skill, rng, scale) {
    scored.sort((a, c) => c.s - a.s);
    const top = scored[0];
    if (top.s >= 900000) return top;
    const margin = scale * (1 - skill) * (1 - skill) * 2.2;
    let pick = top, bv = -Infinity;
    for (const c of scored) {
      if (c.s < top.s - margin) break;
      const v = c.s + U.gauss(rng) * margin * 0.5;
      if (v > bv) { bv = v; pick = c; }
    }
    if (rng() < 0.35 * (1 - skill) * (1 - skill)) {
      const pool = scored.filter((c) => c.s > -900000).slice(0, 4);
      if (pool.length) pick = pool[Math.floor(rng() * pool.length)];
    }
    return pick;
  }

  /* =====================================================================
     FOUR IN A ROW (7 x 6)
     ===================================================================== */
  const F_W = 7, F_H = 6;
  const F_LINES = (function () {
    const L = [];
    const dirs = [[1, 0], [0, 1], [1, 1], [1, -1]];
    for (let c = 0; c < F_W; c++) for (let r = 0; r < F_H; r++) for (const [dc, dr] of dirs) {
      const ec = c + dc * 3, er = r + dr * 3;
      if (ec < 0 || ec >= F_W || er < 0 || er >= F_H) continue;
      L.push([0, 1, 2, 3].map((k) => (r + dr * k) * F_W + (c + dc * k)));
    }
    return L;
  })();
  const F_ORDER = [3, 2, 4, 1, 5, 0, 6];
  const fourEngine = {
    winLine(cells, p) {
      for (const L of F_LINES) if (cells[L[0]] === p && cells[L[1]] === p && cells[L[2]] === p && cells[L[3]] === p) return L;
      return null;
    },
    evaluate(cells, p) {
      const o = 3 - p; let s = 0;
      for (const L of F_LINES) {
        let a = 0, b = 0;
        for (let k = 0; k < 4; k++) { const v = cells[L[k]]; if (v === p) a++; else if (v === o) b++; }
        if (a && b) continue;
        if (a === 3) s += 50; else if (a === 2) s += 6; else if (a === 1) s += 1;
        if (b === 3) s -= 60; else if (b === 2) s -= 6; else if (b === 1) s -= 1;
      }
      for (let r = 0; r < F_H; r++) { const v = cells[r * F_W + 3]; if (v === p) s += 4; else if (v === o) s -= 4; }
      return s;
    },
    think(cells0, heights0, p, skill, rng, budget) {
      const cells = Int8Array.from(cells0), h = Int8Array.from(heights0);
      let deadline = 0, nodes = 0;
      const WIN = 1000000;
      const wins = (c, r, q) => {
        const dirs = [[1, 0], [0, 1], [1, 1], [1, -1]];
        for (const [dc, dr] of dirs) {
          let n = 1;
          for (let s = -1; s <= 1; s += 2) { let cc = c + dc * s, rr = r + dr * s; while (cc >= 0 && cc < F_W && rr >= 0 && rr < F_H && cells[rr * F_W + cc] === q) { n++; cc += dc * s; rr += dr * s; } }
          if (n >= 4) return true;
        }
        return false;
      };
      const neg = (depth, alpha, beta, q, ply, empty) => {
        if ((++nodes & 1023) === 0 && cpuNow() > deadline) throw ABORT;
        if (empty === 0) return 0;
        for (const c of F_ORDER) { if (h[c] < F_H) { const r = h[c]; cells[r * F_W + c] = q; const w = wins(c, r, q); cells[r * F_W + c] = 0; if (w) return WIN - ply; } }
        if (depth === 0) return this.evaluate(cells, q);
        let best = -Infinity;
        for (const c of F_ORDER) {
          if (h[c] >= F_H) continue;
          const r = h[c]; cells[r * F_W + c] = q; h[c]++;
          const s = -neg(depth - 1, -beta, -alpha, 3 - q, ply + 1, empty - 1);
          h[c]--; cells[r * F_W + c] = 0;
          if (s > best) best = s;
          if (s > alpha) alpha = s;
          if (alpha >= beta) break;
        }
        return best;
      };
      let empty = 0; for (let i = 0; i < 42; i++) if (!cells[i]) empty++;
      const cols = F_ORDER.filter((c) => h[c] < F_H);
      const maxDepth = clamp(1 + Math.round(skill * 8), 1, 9);
      const res = deepen(maxDepth, budget, (d, dl) => {
        deadline = dl;
        const scored = [];
        let solved = false;
        for (const c of cols) {
          const r = h[c]; cells[r * F_W + c] = p; h[c]++;
          const s = wins(c, r, p) ? WIN : -neg(d - 1, -Infinity, Infinity, 3 - p, 1, empty - 1);
          h[c]--; cells[r * F_W + c] = 0;
          scored.push({ move: c, s });
          if (s >= WIN - 100) solved = true;
        }
        return { scored, solved };
      });
      const scored = res.best ? res.best.scored : cols.map((c) => ({ move: c, s: 0 }));
      const pick = skillPick(scored, skill, rng, 60);
      return { move: pick.move, depth: res.depth, ms: res.ms, nodes };
    },
  };

  DG.css("four", commonCss("g-four") + `
.g-four-stage{padding:4px 0}
.g-four-in{--cell:min(calc((100cqw - 20px) / 7),64px)}
.g-four-board{position:relative;display:grid;grid-template-columns:repeat(7,var(--cell));
  background:linear-gradient(180deg,#2B3170,#232863);border-radius:var(--r-lg);padding:8px;border:2px solid #3A4190;touch-action:manipulation;width:max-content;margin:0 auto}
.g-four-wrap{width:100%;max-width:520px;container-type:inline-size}
.g-four-col{display:grid;grid-template-rows:repeat(6,var(--cell));border-radius:var(--r-md);cursor:pointer;background:none;border:0;padding:0;position:relative}
.g-four-col:disabled{cursor:default}
.g-four-col:not(:disabled):hover,.g-four-col:focus-visible{background:rgba(242,193,78,.1)}
.g-four-cell{display:flex;align-items:center;justify-content:center;overflow:hidden;position:relative}
.g-four-cell::before{content:"";position:absolute;width:80%;height:80%;border-radius:50%;background:var(--ink);box-shadow:inset 0 3px 6px rgba(0,0,0,.6)}
.g-four-disc{position:relative;width:80%;height:80%;border-radius:50%;z-index:1}
.g-four-disc.p1{background:radial-gradient(circle at 35% 30%,#FFE39A,var(--gold) 55%,var(--gold-deep))}
.g-four-disc.p2{background:radial-gradient(circle at 35% 30%,#FFB0BA,var(--rival) 55%,#B83347)}
.g-four-disc.win{box-shadow:0 0 0 3px var(--fg),0 0 14px 3px var(--fg)}
.g-four-disc.drop{animation:g-four-drop var(--t,.4s) cubic-bezier(.5,0,1,1)}
@keyframes g-four-drop{from{transform:translateY(var(--from))}to{transform:translateY(0)}}
.g-four-arrows{display:grid;grid-template-columns:repeat(7,var(--cell));width:max-content;margin:0 auto 4px;padding:0 10px}
.g-four-arrow{height:14px;display:flex;justify-content:center}
.g-four-arrow i{width:0;height:0;border:7px solid transparent;border-top:9px solid var(--gold);opacity:0}
.g-four-arrow.show i{opacity:.9}
`);
  const fourDef = {
    id: "four", moveMs: 15000,
    init(rng) { return { cells: new Int8Array(42), h: new Int8Array(7), turn: rng() < 0.5 ? 0 : 1, last: -1, moves: 0, first: null }; },
    legal: (st) => F_ORDER.filter((c) => st.h[c] < F_H).sort((a, b) => a - b),
    isLegal: (st, m) => Number.isInteger(m) && m >= 0 && m < 7 && st.h[m] < F_H,
    apply(st, c) {
      if (!this.isLegal(st, c)) return null;
      if (st.first === null) st.first = st.turn;
      const r = st.h[c]; st.cells[r * F_W + c] = st.turn + 1; st.h[c]++; st.last = r * F_W + c; st.moves++;
      st.turn ^= 1;
      return { drop: { c, r } };
    },
    result(st) {
      for (let p = 0; p < 2; p++) {
        const L = fourEngine.winLine(st.cells, p + 1);
        if (L) { st.line = L; return { winner: p, scores: p === 0 ? [1, 0] : [0, 1], reason: "Four in a row" }; }
      }
      if (st.moves >= 42) return { winner: -1, scores: [0.5, 0.5], reason: "The board is full" };
      return null;
    },
    ai: (st, skill, rng, budget) => fourEngine.think(st.cells, st.h, st.turn + 1, skill, rng, budget),
    randomMove(st, rng) { const l = this.legal(st); return l[Math.floor(rng() * l.length)]; },
    barScore: () => "",
    sideName: (i) => (i === 0 ? "Gold discs" : "Red discs"),
    snapshot: (st) => ({ cells: Array.from(st.cells), heights: Array.from(st.h), moves: st.moves }),
    hint(st, spectate, players, initial) {
      if (!initial) return spectate ? "" : "Tap a column to drop a disc. First to line up four wins.";
      const firstName = spectate ? players[st.turn].name : st.turn === 0 ? "You" : players[1].name;
      return spectate ? `<b>${esc(firstName)}</b> moves first.` : `${st.turn === 0 ? "<b>You</b> move first" : `<b>${esc(firstName)}</b> moves first`}. Tap a column to drop a disc. 15 s per move.`;
    },
    view(stage, api) {
      const P = api.P;
      stage.innerHTML = `<div class="${P}-wrap"><div class="${P}-in"><div class="${P}-arrows">${Array.from({ length: 7 }, (_, c) => `<div class="${P}-arrow" data-a="${c}"><i></i></div>`).join("")}</div>
        <div class="${P}-board" data-test="board">${Array.from({ length: 7 }, (_, c) => `<button type="button" class="${P}-col" data-test="col-${c}" data-c="${c}" aria-label="Drop in column ${c + 1}">${Array.from({ length: 6 }, (_, k) => `<div class="${P}-cell" data-cell="${(5 - k) * 7 + c}"></div>`).join("")}</button>`).join("")}</div></div></div>`;
      const cols = stage.querySelectorAll("." + P + "-col");
      const arrows = stage.querySelectorAll("." + P + "-arrow");
      let hover = -1;
      cols.forEach((b) => {
        b.addEventListener("click", () => { if (api.canAct()) api.pick(+b.dataset.c); });
        b.addEventListener("pointerenter", (e) => { if (e.pointerType === "mouse") { hover = +b.dataset.c; showArrow(); } });
        b.addEventListener("pointerleave", () => { hover = -1; showArrow(); });
      });
      const showArrow = () => arrows.forEach((a, i) => a.classList.toggle("show", i === hover && api.canAct()));
      if (!api.spectate) api.ctx.onKey((e) => {
        if (!api.canAct()) return;
        const n = +e.key;
        if (n >= 1 && n <= 7) { api.pick(n - 1); return; }
        if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
          hover = hover < 0 ? 3 : clamp(hover + (e.key === "ArrowLeft" ? -1 : 1), 0, 6); showArrow();
        } else if ((e.key === "Enter" || e.key === " ") && hover >= 0 && !(e.target && e.target.closest && e.target.closest("button"))) {
          e.preventDefault(); api.pick(hover);
        }
      });
      return {
        render(st, info, g) {
          const line = g.over && st.line ? new Set(st.line) : null;
          for (let i = 0; i < 42; i++) {
            const cell = stage.querySelector(`[data-cell="${i}"]`), v = st.cells[i];
            const want = v ? `p${v}${line && line.has(i) ? " win" : ""}` : "";
            const disc = cell.firstElementChild;
            if (!v) { if (disc) disc.remove(); continue; }
            if (!disc) {
              const d = document.createElement("div"); d.className = `${P}-disc ${want}`;
              if (info && info.drop && info.drop.r * 7 + info.drop.c === i && !api.ctx.reducedMotion) {
                const rows = 6 - info.drop.r;
                d.style.setProperty("--from", `calc(${-rows} * var(--cell) - 20px)`);
                d.style.setProperty("--t", (0.12 + rows * 0.06) / Math.max(1, Math.min(api.ctx.speed || 1, 3)) + "s");
                d.classList.add("drop");
              }
              cell.appendChild(d);
            } else if (disc.className.replace(/ drop/, "") !== `${P}-disc ${want}`) disc.className = `${P}-disc ${want}`;
          }
          const can = api.canAct();
          cols.forEach((b, c) => { b.disabled = !can || st.h[c] >= 6; });
          showArrow();
        },
      };
    },
  };
  DG.registerGame({
    id: "four", name: "Four in a Row", category: "strategy", kind: "versus", formats: ["1v1", "tournament"],
    skill: 9, luck: 1, cashEligible: true, duration: "3 min", pack: PACK, scoreLabel: "points",
    blurb: "Drop discs into a 7 × 6 grid. First to line up four wins.",
    rules: [
      "Players take turns dropping one disc into any column that is not full.",
      "Line up four of your discs in a row, column or diagonal to win.",
      "A coin toss decides who moves first.",
      "You have 15 seconds per move. If time runs out, a random column is played for you.",
      "If the board fills up with no line of four, it is a draw.",
    ],
    play(ctx) { turnGame(ctx, false, fourDef); },
    spectate(ctx) { turnGame(ctx, true, fourDef); },
  })._engine = Object.assign({ sim: (seed, a, b) => turnSim(fourDef, seed, a, b) }, fourEngine);

  /* =====================================================================
     REVERSI (8 x 8). cells: 0 empty, 1 gold/players[0], 2 red/players[1]
     ===================================================================== */
  const R_DIRS = [-9, -8, -7, -1, 1, 7, 8, 9];
  const R_W = [
    120, -20, 20, 5, 5, 20, -20, 120, -20, -40, -5, -5, -5, -5, -40, -20, 20, -5, 15, 3, 3, 15, -5, 20, 5, -5, 3, 3, 3, 3, -5, 5,
    5, -5, 3, 3, 3, 3, -5, 5, 20, -5, 15, 3, 3, 15, -5, 20, -20, -40, -5, -5, -5, -5, -40, -20, 120, -20, 20, 5, 5, 20, -20, 120];
  const revEngine = {
    flips(cells, i, p) {
      if (cells[i]) return null;
      const o = 3 - p, out = [];
      const x0 = i & 7;
      for (const d of R_DIRS) {
        const dx = d === -9 || d === -1 || d === 7 ? -1 : d === -7 || d === 1 || d === 9 ? 1 : 0;
        let j = i + d, x = x0 + dx, n = 0;
        while (j >= 0 && j < 64 && x >= 0 && x < 8 && cells[j] === o) { j += d; x += dx; n++; }
        if (n && j >= 0 && j < 64 && x >= 0 && x < 8 && cells[j] === p) for (let k = 1; k <= n; k++) out.push(i + d * k);
      }
      return out.length ? out : null;
    },
    moves(cells, p) { const m = []; for (let i = 0; i < 64; i++) if (!cells[i] && this.flips(cells, i, p)) m.push(i); return m; },
    count(cells) { let a = 0, b = 0; for (let i = 0; i < 64; i++) { if (cells[i] === 1) a++; else if (cells[i] === 2) b++; } return [a, b]; },
    evaluate(cells, p) {
      const o = 3 - p; let s = 0, n = 0;
      /* X/C squares are only bad while the corner is empty */
      const w = R_W.slice();
      for (const [c, adj] of [[0, [1, 8, 9]], [7, [6, 15, 14]], [56, [57, 48, 49]], [63, [62, 55, 54]]]) if (cells[c]) for (const a of adj) w[a] = 8;
      for (let i = 0; i < 64; i++) { const v = cells[i]; if (!v) continue; n++; if (v === p) s += w[i]; else s -= w[i]; }
      const mp = this.moves(cells, p).length, mo = this.moves(cells, o).length;
      s += (mp - mo) * (n > 44 ? 4 : 9);
      if (n > 50) { const c = this.count(cells); s += (p === 1 ? c[0] - c[1] : c[1] - c[0]) * 6; }
      return s;
    },
    think(cells0, p, skill, rng, budget) {
      const cells = Int8Array.from(cells0);
      let deadline = 0, nodes = 0;
      const self = this;
      const FINAL = 1000000;
      function neg(depth, alpha, beta, q, passed) {
        if ((++nodes & 511) === 0 && cpuNow() > deadline) throw ABORT;
        const ms = self.moves(cells, q);
        if (!ms.length) {
          if (passed) { const c = self.count(cells); const d = q === 1 ? c[0] - c[1] : c[1] - c[0]; return d > 0 ? FINAL + d : d < 0 ? -FINAL + d : 0; }
          return -neg(depth, -beta, -alpha, 3 - q, true);
        }
        if (depth <= 0) return self.evaluate(cells, q);
        ms.sort((a, b) => R_W[b] - R_W[a]);
        let best = -Infinity;
        for (const m of ms) {
          const f = self.flips(cells, m, q);
          cells[m] = q; for (const k of f) cells[k] = q;
          const s = -neg(depth - 1, -beta, -alpha, 3 - q, false);
          cells[m] = 0; for (const k of f) cells[k] = 3 - q;
          if (s > best) best = s;
          if (s > alpha) alpha = s;
          if (alpha >= beta) break;
        }
        return best;
      }
      const root = this.moves(cells, p);
      if (root.length === 1) return { move: root[0], depth: 0, ms: 0 };
      const maxDepth = clamp(1 + Math.round(skill * skill * 8), 1, 8); /* 0.2:1  0.5:3  0.7:5  0.9:7 */
      const res = deepen(maxDepth, budget, (d, dl) => {
        deadline = dl;
        const scored = [];
        for (const m of root) {
          const f = self.flips(cells, m, p);
          cells[m] = p; for (const k of f) cells[k] = p;
          const s = -neg(d - 1, -Infinity, Infinity, 3 - p, false);
          cells[m] = 0; for (const k of f) cells[k] = 3 - p;
          scored.push({ move: m, s });
        }
        return { scored };
      });
      const scored = res.best ? res.best.scored : root.map((m) => ({ move: m, s: R_W[m] }));
      const pick = skillPick(scored, skill, rng, 45);
      return { move: pick.move, depth: res.depth, ms: res.ms, nodes };
    },
  };
  DG.css("reversi", commonCss("g-reversi") + `
.g-reversi-wrap{width:100%;max-width:520px;margin:0 auto;container-type:inline-size}
.g-reversi-board{display:grid;grid-template-columns:repeat(8,1fr);aspect-ratio:1;width:100%;gap:2px;padding:6px;background:#1B5E44;
  border:2px solid #2C7A5B;border-radius:var(--r-md);touch-action:manipulation}
.g-reversi-sq{position:relative;background:#23805B;border:0;border-radius:3px;padding:0;display:flex;align-items:center;justify-content:center;min-width:0;cursor:default}
.g-reversi-sq.hint{cursor:pointer}
.g-reversi-sq.hint::after{content:"";width:26%;height:26%;border-radius:50%;background:rgba(242,193,78,.55)}
.g-reversi-sq.hint:hover::after{background:var(--gold)}
.g-reversi-sq.last{box-shadow:inset 0 0 0 2px rgba(255,255,255,.55)}
.g-reversi-disc{width:84%;height:84%;border-radius:50%;transition:transform .32s ease}
.g-reversi-disc.p1{background:radial-gradient(circle at 35% 30%,#FFE39A,var(--gold) 55%,var(--gold-deep))}
.g-reversi-disc.p2{background:radial-gradient(circle at 35% 30%,#FFB0BA,var(--rival) 55%,#B83347)}
.g-reversi-disc.flip{animation:g-reversi-flip .36s ease}
@keyframes g-reversi-flip{0%{transform:scaleX(1)}50%{transform:scaleX(0)}100%{transform:scaleX(1)}}
`);
  const revDef = {
    id: "reversi", moveMs: 20000,
    init(rng) {
      const cells = new Int8Array(64);
      /* coin toss decides who moves first; the first mover gets the first disc set on the standard diagonals */
      const first = rng() < 0.5 ? 0 : 1;
      const f = first + 1, s = 2 - first;
      cells[28] = s; cells[35] = s; cells[27] = f; cells[36] = f;
      return { cells, turn: first, last: -1, passes: 0, moves: 0 };
    },
    legal: (st) => revEngine.moves(st.cells, st.turn + 1),
    isLegal: (st, m) => Number.isInteger(m) && m >= 0 && m < 64 && !!revEngine.flips(st.cells, m, st.turn + 1),
    apply(st, m) {
      const p = st.turn + 1, f = revEngine.flips(st.cells, m, p);
      if (!f) return null;
      st.cells[m] = p; for (const k of f) st.cells[k] = p;
      st.last = m; st.moves++;
      st.turn ^= 1;
      let passNote = null;
      if (!revEngine.moves(st.cells, st.turn + 1).length && revEngine.moves(st.cells, 2 - st.turn).length) {
        passNote = st.turn; st.turn ^= 1; st.passes++;
      }
      return { placed: m, flipped: f, pass: passNote };
    },
    result(st) {
      if (revEngine.moves(st.cells, 1).length || revEngine.moves(st.cells, 2).length) return null;
      const [a, b] = revEngine.count(st.cells);
      const reason = `${a}–${b} discs`;
      return { winner: a > b ? 0 : b > a ? 1 : -1, scores: [a, b], reason: (a + b === 64 ? "Board full, " : "No moves left, ") + reason };
    },
    ai: (st, skill, rng, budget) => revEngine.think(st.cells, st.turn + 1, skill, rng, budget),
    randomMove(st, rng) { const l = this.legal(st); return l[Math.floor(rng() * l.length)]; },
    barScore: (st, i) => revEngine.count(st.cells)[i],
    sideName: (i) => (i === 0 ? "Gold discs" : "Red discs"),
    snapshot: (st) => ({ cells: Array.from(st.cells), counts: revEngine.count(st.cells), moves: st.moves, passes: st.passes }),
    hint(st, spectate, players, initial) {
      if (initial) return spectate ? `<b>${esc(players[st.turn].name)}</b> moves first.` : `${st.turn === 0 ? "<b>You</b> move" : `<b>${esc(players[1].name)}</b> moves`} first. Tap a dot to place a disc and flip the discs you trap.`;
      return spectate ? "" : "Tap a dot to place a disc. Trapped discs flip to your colour.";
    },
    view(stage, api) {
      const P = api.P;
      stage.innerHTML = `<div class="${P}-wrap"><div class="${P}-board" data-test="board">${Array.from({ length: 64 }, (_, i) =>
        `<button type="button" class="${P}-sq" data-test="sq-${i}" data-i="${i}" aria-label="Square ${"abcdefgh"[i & 7]}${8 - (i >> 3)}"></button>`).join("")}</div></div>`;
      const sqs = stage.querySelectorAll("." + P + "-sq");
      sqs.forEach((b) => b.addEventListener("click", () => { if (api.canAct()) api.pick(+b.dataset.i); }));
      return {
        render(st, info) {
          const can = api.canAct();
          const legal = can ? new Set(revEngine.moves(st.cells, st.turn + 1)) : new Set();
          const flipped = info && info.flipped && !api.ctx.reducedMotion ? new Set(info.flipped) : null;
          for (let i = 0; i < 64; i++) {
            const b = sqs[i], v = st.cells[i];
            b.classList.toggle("hint", legal.has(i));
            b.classList.toggle("last", st.last === i);
            b.setAttribute("aria-disabled", legal.has(i) ? "false" : "true");
            let d = b.firstElementChild;
            if (!v) { if (d) d.remove(); continue; }
            if (!d) { d = document.createElement("div"); b.appendChild(d); }
            d.className = `${P}-disc p${v}${flipped && flipped.has(i) ? " flip" : ""}`;
          }
        },
      };
    },
  };
  DG.registerGame({
    id: "reversi", name: "Reversi", category: "strategy", kind: "versus", formats: ["1v1", "tournament"],
    skill: 9, luck: 1, cashEligible: true, duration: "4 min", pack: PACK, scoreLabel: "discs",
    blurb: "Trap your rival's discs between yours to flip them. Most discs at the end wins.",
    rules: [
      "Place a disc so that it traps a straight line of rival discs between it and another of yours.",
      "All trapped discs flip to your colour. Dots show your legal moves.",
      "If you have no legal move, you pass. The game ends when neither side can move.",
      "The player with more discs wins. Equal counts are a draw.",
      "A coin toss decides who moves first. You have 20 seconds per move, or a random legal move is played.",
    ],
    play(ctx) { turnGame(ctx, false, revDef); },
    spectate(ctx) { turnGame(ctx, true, revDef); },
  })._engine = Object.assign({ sim: (seed, a, b) => turnSim(revDef, seed, a, b) }, revEngine);

  /* =====================================================================
     GOMOKU (15 x 15, freestyle: five OR MORE in a row wins)
     ===================================================================== */
  const N = 15, NN = N * N;
  const GDIRS = [[1, 0], [0, 1], [1, 1], [1, -1]];
  /* pattern tables: x = own stone (including the candidate), . = empty, anything else blocks */
  const PAT = [
    [7, ["xxxxx"]],
    [6, [".xxxx."]],
    [5, ["xxxx.", ".xxxx", "xxx.x", "x.xxx", "xx.xx"]],
    [4, [".xxx..", "..xxx.", ".xx.x.", ".x.xx."]],
    [3, ["xxx..", "..xxx", ".xxx.", "xx.x.", ".x.xx", "x.xx.", ".xx.x", "x..xx", "xx..x", "x.x.x"]],
    [2, ["..xx..", ".xx..", "..xx.", ".x.x.", ".x..x.", "..x.x.", ".x.x.."]],
    [1, ["xx...", "...xx", ".xx..", "..xx.", "x.x..", "..x.x"]],
  ];
  const gomEngine = {
    /* level of one 11-cell window (centre = candidate). Encoded base 3 (0 empty, 1 own, 2 blocked) and cached. */
    _cache: new Uint8Array(177147).fill(255),
    _levelOf(code) {
      let s = "", c = code;
      for (let k = 0; k < 11; k++) { const d = c % 3; c = (c - d) / 3; s = (d === 0 ? "." : d === 1 ? "x" : "o") + s; }
      for (const [lvl, pats] of PAT) for (const pat of pats) {
        const L = pat.length;
        for (let st = Math.max(0, 5 - L + 1); st <= 5 && st + L <= 11; st++) if (s.substr(st, L) === pat) return lvl;
      }
      return 0;
    },
    lineLevel(cells, i, p) {
      const x0 = i % N, y0 = (i / N) | 0, lv = [0, 0, 0, 0], cache = this._cache;
      for (let d = 0; d < 4; d++) {
        const dx = GDIRS[d][0], dy = GDIRS[d][1];
        let code = 0;
        for (let k = -5; k <= 5; k++) {
          let v;
          if (k === 0) v = 1;
          else {
            const x = x0 + dx * k, y = y0 + dy * k;
            if (x < 0 || x >= N || y < 0 || y >= N) v = 2;
            else { const c = cells[y * N + x]; v = c === p ? 1 : c === 0 ? 0 : 2; }
          }
          code = code * 3 + v;
        }
        let l = cache[code];
        if (l === 255) { l = this._levelOf(code); cache[code] = l; }
        lv[d] = l;
      }
      return lv;
    },
    moveValue(cells, i, p) {
      const lv = this.lineLevel(cells, i, p);
      let fives = 0, open4 = 0, four = 0, open3 = 0, three = 0, two = 0, one = 0;
      for (const l of lv) { if (l === 7) fives++; else if (l === 6) open4++; else if (l === 5) four++; else if (l === 4) open3++; else if (l === 3) three++; else if (l === 2) two++; else if (l === 1) one++; }
      if (fives) return 10000000;
      if (open4 || four >= 2) return 1000000;
      if (four && open3) return 500000;
      if (open3 >= 2) return 100000;
      return four * 12000 + open3 * 6000 + three * 600 + two * 180 + one * 30;
    },
    candidates(cells) {
      const out = [];
      let any = false;
      for (let i = 0; i < NN; i++) {
        if (cells[i]) { any = true; continue; }
        const x = i % N, y = (i / N) | 0;
        let near = false;
        for (let dy = -2; dy <= 2 && !near; dy++) for (let dx = -2; dx <= 2; dx++) {
          const xx = x + dx, yy = y + dy;
          if (xx >= 0 && xx < N && yy >= 0 && yy < N && cells[yy * N + xx]) { near = true; break; }
        }
        if (near) out.push(i);
      }
      if (!any) out.push(7 * N + 7);
      return out;
    },
    ranked(cells, p, k) {
      const o = 3 - p;
      const list = this.candidates(cells).map((i) => {
        const a = this.moveValue(cells, i, p), d = this.moveValue(cells, i, o);
        return { i, a, d, s: a + d * 0.85 };
      });
      list.sort((x, y) => y.s - x.s);
      return k ? list.slice(0, k) : list;
    },
    wins(cells, i, p) {
      const x0 = i % N, y0 = (i / N) | 0;
      for (const [dx, dy] of GDIRS) {
        let n = 1;
        for (const s of [-1, 1]) { let x = x0 + dx * s, y = y0 + dy * s; while (x >= 0 && x < N && y >= 0 && y < N && cells[y * N + x] === p) { n++; x += dx * s; y += dy * s; } }
        if (n >= 5) return true;
      }
      return false;
    },
    winLine(cells, i) {
      const p = cells[i], x0 = i % N, y0 = (i / N) | 0;
      for (const [dx, dy] of GDIRS) {
        const line = [i];
        for (const s of [-1, 1]) { let x = x0 + dx * s, y = y0 + dy * s; while (x >= 0 && x < N && y >= 0 && y < N && cells[y * N + x] === p) { line.push(y * N + x); x += dx * s; y += dy * s; } }
        if (line.length >= 5) return line;
      }
      return null;
    },
    think(cells0, p, skill, rng, budget) {
      const cells = Int8Array.from(cells0);
      const self = this;
      let deadline = 0, nodes = 0;
      const WIN = 50000000;
      const K = 8;
      function leaf(q) {
        const r = self.ranked(cells, q, 1)[0];
        const r2 = self.ranked(cells, 3 - q, 1)[0];
        return (r ? r.a : 0) - (r2 ? r2.a : 0) * 0.6;
      }
      function neg(depth, alpha, beta, q, ply) {
        if ((++nodes & 3) === 0 && cpuNow() > deadline) throw ABORT;
        const ms = self.ranked(cells, q, K);
        if (!ms.length) return 0;
        if (ms[0].a >= 10000000) return WIN - ply;
        if (depth <= 0) return leaf(q);
        /* if the opponent threatens five, only blocking moves matter */
        let list = ms;
        if (ms[0].d >= 10000000) list = ms.filter((m) => m.d >= 10000000).slice(0, 1);
        let best = -Infinity;
        for (const m of list) {
          cells[m.i] = q;
          const s = -neg(depth - 1, -beta, -alpha, 3 - q, ply + 1);
          cells[m.i] = 0;
          if (s > best) best = s;
          if (s > alpha) alpha = s;
          if (alpha >= beta) break;
        }
        return best;
      }
      const root = this.ranked(cells, p, 12);
      if (!root.length) return { move: -1, depth: 0, ms: 0 };
      if (root[0].a >= 10000000 || root.length === 1) return { move: root[0].i, depth: 0, ms: 0 };
      const forced = root[0].d >= 10000000 ? root.filter((m) => m.d >= 10000000) : null;
      if (forced && forced.length) return { move: forced[0].i, depth: 0, ms: 0 };
      const maxDepth = clamp(Math.round(skill * 4), 0, 4);
      let scored;
      let depth = 0, ms = 0;
      if (maxDepth === 0) scored = root.map((m) => ({ move: m.i, s: m.s }));
      else {
        const res = deepen(maxDepth, budget, (d, dl) => {
          deadline = dl;
          const sc = [];
          let solved = false;
          for (const m of root) {
            cells[m.i] = p;
            const s = -neg(d - 1, -Infinity, Infinity, 3 - p, 1);
            cells[m.i] = 0;
            sc.push({ move: m.i, s: s + m.s * 0.001 });
            if (s >= WIN - 100) solved = true;
          }
          return { scored: sc, solved };
        });
        scored = res.best ? res.best.scored : root.map((m) => ({ move: m.i, s: m.s }));
        depth = res.depth; ms = res.ms;
      }
      const pick = skillPick(scored, skill, rng, 2500);
      return { move: pick.move, depth, ms, nodes };
    },
  };
  DG.css("gomoku", commonCss("g-gomoku") + `
.g-gomoku-wrap{width:100%;max-width:560px;margin:0 auto}
@media (max-width:420px){.g-gomoku-wrap{width:calc(100% + 12px);max-width:none;margin:0 -6px}.g-gomoku-board{padding:0;border-width:1px}}
.g-gomoku-board{display:grid;grid-template-columns:repeat(15,minmax(0,1fr));grid-auto-rows:auto;width:100%;background:#C9A45C;border-radius:var(--r-sm);
  border:2px solid #8A6A2E;padding:2px;touch-action:manipulation}
.g-gomoku-pt{position:relative;border:0;padding:0;margin:0;background:none;min-width:0;min-height:0;aspect-ratio:1;width:100%;height:auto;line-height:0;font-size:0;display:flex;align-items:center;justify-content:center;cursor:default}
.g-gomoku-pt::before,.g-gomoku-pt::after{content:"";position:absolute;background:#5B4418;pointer-events:none}
.g-gomoku-pt::before{left:0;right:0;top:50%;height:1px}
.g-gomoku-pt::after{top:0;bottom:0;left:50%;width:1px}
.g-gomoku-pt.x0::before{left:50%}.g-gomoku-pt.x14::before{right:50%}
.g-gomoku-pt.y0::after{top:50%}.g-gomoku-pt.y14::after{bottom:50%}
.g-gomoku-pt.star .g-gomoku-dot{position:absolute;width:5px;height:5px;border-radius:50%;background:#5B4418;z-index:0}
.g-gomoku-pt.can{cursor:pointer}
.g-gomoku-pt.can:hover .g-gomoku-st:empty{background:rgba(242,193,78,.45)}
.g-gomoku-st{position:relative;z-index:1;width:88%;height:88%;border-radius:50%}
.g-gomoku-st.p1{background:radial-gradient(circle at 35% 30%,#FFE39A,var(--gold) 55%,var(--gold-deep));box-shadow:0 1px 2px rgba(0,0,0,.5)}
.g-gomoku-st.p2{background:radial-gradient(circle at 35% 30%,#FFB0BA,var(--rival) 55%,#B83347);box-shadow:0 1px 2px rgba(0,0,0,.5)}
.g-gomoku-st.ghost{background:var(--gold);opacity:.5;box-shadow:0 0 0 2px var(--on-gold)}
.g-gomoku-st.last::after{content:"";position:absolute;left:35%;top:35%;width:30%;height:30%;border-radius:50%;background:var(--ink);opacity:.75}
.g-gomoku-st.win{box-shadow:0 0 0 2px var(--fg),0 0 10px 2px var(--fg)}
.g-gomoku-st.pop{animation:g-gomoku-pop .18s ease-out}
@keyframes g-gomoku-pop{from{transform:scale(.4)}to{transform:scale(1)}}
`);
  const gomDef = {
    id: "gomoku", moveMs: 20000,
    init(rng) { return { cells: new Int8Array(NN), turn: rng() < 0.5 ? 0 : 1, last: -1, moves: 0, line: null }; },
    legal(st) { const out = []; for (let i = 0; i < NN; i++) if (!st.cells[i]) out.push(i); return out; },
    isLegal: (st, m) => Number.isInteger(m) && m >= 0 && m < NN && !st.cells[m],
    apply(st, m) {
      if (!this.isLegal(st, m)) return null;
      const p = st.turn + 1;
      st.cells[m] = p; st.last = m; st.moves++;
      if (gomEngine.wins(st.cells, m, p)) st.line = gomEngine.winLine(st.cells, m);
      st.turn ^= 1;
      return { placed: m };
    },
    result(st) {
      if (st.line) { const w = st.cells[st.line[0]] - 1; return { winner: w, scores: w === 0 ? [1, 0] : [0, 1], reason: "Five in a row" }; }
      if (st.moves >= NN) return { winner: -1, scores: [0.5, 0.5], reason: "The board is full" };
      return null;
    },
    ai: (st, skill, rng, budget) => gomEngine.think(st.cells, st.turn + 1, skill, rng, budget),
    randomMove(st, rng) {
      /* a random legal point next to existing stones (a random corner would be absurd) */
      const c = gomEngine.candidates(st.cells);
      return c[Math.floor(rng() * c.length)];
    },
    barScore: () => "",
    sideName: (i) => (i === 0 ? "Gold stones" : "Red stones"),
    snapshot: (st) => ({ cells: Array.from(st.cells), moves: st.moves, line: st.line }),
    hint(st, spectate, players, initial) {
      if (!initial) return spectate ? "" : "Get five or more in a row. On touch screens, tap twice to place.";
      if (spectate) return `<b>${esc(players[st.turn].name)}</b> moves first.`;
      return `${st.turn === 0 ? "<b>You</b> move" : `<b>${esc(players[1].name)}</b> moves`} first. Get five or more in a row. On touch screens, tap twice to place.`;
    },
    view(stage, api) {
      const P = api.P;
      const stars = new Set([3 * N + 3, 3 * N + 11, 7 * N + 7, 11 * N + 3, 11 * N + 11]);
      stage.innerHTML = `<div class="${P}-wrap"><div class="${P}-board" data-test="board">${Array.from({ length: NN }, (_, i) => {
        const x = i % N, y = (i / N) | 0;
        return `<button type="button" class="${P}-pt x${x} y${y}${stars.has(i) ? " star" : ""}" data-test="pt-${i}" data-i="${i}" aria-label="Point ${x + 1},${y + 1}">${stars.has(i) ? `<i class="${P}-dot"></i>` : ""}<span class="${P}-st"></span></button>`;
      }).join("")}</div></div>`;
      const pts = stage.querySelectorAll("." + P + "-pt");
      let pending = -1, lastType = "mouse", lastSt = null;
      pts.forEach((b) => {
        b.addEventListener("pointerdown", (e) => { lastType = e.pointerType || "mouse"; });
        b.addEventListener("click", () => {
          if (!api.canAct()) return;
          const i = +b.dataset.i;
          if (lastType === "mouse" || i === pending) { pending = -1; api.pick(i); lastType = "mouse"; return; }
          pending = i; paint(lastSt);
          lastType = "mouse";
        });
      });
      function paint(st) {
        if (!st) return;
        const can = api.canAct();
        if (!can) pending = -1;
        const line = st.line ? new Set(st.line) : null;
        for (let i = 0; i < NN; i++) {
          const v = st.cells[i], s = pts[i].lastElementChild;
          let cls = `${P}-st`;
          if (v) { cls += " p" + v; if (i === st.last) cls += " last"; if (line && line.has(i)) cls += " win"; }
          else if (i === pending) cls += " ghost";
          if (s.className.replace(" pop", "") !== cls) s.className = cls + (v && i === st.last && !api.ctx.reducedMotion ? " pop" : "");
          pts[i].classList.toggle("can", can && !v);
        }
      }
      return { render(st) { lastSt = st; paint(st); } };
    },
  };
  DG.registerGame({
    id: "gomoku", name: "Gomoku", category: "strategy", kind: "versus", formats: ["1v1", "tournament"],
    skill: 8, luck: 2, cashEligible: true, duration: "4 min", pack: PACK, scoreLabel: "points",
    blurb: "Place stones on a 15 × 15 board. First to line up five wins.",
    rules: [
      "Players take turns placing one stone on any empty point.",
      "Five or more stones in a row, column or diagonal wins (overlines count).",
      "A coin toss decides who moves first. Moving first is a real advantage.",
      "You have 20 seconds per move. If time runs out, a random nearby point is played for you.",
      "On touch screens, tap a point to preview and tap it again to place. A full board is a draw.",
    ],
    play(ctx) { turnGame(ctx, false, gomDef); },
    spectate(ctx) { turnGame(ctx, true, gomDef); },
  })._engine = Object.assign(Object.create(gomEngine), { sim: (seed, a, b) => turnSim(gomDef, seed, a, b) });
})();
