/* Chess between two players, refereed by the server.

   The server holds the game: every move is checked against the full rules (chess.js: castling, en passant, promotion,
   check), and the server keeps both clocks. A player's clock runs from the moment the previous move was accepted until
   theirs is; the increment is added after each move. Running out of time loses, unless the opponent has no mating
   material left (then it is a draw). Checkmate wins; stalemate, threefold repetition, the 50-move rule, insufficient
   material and an accepted draw offer are draws.

   The state is plain JSON (the moves in UCI form, the clocks), so the match service can store it and rebuild the game
   after a restart. Same interface as poker.js. */
import crypto from "node:crypto";
import { Chess } from "chess.js";
import { AppError } from "../util/errors.js";

export const DEFAULTS = {
  baseMs: 5 * 60_000, // 5 minutes each
  incMs: 3_000,       // + 3 seconds per move
};

const illegal = (msg) => new AppError("ILLEGAL_MOVE", msg, 409);
const games = new WeakMap(); // state → live Chess object (rebuilt from the moves when missing)

function game(s) {
  let g = games.get(s);
  if (!g) {
    g = new Chess();
    for (const m of s.moves) g.move({ from: m.slice(0, 2), to: m.slice(2, 4), promotion: m[4] || undefined });
    games.set(s, g);
  }
  return g;
}

export function create({ n, now, randInt = crypto.randomInt, opts = {} }) {
  if (n !== 2) throw new Error("chess needs exactly two players");
  const o = { ...DEFAULTS, ...opts };
  return { kind: "chess", o, white: randInt(2), moves: [], san: [], clock: [o.baseMs, o.baseMs], turnStart: now, drawOffer: null, result: null };
}

const seatOf = (s, color) => (color === "w" ? s.white : 1 - s.white);
const colorOf = (s, seat) => (seat === s.white ? "w" : "b");
export const toMove = (s) => seatOf(s, game(s).turn());

/* time left on each clock at `now` (only the clock of the side to move is running) */
export function clocks(s, now) {
  const c = s.clock.slice();
  if (!s.result) { const t = toMove(s); c[t] = Math.max(0, c[t] - Math.max(0, now - s.turnStart)); }
  return c;
}

/* can this side still deliver mate in any way? A lone king, or king and one minor piece, cannot. */
function canMate(g, color) {
  const pieces = g.board().flat().filter((p) => p && p.color === color && p.type !== "k").map((p) => p.type);
  if (!pieces.length) return false;
  if (pieces.length === 1 && (pieces[0] === "n" || pieces[0] === "b")) return false;
  return true;
}

function end(s, winner, reason) {
  s.result = { winner, reason };
  s.drawOffer = null;
}

function afterMove(s) {
  const g = game(s);
  if (g.isCheckmate()) return end(s, 1 - toMove(s), "checkmate");
  if (g.isStalemate()) return end(s, null, "stalemate");
  if (g.isInsufficientMaterial()) return end(s, null, "insufficient");
  if (g.isThreefoldRepetition()) return end(s, null, "repetition");
  if (g.isDrawByFiftyMoves()) return end(s, null, "fifty_moves");
}

/* action: { type: "move", from, to, promotion? } | { type: "draw-offer" } | { type: "draw-accept" } | { type: "draw-decline" } */
export function act(s, seat, action, now) {
  if (s.result) throw illegal("This game is over.");
  const type = action && action.type;
  if (type === "move") {
    if (now < s.turnStart && s.moves.length === 0) throw new AppError("TOO_EARLY", "The game has not started yet.", 409);
    if (toMove(s) !== seat) throw illegal("It is not your turn.");
    const left = s.clock[seat] - Math.max(0, now - s.turnStart);
    if (left <= 0) { flag(s, seat); return; }
    const from = String(action.from || ""), to = String(action.to || "");
    if (!/^[a-h][1-8]$/.test(from) || !/^[a-h][1-8]$/.test(to)) throw illegal("That is not a square.");
    const promotion = action.promotion == null ? undefined : String(action.promotion).toLowerCase();
    if (promotion !== undefined && !["q", "r", "b", "n"].includes(promotion)) throw illegal("Promote to a queen, rook, bishop or knight.");
    const g = game(s);
    let mv;
    try { mv = g.move({ from, to, promotion }); } catch { mv = null; }
    if (!mv) throw illegal("That move is not allowed.");
    s.moves.push(mv.from + mv.to + (mv.promotion || ""));
    s.san.push(mv.san);
    s.clock[seat] = left + s.o.incMs;
    s.turnStart = now;
    if (s.drawOffer != null && s.drawOffer !== seat) s.drawOffer = null; // moving instead of answering declines the offer
    afterMove(s);
    return;
  }
  if (type === "draw-offer") {
    if (s.drawOffer === seat) return;
    if (s.drawOffer === 1 - seat) return end(s, null, "agreement"); // both offered: agreed
    s.drawOffer = seat;
    return;
  }
  if (type === "draw-accept") {
    if (s.drawOffer !== 1 - seat) throw illegal("There is no draw offer to accept.");
    return end(s, null, "agreement");
  }
  if (type === "draw-decline") {
    if (s.drawOffer === 1 - seat) s.drawOffer = null;
    return;
  }
  throw illegal("Unknown action.");
}

function flag(s, seat) {
  s.clock[seat] = 0;
  const other = 1 - seat;
  if (!canMate(game(s), colorOf(s, other))) return end(s, null, "timeout_insufficient");
  end(s, other, "timeout");
}

export function deadline(s) {
  if (s.result) return null;
  const t = toMove(s);
  return s.turnStart + s.clock[t];
}

export function onTimer(s, now) {
  if (s.result) return;
  const t = toMove(s);
  if (now - s.turnStart >= s.clock[t]) flag(s, t);
}

export function forfeit(s, seat) {
  if (!s.result) end(s, 1 - seat, "resign");
}

/* the hard cap (never reached with these clocks): a draw */
export function finishNow(s) {
  if (!s.result) end(s, null, "time_cap");
}

export function result(s) {
  if (!s.result) return null;
  const { winner, reason } = s.result;
  return { scores: [0, 1].map((seat) => (winner == null ? 0.5 : winner === seat ? 1 : 0)), reason };
}

export function shift(s, ms) { s.turnStart += ms; }

export function view(s, seat, now) {
  const g = game(s);
  const turn = toMove(s);
  const last = s.moves.length ? s.moves[s.moves.length - 1] : null;
  let kingInCheck = null;
  if (g.inCheck()) {
    const color = g.turn();
    for (const row of g.board()) for (const p of row) if (p && p.type === "k" && p.color === color) kingInCheck = p.square;
  }
  const mine = seat != null && turn === seat && !s.result;
  return {
    kind: "chess", you: seat, color: seat == null ? null : colorOf(s, seat), white: s.white,
    fen: g.fen(), turn, moveNumber: Math.floor(s.moves.length / 2) + 1, plies: s.moves.length,
    legal: mine ? g.moves({ verbose: true }).map((m) => m.from + m.to + (m.promotion || "")) : [],
    lastMove: last ? { from: last.slice(0, 2), to: last.slice(2, 4) } : null,
    check: kingInCheck,
    clocks: clocks(s, now), running: s.result ? null : turn, startsAt: s.moves.length === 0 ? s.turnStart : null,
    base: s.o.baseMs, inc: s.o.incMs,
    drawOffer: s.drawOffer, san: s.san.slice(), result: s.result,
  };
}

export function capMs(_n, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  return 2 * o.baseMs + 400 * o.incMs + 5 * 60_000; // far beyond any real game: both clocks plus 200 moves of increment each
}
