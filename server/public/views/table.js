/* Table games on the play screen: chess and poker, played out by the server (server/src/tables).

   The server sends the table as one player may see it (match.table → S.table) after every change; this module draws it
   inside #stage and turns clicks into actions (S.client.act). Nothing here decides a rule: the move lists, the legal bet
   sizes and every card come from the server. The board is redrawn from each table the server sends; a move is shown at
   once on the board while the server confirms it (it answers in a fraction of a second), and the next table replaces it.

   Markup uses .tb-* classes styled in /play/table.css. */
import { esc } from "../ui.js";

const NB = " ";
const $ = (s, r = document) => r.querySelector(s);

/* ------------------------------------------------------------------ shared */

/* the frame for a table game, built once per match; #stage holds the board, #countdown the 3-2-1, #forfeitArea the leave button */
export function tableFrame(ctx) {
  const { S, h } = ctx;
  const m = S.match;
  const others = (m.players || []).filter((p) => !p.you);
  const vs = others.length === 1 ? `vs ${esc(others[0].name)}` : `${others.length + 1} players`;
  return `<section class="mx mx-play tb tb-game-${esc(m.game.id)}" aria-label="Match: ${esc(m.game.name)}">
      <div class="mx-hud">
        <div class="mx-hudtop">
          <div class="mx-hudwho"><div><h1 class="mx-hudname" title="${esc(m.game.name)}">${esc(m.game.name)}</h1><span class="mx-k">${vs}${String(m.stake) === "0" ? " · free play" : ` · pot ${esc(h.eth(m.pot))}${NB}${esc(h.sym())}`}</span></div></div>
          <div class="mx-status" id="status" aria-live="polite"></div>
          <div class="mx-forfeit" id="forfeitArea"></div>
        </div>
      </div>
      <div class="mx-cd" id="countdown" role="timer"></div>
      <div id="stage" class="tb-stage"></div>
      <p class="mx-note" id="playNote" aria-live="polite"></p>
    </section>`;
}

const nameOf = (S, seat) => {
  const p = ((S.match || S.result || {}).players || []).find((x) => x.seat === seat);
  return p ? (p.you ? "You" : p.name) : `Seat ${seat + 1}`;
};

/* m:ss, or s.t under 20 seconds */
export function clockText(ms) {
  const t = Math.max(0, ms);
  if (t < 20_000) return `${Math.floor(t / 1000)}.${Math.floor((t % 1000) / 100)}`;
  const s = Math.ceil(t / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

let ticker = 0;
/* one timer for every running clock on the page (chess clocks, the poker action bar, the blind level) */
function startTicker(app) {
  if (ticker) return;
  const tick = () => {
    ticker = 0;
    const { S } = app;
    if (S.view !== "play" || !S.table) return;
    paintClocks(app);
    ticker = setTimeout(tick, 100);
  };
  ticker = setTimeout(tick, 100);
}

function paintClocks(app) {
  const { S } = app;
  const t = S.table, now = S.client.serverNow(), age = Math.max(0, now - (S.tableAt || now));
  if (t.kind === "chess") {
    for (const el of document.querySelectorAll(".tb-clock[data-seat]")) {
      const seat = Number(el.dataset.seat);
      const ms = t.clocks[seat] - (t.running === seat && !(t.startsAt && now < t.startsAt) ? age : 0);
      const txt = clockText(ms);
      const b = el.querySelector("b");
      if (b && b.textContent !== txt) b.textContent = txt;
      el.classList.toggle("low", t.running === seat && ms < 20_000);
    }
  } else {
    const bar = $("#tbTimer");
    if (bar && t.actionDeadline) {
      const left = Math.max(0, t.actionDeadline - now);
      const total = Number(bar.dataset.total) || 25_000;
      bar.style.setProperty("--left", Math.min(1, left / total).toFixed(3));
      const n = bar.querySelector("b"); const txt = String(Math.ceil(left / 1000));
      if (n && n.textContent !== txt) n.textContent = txt;
    }
    const lv = $("#tbLevelNext");
    if (lv && t.blinds.next) { const txt = clockText(t.blinds.next.at - now); if (lv.textContent !== txt) lv.textContent = txt; }
  }
}

/* draw the table that just arrived (or the one we have) */
export function renderTable(app) {
  const { S } = app;
  const stage = $("#stage");
  if (!stage || !S.table) return;
  if (S.table.kind === "chess") chessRender(app, stage);
  else pokerRender(app, stage);
  setStatus(app);
  paintClocks(app);
  startTicker(app);
}

function setStatus(app) {
  const { S } = app;
  const t = S.table, el = $("#status");
  if (!el) return;
  let txt = "";
  if (S.forfeited) txt = "You left the table";
  else if (t.kind === "chess") {
    if (t.result) txt = "Game over";
    else if (t.startsAt && S.client.serverNow() < t.startsAt) txt = "Starting…";
    else txt = t.turn === t.you ? (t.check ? "Check · your move" : "Your move") : (t.check ? "Check · their move" : "Their move");
  } else {
    if (t.over) txt = "Game over";
    else if (t.street === "done") txt = "Next hand…";
    else txt = t.toAct === t.you ? "Your turn" : `${nameOf(S, t.toAct)} to act`;
  }
  if (el.textContent !== txt) el.textContent = txt;
}

async function send(app, action) {
  const { S } = app;
  if (!S.match || S.tablePending) return;
  S.tablePending = true;
  try { await S.client.act(S.match.id, action); }
  catch (e) {
    if (e.code !== "MATCH_NOT_PLAYING") app.toast(e.message, "bad");
    S.optimistic = null;
    renderTable(app); // put the board back the way the server has it
  } finally { S.tablePending = false; }
}

/* ------------------------------------------------------------------ chess */

const GLYPH = { k: "♚", q: "♛", r: "♜", b: "♝", n: "♞", p: "♟" };
const PIECE_NAME = { k: "king", q: "queen", r: "rook", b: "bishop", n: "knight", p: "pawn" };
const FILES = "abcdefgh";

/* "rnbqkbnr/pppppppp/8/…" → { "a8": { t: "r", c: "b" }, … } */
export function fenBoard(fen) {
  const out = {};
  const rows = String(fen).split(" ")[0].split("/");
  rows.forEach((row, i) => {
    let f = 0;
    for (const ch of row) {
      if (/\d/.test(ch)) { f += Number(ch); continue; }
      out[FILES[f] + (8 - i)] = { t: ch.toLowerCase(), c: ch === ch.toLowerCase() ? "b" : "w" };
      f++;
    }
  });
  return out;
}

/* the board as the server has it, with my pending move applied on top so it shows without waiting */
function boardOf(S) {
  const t = S.table, b = fenBoard(t.fen);
  const o = S.optimistic;
  if (o && o.plies === t.plies) {
    const p = b[o.from];
    if (p) {
      delete b[o.from];
      if (p.t === "p" && o.from[0] !== o.to[0] && !b[o.to]) delete b[o.to[0] + o.from[1]]; // en passant
      if (p.t === "k" && Math.abs(FILES.indexOf(o.to[0]) - FILES.indexOf(o.from[0])) === 2) { // castling: the rook jumps over
        const r = o.to[1], [rf, rt] = o.to[0] === "g" ? ["h", "f"] : ["a", "d"];
        b[rt + r] = b[rf + r]; delete b[rf + r];
      }
      b[o.to] = o.promotion ? { t: o.promotion, c: p.c } : p;
    }
  }
  return b;
}

function chessRender(app, stage) {
  const { S } = app;
  const t = S.table;
  if (S.optimistic && S.optimistic.plies !== t.plies) S.optimistic = null; // the server's table already has it
  if (!stage.querySelector(".tb-chess")) {
    stage.innerHTML = `<div class="tb-chess">
        <div class="tb-side tb-them" id="tbThem"></div>
        <div class="tb-boardwrap"><div class="tb-board" id="tbBoard" role="grid" aria-label="Chess board"></div><div class="tb-promo" id="tbPromo" hidden></div></div>
        <div class="tb-side tb-me" id="tbMe"></div>
        <aside class="tb-panel" id="tbPanel" aria-label="Moves and offers"></aside>
      </div>`;
    wireChess(app, stage);
  }
  const me = t.you, them = 1 - me;
  const bar = (seat, mine) => {
    const color = seat === t.white ? "White" : "Black";
    return `<div class="tb-player${t.running === seat ? " turn" : ""}${mine ? " you" : ""}"><span class="tb-dot ${seat === t.white ? "w" : "b"}" aria-hidden="true"></span><span class="tb-pname">${esc(nameOf(S, seat))}</span><span class="mx-k">${color}</span></div>
      <div class="tb-clock${t.running === seat ? " on" : ""}" data-seat="${seat}" role="timer" aria-label="${esc(nameOf(S, seat))} clock"><b>${clockText(t.clocks[seat])}</b></div>`;
  };
  setHTML($("#tbThem"), bar(them, false));
  setHTML($("#tbMe"), bar(me, true));
  drawBoard(app);
  drawPanel(app);
}

function setHTML(el, html) { if (el && el._html !== html) { el._html = html; el.innerHTML = html; } }

function drawBoard(app) {
  const { S } = app;
  const t = S.table, b = boardOf(S);
  const flip = t.color === "b";
  const sel = S.chessSel || null;
  const targets = sel ? new Set(t.legal.filter((m) => m.slice(0, 2) === sel).map((m) => m.slice(2, 4))) : new Set();
  const o = S.optimistic;
  const last = o ? { from: o.from, to: o.to } : t.lastMove;
  const focus = S.chessFocus || (t.color === "b" ? "e7" : "e2");
  let html = "";
  for (let r = 0; r < 8; r++) {
    for (let f = 0; f < 8; f++) {
      const file = flip ? 7 - f : f, rank = flip ? r + 1 : 8 - r;
      const sq = FILES[file] + rank;
      const p = b[sq];
      const dark = (file + rank) % 2 === 1 ? "" : " dk";
      const cls = `tb-sq${dark}${last && (last.from === sq || last.to === sq) ? " last" : ""}${sel === sq ? " sel" : ""}${targets.has(sq) ? (p ? " cap" : " tgt") : ""}${t.check === sq && !o ? " chk" : ""}`;
      const label = `${sq}${p ? `, ${p.c === "w" ? "white" : "black"} ${PIECE_NAME[p.t]}` : ""}${targets.has(sq) ? ", move here" : ""}`;
      const coord = (f === 0 ? `<i class="tb-rk">${rank}</i>` : "") + (r === 7 ? `<i class="tb-fl">${FILES[file]}</i>` : "");
      html += `<button type="button" class="${cls}" data-sq="${sq}" role="gridcell" aria-label="${label}" tabindex="${sq === focus ? 0 : -1}">${coord}${p ? `<span class="tb-pc ${p.c}" aria-hidden="true">${GLYPH[p.t]}︎</span>` : ""}</button>`;
    }
  }
  const board = $("#tbBoard");
  if (board._html !== html) {
    const had = document.activeElement && board.contains(document.activeElement) ? document.activeElement.dataset.sq : null;
    board._html = html; board.innerHTML = html;
    if (had) { const el = board.querySelector(`[data-sq="${had}"]`); if (el) el.focus({ preventScroll: true }); }
  }
}

function drawPanel(app) {
  const { S } = app;
  const t = S.table;
  const pairs = [];
  for (let i = 0; i < t.san.length; i += 2) pairs.push(`<li><span class="tb-mn">${i / 2 + 1}.</span><span>${esc(t.san[i])}</span><span>${esc(t.san[i + 1] || "")}</span></li>`);
  let offer = "";
  if (!t.result && !S.forfeited) {
    if (t.drawOffer === 1 - t.you) offer = `<div class="tb-offer" role="alert"><span>${esc(nameOf(S, 1 - t.you))} offers a draw</span><span class="tb-offer-b"><button class="mx-btn sm" data-tb="draw-accept" id="tbDrawYes">Accept draw</button><button class="mx-btn quiet sm" data-tb="draw-decline">Decline</button></span></div>`;
    else if (t.drawOffer === t.you) offer = `<p class="mx-k tb-offered">Draw offered. Waiting for an answer.</p>`;
    else offer = `<button class="mx-btn quiet sm" data-tb="draw-offer" id="tbDrawOffer"${t.plies < 2 ? " disabled" : ""}>Offer a draw</button>`;
  }
  const html = `${offer}
    <div class="tb-moves"><p class="mx-k">Moves</p>${pairs.length ? `<ol class="tb-ml" id="tbMoves">${pairs.join("")}</ol>` : `<p class="tb-empty">${t.color === "w" ? "You play White and move first." : "You play Black. White moves first."}</p>`}</div>`;
  const el = $("#tbPanel");
  if (el._html !== html) {
    el._html = html; el.innerHTML = html;
    const ml = $("#tbMoves"); if (ml) ml.scrollTop = ml.scrollHeight;
  }
}

function chessClick(app, sq) {
  const { S } = app;
  const t = S.table;
  if (!t || t.result || S.forfeited || S.tablePending) return;
  S.chessFocus = sq;
  const mine = t.legal.filter((m) => m.slice(0, 2) === sq);
  const sel = S.chessSel;
  if (sel && sel !== sq) {
    const moves = t.legal.filter((m) => m.slice(0, 2) === sel && m.slice(2, 4) === sq);
    if (moves.length) {
      if (moves.length > 1 || moves[0].length === 5) return askPromotion(app, sel, sq);
      return playMove(app, sel, sq);
    }
  }
  S.chessSel = mine.length && sel !== sq ? sq : null;
  drawBoard(app);
}

function playMove(app, from, to, promotion) {
  const { S } = app;
  S.chessSel = null;
  S.optimistic = { from, to, promotion, plies: S.table.plies };
  drawBoard(app);
  send(app, { type: "move", from, to, ...(promotion ? { promotion } : {}) });
}

function askPromotion(app, from, to) {
  const { S } = app;
  const box = $("#tbPromo");
  const c = S.table.color;
  box.innerHTML = `<p class="mx-k">Promote to</p><div class="tb-promo-b">${["q", "r", "b", "n"].map((p) => `<button type="button" class="tb-promo-p" data-promo="${p}" aria-label="${PIECE_NAME[p]}"><span class="tb-pc ${c}" aria-hidden="true">${GLYPH[p]}︎</span></button>`).join("")}</div><button type="button" class="mx-btn quiet sm" data-promo="">Cancel</button>`;
  box.hidden = false;
  box.dataset.from = from; box.dataset.to = to;
  const first = box.querySelector("[data-promo]"); if (first) first.focus();
}

function wireChess(app, stage) {
  const { S } = app;
  let downSq = null;
  stage.addEventListener("pointerdown", (e) => {
    const b = e.target.closest(".tb-sq"); if (!b) return;
    downSq = b.dataset.sq;
    const t = S.table;
    // pressing one of my pieces picks it up at once, so a drag can end on its target
    if (t && !t.result && t.legal.some((m) => m.slice(0, 2) === downSq) && S.chessSel !== downSq) { S.chessSel = downSq; S.chessFocus = downSq; drawBoard(app); downSq = "picked:" + downSq; }
  });
  stage.addEventListener("pointerup", (e) => {
    if (!downSq) return;
    const startedPicked = downSq.startsWith("picked:");
    const from = startedPicked ? downSq.slice(7) : downSq;
    downSq = null;
    const el = document.elementFromPoint(e.clientX, e.clientY);
    const b = el && el.closest && el.closest(".tb-sq");
    if (!b) return;
    if (b.dataset.sq === from) { if (!startedPicked) chessClick(app, from); return; } // a plain click (the pick-up already happened on press)
    chessClick(app, b.dataset.sq); // released on another square: a drag
  });
  stage.addEventListener("click", (e) => {
    const p = e.target.closest("[data-promo]");
    if (p) {
      const box = $("#tbPromo"); box.hidden = true;
      if (p.dataset.promo) playMove(app, box.dataset.from, box.dataset.to, p.dataset.promo);
      else { S.chessSel = null; drawBoard(app); }
      return;
    }
    const a = e.target.closest("[data-tb]");
    if (a) send(app, { type: a.dataset.tb });
  });
  stage.addEventListener("keydown", (e) => {
    const b = e.target.closest(".tb-sq"); if (!b) return;
    const flip = S.table.color === "b";
    const sq = b.dataset.sq, f = FILES.indexOf(sq[0]), r = Number(sq[1]);
    const d = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1] }[e.key];
    if (d) {
      e.preventDefault();
      const nf = f + (flip ? -d[0] : d[0]), nr = r + (flip ? -d[1] : d[1]);
      if (nf < 0 || nf > 7 || nr < 1 || nr > 8) return;
      S.chessFocus = FILES[nf] + nr;
      drawBoard(app);
      const n = $(`#tbBoard [data-sq="${S.chessFocus}"]`); if (n) n.focus();
    } else if (e.key === "Enter" || e.key === " ") { e.preventDefault(); chessClick(app, sq); }
    else if (e.key === "Escape") { S.chessSel = null; drawBoard(app); }
  });
}

/* a small, static board for the result screen */
export function miniBoard(t) {
  const b = fenBoard(t.fen), flip = t.color === "b";
  let html = "";
  for (let r = 0; r < 8; r++) for (let f = 0; f < 8; f++) {
    const file = flip ? 7 - f : f, rank = flip ? r + 1 : 8 - r, sq = FILES[file] + rank, p = b[sq];
    const last = t.lastMove && (t.lastMove.from === sq || t.lastMove.to === sq);
    html += `<span class="tb-sq${(file + rank) % 2 === 1 ? "" : " dk"}${last ? " last" : ""}">${p ? `<span class="tb-pc ${p.c}">${GLYPH[p.t]}︎</span>` : ""}</span>`;
  }
  return `<div class="tb-board tb-mini" role="img" aria-label="Final position">${html}</div>`;
}

/* ------------------------------------------------------------------ poker */

const SUIT = { s: "♠", h: "♥", d: "♦", c: "♣" };
const SUIT_NAME = { s: "spades", h: "hearts", d: "diamonds", c: "clubs" };
const RANK = { T: "10", J: "J", Q: "Q", K: "K", A: "A" };
const RANK_NAME = { T: "ten", J: "jack", Q: "queen", K: "king", A: "ace" };
export const cardHTML = (c, cls = "") => c
  ? `<span class="tb-card ${c[1] === "h" || c[1] === "d" ? "red" : "blk"} ${cls}" role="img" aria-label="${RANK_NAME[c[0]] || c[0]} of ${SUIT_NAME[c[1]]}"><b>${RANK[c[0]] || c[0]}</b><i aria-hidden="true">${SUIT[c[1]]}︎</i></span>`
  : `<span class="tb-card back ${cls}" aria-hidden="true"></span>`;
const chips = (n) => Number(n).toLocaleString("en-US");

function pokerRender(app, stage) {
  const { S } = app;
  const t = S.table;
  if (!stage.querySelector(".tb-poker")) {
    stage.innerHTML = `<div class="tb-poker">
        <div class="tb-felt" id="tbFelt"><div class="tb-seats" id="tbSeats"></div><div class="tb-center" id="tbCenter"></div></div>
        <div class="tb-hero" id="tbHero"></div>
        <div class="tb-actions" id="tbActions"></div>
        <details class="tb-fair" id="tbFair"><summary class="mx-k">Shuffle check</summary><div id="tbFairBody"></div></details>
      </div>`;
    wirePoker(app, stage);
  }
  const n = t.players.length;
  // seats around the table, me at the bottom, the rest clockwise
  const order = Array.from({ length: n }, (_, k) => (t.you + k) % n);
  const seatHTML = (seat, k) => {
    const p = t.players[seat];
    const turn = t.toAct === seat && t.street !== "done" && !t.over;
    const last = t.street === "done" && t.last && t.last.no === t.handNo ? t.last : null;
    const won = last ? last.won[seat] : 0;
    const angle = n > 1 ? (k / n) * 2 * Math.PI : 0;
    const tags = `${t.button === seat ? '<span class="tb-tag d" title="Dealer">D</span>' : ""}${t.sbSeat === seat && t.street !== "done" ? '<span class="tb-tag">SB</span>' : ""}${t.bbSeat === seat && t.street !== "done" ? '<span class="tb-tag">BB</span>' : ""}`;
    const cards = p.cards ? p.cards.map((c) => cardHTML(c, "sm")).join("") : p.hasCards && seat !== t.you ? cardHTML(null, "sm") + cardHTML(null, "sm") : "";
    const state = p.out ? "Out" : p.folded ? "Folded" : p.allIn ? "All-in" : p.away ? "Away" : "";
    return `<div class="tb-seat${seat === t.you ? " you" : ""}${turn ? " turn" : ""}${p.out ? " out" : p.folded ? " folded" : ""}${won > 0 ? " won" : ""}" style="--a:${angle.toFixed(4)}" data-seat="${seat}">
        <div class="tb-seat-top"><span class="tb-pname">${esc(nameOf(S, seat))}</span>${tags}</div>
        <div class="tb-stack"><b>${chips(p.stack)}</b>${state ? `<span class="mx-k">${state}</span>` : ""}</div>
        ${seat !== t.you ? `<div class="tb-hole">${cards}</div>` : ""}
        <div class="tb-act">${won > 0 ? `<span class="tb-won">+${chips(won)}</span>` : p.bet ? `<span class="tb-bet">${chips(p.bet)}</span>` : ""}${p.action && !won ? `<span class="tb-last">${esc(p.action)}</span>` : ""}</div>
      </div>`;
  };
  setHTML($("#tbSeats"), order.map(seatHTML).join(""));

  const lv = t.blinds;
  const last = t.last && t.last.no === t.handNo && t.street === "done" ? t.last : null;
  const result = last ? last.pots.map((p) => `${p.winners.map((w) => esc(nameOf(S, w))).join(" and ")} ${p.winners.length > 1 ? "split" : p.winners.includes(t.you) ? "win" : "wins"} ${chips(p.amount)}${p.hand ? ` with ${esc(p.hand.toLowerCase())}` : ""}`).join(" · ") : "";
  const board = Array.from({ length: 5 }, (_, i) => (t.board[i] ? cardHTML(t.board[i]) : `<span class="tb-card slot" aria-hidden="true"></span>`)).join("");
  setHTML($("#tbCenter"), `
      <div class="tb-board5" role="group" aria-label="Board">${board}</div>
      <div class="tb-pot"><span class="mx-k">Pot</span> <b>${chips(t.pot)}</b></div>
      <p class="tb-result" aria-live="polite">${result}</p>
      <p class="mx-k tb-level">Hand ${t.handNo} · blinds ${chips(lv.sb)}/${chips(lv.bb)}${lv.next ? ` · ${chips(lv.next.sb)}/${chips(lv.next.bb)} in <span id="tbLevelNext"></span>` : ""}</p>`);

  const me = t.players[t.you];
  const heroCards = me.cards ? me.cards.map((c) => cardHTML(c, "lg")).join("") : "";
  const handName = last && last.hands && last.hands[t.you] ? last.hands[t.you].name : "";
  setHTML($("#tbHero"), `<div class="tb-herocards">${heroCards}</div>
      <div class="tb-heroinfo"><span class="mx-k">Your stack</span><b class="tb-herostack">${chips(me.stack)}</b>${me.bet ? `<span class="mx-k">In front of you: ${chips(me.bet)}</span>` : ""}${handName ? `<span class="tb-handname">${esc(handName)}</span>` : ""}</div>`);

  drawActions(app);
  drawFairness(app);
}

/* the action bar. Rebuilt only when the decision changes, so a half-dragged raise slider is never reset. */
function drawActions(app) {
  const { S } = app;
  const t = S.table, L = t.legal;
  const el = $("#tbActions");
  const key = L && !S.forfeited ? `${t.handNo}:${t.street}:${t.currentBet}:${t.toAct}` : `idle:${t.toAct}:${t.street}:${t.over}`;
  if (el.dataset.key === key) return;
  el.dataset.key = key;
  if (!L || S.forfeited || t.over) {
    const p = t.players[t.you];
    const msg = t.over ? "" : S.forfeited ? "You left the table." : p.out ? "You are out of chips. Watching the rest of the game." : t.street === "done" ? "The next hand is being dealt." : p.folded ? "You folded. Waiting for the next hand." : p.allIn ? "You are all-in." : `Waiting for ${esc(nameOf(S, t.toAct))}.`;
    el.innerHTML = msg ? `<p class="tb-wait">${msg}</p>` : "";
    return;
  }
  const potAfterCall = t.pot + L.call;
  const preset = (label, to) => (L.raise && to >= L.raise.min && to <= L.raise.max ? `<button type="button" class="mx-btn quiet sm" data-to="${to}">${label}</button>` : "");
  const potTo = t.currentBet + potAfterCall;
  const word = L.bet ? "Bet" : "Raise to";
  el.innerHTML = `<div class="tb-timer" id="tbTimer" data-total="${Math.max(1, t.actionDeadline - (S.client.serverNow()))}" role="timer" aria-label="Time to act"><i></i><b></b></div>
    <div class="tb-btns">
      ${L.fold ? `<button type="button" class="mx-btn danger" data-pk="fold" id="tbFold">Fold</button>` : ""}
      ${L.check ? `<button type="button" class="mx-btn" data-pk="check" id="tbCheck">Check</button>` : `<button type="button" class="mx-btn" data-pk="call" id="tbCall">${L.call >= L.stack ? "All-in" : "Call"} ${chips(L.call)}</button>`}
      ${L.raise ? `<button type="button" class="mx-btn primary" data-pk="raise" id="tbRaise">${word} <span id="tbRaiseAmt">${chips(L.raise.min)}</span></button>` : ""}
    </div>
    ${L.raise ? `<div class="tb-sizer">
      <input type="range" id="tbRange" min="${L.raise.min}" max="${L.raise.max}" step="1" value="${L.raise.min}" aria-label="${word} amount">
      <input type="number" id="tbAmount" inputmode="numeric" min="${L.raise.min}" max="${L.raise.max}" value="${L.raise.min}" aria-label="${word} amount in chips">
      <div class="tb-presets">${preset("Min", L.raise.min)}${preset("½ pot", t.currentBet + Math.floor(potAfterCall / 2))}${preset("Pot", potTo)}${preset("All-in", L.raise.max)}</div>
    </div>` : ""}`;
}

function drawFairness(app) {
  const { S } = app;
  const t = S.table;
  const last = t.last;
  const html = `<p class="mx-fine">Each hand is dealt from a deck shuffled with the server's cryptographic random generator. Before the first card, the table shows the deck's fingerprint: <span class="tb-hash">sha256(deck + salt)</span>. After the hand, the deck and the salt are shown, so anyone can check the cards were fixed before play began.</p>
    <p class="mx-k">This hand (${t.handNo})</p><p class="tb-hash">${esc(t.commit || "")}</p>
    ${last ? `<p class="mx-k">Hand ${last.no}: deck and salt</p><p class="tb-hash">${esc(last.reveal.deck)}</p><p class="tb-hash">salt ${esc(last.reveal.salt)}</p><p class="tb-hash">fingerprint ${esc(last.reveal.commit)}</p>
      <button type="button" class="mx-btn quiet sm" data-verify="1" id="tbVerify">Check hand ${last.no}</button><span class="tb-verified" id="tbVerified" role="status"></span>` : ""}`;
  setHTML($("#tbFairBody"), html);
}

async function verifyLast(app) {
  const r = app.S.table.last && app.S.table.last.reveal;
  const out = $("#tbVerified");
  if (!r || !out) return;
  try {
    const bytes = new TextEncoder().encode(r.deck.replace(/ /g, "") + ":" + r.salt);
    const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
    const cards = r.deck.split(" ");
    const ok = hash === r.commit && new Set(cards).size === 52;
    out.textContent = ok ? "Matches: this deck was fixed before the hand began." : "Does not match.";
    out.className = "tb-verified " + (ok ? "ok" : "bad");
  } catch { out.textContent = "This browser cannot compute the check."; }
}

function wirePoker(app, stage) {
  const { S } = app;
  const clamp = (v) => { const L = S.table.legal; if (!L || !L.raise) return v; return Math.max(L.raise.min, Math.min(L.raise.max, Math.round(Number(v) || 0))); };
  const setAmount = (v) => {
    const to = clamp(v);
    const r = $("#tbRange"), a = $("#tbAmount"), lab = $("#tbRaiseAmt");
    if (r) r.value = to; if (a && document.activeElement !== a) a.value = to; if (lab) lab.textContent = chips(to);
    const L = S.table.legal;
    const b = $("#tbRaise"); if (b && L && L.raise) b.firstChild.textContent = to === L.raise.max ? "All-in " : (L.bet ? "Bet " : "Raise to ");
  };
  stage.addEventListener("input", (e) => {
    if (e.target.id === "tbRange") setAmount(e.target.value);
    if (e.target.id === "tbAmount") { const r = $("#tbRange"), lab = $("#tbRaiseAmt"), v = clamp(e.target.value); if (r) r.value = v; if (lab) lab.textContent = chips(v); }
  });
  stage.addEventListener("click", (e) => {
    const pre = e.target.closest("[data-to]");
    if (pre) return setAmount(pre.dataset.to);
    if (e.target.closest("[data-verify]")) return verifyLast(app);
    const b = e.target.closest("[data-pk]");
    if (!b || S.tablePending) return;
    const type = b.dataset.pk;
    if (type === "raise") {
      const L = S.table.legal, to = clamp(($("#tbAmount") || {}).value || ($("#tbRange") || {}).value);
      return act(L && L.raise && to === L.raise.max ? { type: "allin" } : { type: "raise", to });
    }
    act({ type });
  });
  stage.addEventListener("keydown", (e) => {
    if (e.target.id === "tbAmount" && e.key === "Enter") { e.preventDefault(); const b = $("#tbRaise"); if (b) b.click(); }
  });
  const act = (action) => {
    for (const x of document.querySelectorAll("#tbActions button")) x.disabled = true; // one action per turn: wait for the server
    send(app, action);
  };
}

/* ------------------------------------------------------------------ result screen */

/* why a table game ended, from the viewer's side */
export function tableReason(m, ps) {
  const you = ps.find((p) => p.you) || {};
  const opp = ps.find((p) => !p.you) || {};
  const won = m.result === "win";
  const winner = ps.find((p) => Number(p.place) === 1 && !p.you);
  return {
    checkmate: won ? "Checkmate. You won the game." : "Checkmate. Your opponent won the game.",
    timeout: won ? `${opp.name || "Your opponent"} ran out of time.` : "You ran out of time.",
    timeout_insufficient: "Time ran out, but the other side had nothing left to mate with: a draw. Stakes are returned.",
    stalemate: "Stalemate: a draw. Stakes are returned.",
    repetition: "The same position came up three times: a draw. Stakes are returned.",
    insufficient: "Neither side can checkmate any more: a draw. Stakes are returned.",
    fifty_moves: "Fifty moves without a capture or a pawn move: a draw. Stakes are returned.",
    agreement: "Draw agreed. Stakes are returned.",
    time_cap: "The game reached its time limit: a draw. Stakes are returned.",
    forfeit: m.game.id === "chess" ? (you.forfeited ? "You resigned." : `${opp.name || "Your opponent"} resigned.`) : you.forfeited ? "You left the table." : "Everyone else left the table.",
    last_standing: won ? "You took every chip on the table." : `${winner ? winner.name : "Another player"} took every chip on the table.`,
    chips: "The table reached its time limit. The biggest stack won.",
    no_result: "The game could not be finished. Stakes are returned.",
  }[m.reason] || "";
}

/* the scoreboard part of the result screen for a table game */
export function tableBoard(m, ps, h) {
  const t = m.table;
  if (m.game.id === "chess" && t && t.fen) {
    const n = t.san ? t.san.length : 0;
    return `<div class="mx-a-main tb-final">${miniBoard(t)}${n ? `<p class="mx-fine">${Math.ceil(n / 2)} ${Math.ceil(n / 2) === 1 ? "move" : "moves"} · last: ${esc(t.san.slice(-6).join(" "))}</p>` : ""}</div>`;
  }
  if (m.game.id === "poker") {
    const rows = [...ps].sort((a, b) => (Number(a.place) || 99) - (Number(b.place) || 99)).map((p) => {
      const money = p.payout != null && String(m.stake) !== "0" && BigInt(p.payout || 0) > 0n ? `+${esc(h.eth(p.payout))}${NB}${esc(h.sym())}` : "";
      const note = p.forfeited ? "Left the table" : Number(p.place) === 1 ? "Last player with chips" : "Out of chips";
      return `<li class="mx-pr mx-res${p.you ? " you" : ""}${Number(p.place) === 1 ? " first" : ""}"><span class="mx-place">${p.place ? ordinal(p.place) : "–"}</span><span class="mx-pname">${esc(p.name)}${p.you ? '<span class="mx-ptags"><span class="lb-chip-s you">You</span></span>' : ""}</span><span class="mx-pscore"><small>${note}</small>${money ? `<small class="mx-pay">${money}</small>` : ""}</span></li>`;
    }).join("");
    return `<section class="mx-a-main mx-players" aria-labelledby="stH"><h2 class="mx-k mx-plh" id="stH">Final standings <span class="mx-plc">${ps.length} players</span></h2><ol class="mx-pl mx-board">${rows}</ol></section>`;
  }
  return "";
}
const ordinal = (n) => { const v = Number(n), t = v % 100; return v + (t >= 11 && t <= 13 ? "th" : ["th", "st", "nd", "rd"][v % 10] || "th"); };
