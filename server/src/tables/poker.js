/* No-limit Texas Hold'em, freezeout: every player starts with the same stack of chips; blinds rise on a clock; a player
   with no chips left is out; the last player holding chips wins the match (and the pot of stakes, settled by the match
   service). Chips are only for this table and are never money.

   The server is the dealer. Each hand gets a fresh deck shuffled with crypto.randomInt (cards.js). Before any card is
   dealt the table publishes commit = sha256(deck + ":" + salt); when the hand ends it reveals the deck and the salt, so
   every player can check the cards came from that deck, in that order, fixed before the first action.

   Nothing in the state is sent as is: view(state, seat) builds what one seat may see. The deck, the salt before the hand
   ends, and other players' hole cards (unless shown down) never leave the server.

   Interface (shared with chess.js; see tables/index.js): create, view, act, onTimer, deadline, forfeit, finishNow,
   result, shift. The state is plain JSON, so the match service can store it and restore it after a restart. */
import crypto from "node:crypto";
import { AppError } from "../util/errors.js";
import { bestHand, compareValues, shuffledDeck } from "./cards.js";

export const LEVELS = [
  [10, 20], [15, 30], [25, 50], [50, 100], [75, 150], [100, 200], [150, 300], [200, 400], [300, 600], [400, 800],
  [600, 1200], [800, 1600], [1000, 2000], [1500, 3000], [2000, 4000], [3000, 6000], [5000, 10000], [8000, 16000],
];

export const DEFAULTS = {
  startStack: 1500,
  levelMs: 3 * 60_000,     // blinds go up every 3 minutes
  actionMs: 25_000,        // time to act
  awayActionMs: 4_000,     // after two timeouts in a row a player is "away" and gets this long instead
  showdownPauseMs: 5_000,  // the cards stay on the table this long before the next hand
  foldPauseMs: 2_000,
  capMs: 90 * 60_000,      // a hard stop: the match is decided by chip counts if it ever runs this long
};

const illegal = (msg) => new AppError("ILLEGAL_ACTION", msg, 409);
const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");

/* ------------------------------------------------------------------ setup */

export function create({ n, now, randInt = crypto.randomInt, opts = {} }) {
  const o = { ...DEFAULTS, ...opts };
  const s = {
    kind: "poker", n, o, startedAt: now, handNo: 0, outCount: 0, button: randInt(n), result: null, nextHandAt: null,
    players: Array.from({ length: n }, (_, seat) => ({ seat, stack: o.startStack, out: false, outOrder: null, away: false, timeouts: 0 })),
    hand: null, last: null,
  };
  startHand(s, now, randInt);
  return s;
}

const alive = (s) => s.players.filter((p) => !p.out).map((p) => p.seat);
/* the next seat after `from`, going round the table, that passes `ok` */
function nextSeat(s, from, ok) {
  for (let i = 1; i <= s.n; i++) { const seat = (from + i) % s.n; if (ok(seat)) return seat; }
  return null;
}
export const levelAt = (s, now) => {
  const i = Math.min(LEVELS.length - 1, Math.max(0, Math.floor((now - s.startedAt) / s.o.levelMs)));
  return { index: i, sb: LEVELS[i][0], bb: LEVELS[i][1], nextAt: i < LEVELS.length - 1 ? s.startedAt + (i + 1) * s.o.levelMs : null };
};

function startHand(s, now, randInt = crypto.randomInt) {
  const seats = alive(s);
  if (seats.length <= 1) return finish(s, "last_standing");
  if (s.handNo > 0) s.button = nextSeat(s, s.button, (x) => !s.players[x].out);
  else if (s.players[s.button].out) s.button = nextSeat(s, s.button, (x) => !s.players[x].out);
  s.handNo += 1;
  const lv = levelAt(s, now);
  const deck = shuffledDeck(randInt);
  const salt = crypto.randomBytes(16).toString("hex");
  const headsUp = seats.length === 2;
  const sbSeat = headsUp ? s.button : nextSeat(s, s.button, (x) => !s.players[x].out);
  const bbSeat = nextSeat(s, sbSeat, (x) => !s.players[x].out);
  const z = () => Array(s.n).fill(0);
  const h = s.hand = {
    no: s.handNo, sb: lv.sb, bb: lv.bb, deck, pos: 0, salt, commit: sha256(deck.join("") + ":" + salt),
    board: [], holes: Array(s.n).fill(null), street: "preflop",
    bets: z(), contrib: z(), folded: Array(s.n).fill(false), allIn: Array(s.n).fill(false), acted: Array(s.n).fill(false),
    canRaise: Array(s.n).fill(true), lastAction: Array(s.n).fill(null), inHand: Array(s.n).fill(false),
    startStacks: s.players.map((p) => p.stack),
    currentBet: 0, minRaise: lv.bb, toAct: null, actionDeadline: null, sbSeat, bbSeat, log: [],
  };
  for (const seat of seats) h.inHand[seat] = true;
  s.nextHandAt = null;
  // deal two cards each, one at a time, starting left of the button (the way a dealer does)
  for (let round = 0; round < 2; round++) {
    let seat = s.button;
    for (let k = 0; k < seats.length; k++) {
      seat = nextSeat(s, seat, (x) => h.inHand[x]);
      (h.holes[seat] ||= []).push(h.deck[h.pos++]);
    }
  }
  post(s, sbSeat, lv.sb, "Small blind");
  post(s, bbSeat, lv.bb, "Big blind");
  h.currentBet = lv.bb; // everyone must at least call the full big blind, even if the big blind is short
  h.minRaise = lv.bb;
  log(s, `Hand ${h.no} · blinds ${lv.sb}/${lv.bb}`);
  const first = headsUp ? sbSeat : nextSeat(s, bbSeat, (x) => h.inHand[x]);
  setTurn(s, first, now, true);
}

function post(s, seat, amount, label) {
  const h = s.hand, p = s.players[seat];
  const a = Math.min(amount, p.stack);
  p.stack -= a; h.bets[seat] += a; h.contrib[seat] += a;
  if (p.stack === 0) h.allIn[seat] = true;
  h.lastAction[seat] = `${label} ${a}`;
}

function log(s, text) {
  const h = s.hand;
  h.log.push(text);
  if (h.log.length > 40) h.log.shift();
}

/* ------------------------------------------------------------------ betting */

const canAct = (h, seat) => h.inHand[seat] && !h.folded[seat] && !h.allIn[seat];
const needsAction = (h, seat) => canAct(h, seat) && (!h.acted[seat] || h.bets[seat] < h.currentBet);

/* hand the turn to `from` if it needs to act, or to the next seat that does; close the round when nobody does */
function setTurn(s, from, now, inclusive = false) {
  const h = s.hand;
  const live = h.inHand.map((x, seat) => x && !h.folded[seat]).reduce((a, x, seat) => (x ? [...a, seat] : a), []);
  if (live.length === 1) return endHand(s, now);
  const actors = live.filter((seat) => !h.allIn[seat]);
  // one player left who can act and nothing to call: nobody can bet against them
  const closed = actors.length === 0 || (actors.length === 1 && h.bets[actors[0]] >= Math.max(...live.map((x) => h.bets[x])));
  if (!closed) {
    const seat = inclusive && needsAction(h, from) ? from : nextSeat(s, from, (x) => needsAction(h, x));
    if (seat != null) {
      h.toAct = seat;
      const p = s.players[seat];
      h.actionDeadline = now + (p.away ? s.o.awayActionMs : s.o.actionMs);
      return;
    }
  }
  nextStreet(s, now);
}

function nextStreet(s, now) {
  const h = s.hand;
  h.toAct = null; h.actionDeadline = null;
  for (let i = 0; i < s.n; i++) { h.bets[i] = 0; h.acted[i] = false; h.canRaise[i] = true; if (!h.folded[i] && !h.allIn[i]) h.lastAction[i] = null; }
  h.currentBet = 0; h.minRaise = h.bb;
  const deal = (k) => { h.pos++; for (let i = 0; i < k; i++) h.board.push(h.deck[h.pos++]); }; // burn one, then deal
  if (h.street === "preflop") { deal(3); h.street = "flop"; }
  else if (h.street === "flop") { deal(1); h.street = "turn"; }
  else if (h.street === "turn") { deal(1); h.street = "river"; }
  else return showdown(s, now);
  log(s, `${h.street[0].toUpperCase() + h.street.slice(1)}: ${h.board.join(" ")}`);
  setTurn(s, s.button, now); // first to act after the flop: the first live seat left of the button
}

/* what the player to act may do */
export function legal(s, seat) {
  const h = s.hand;
  if (!h || h.toAct !== seat || s.result) return null;
  const p = s.players[seat];
  const toCall = Math.max(0, h.currentBet - h.bets[seat]);
  const call = Math.min(toCall, p.stack);
  const maxTo = h.bets[seat] + p.stack;
  const others = h.inHand.some((x, i) => x && i !== seat && !h.folded[i] && !h.allIn[i]);
  const canRaise = h.canRaise[seat] && others && p.stack > toCall;
  const minTo = Math.min(maxTo, h.currentBet + h.minRaise);
  return { fold: toCall > 0, check: toCall === 0, call, toCall, raise: canRaise ? { min: minTo, max: maxTo } : null, bet: h.currentBet === 0, stack: p.stack };
}

/* action: { type: "fold" | "check" | "call" | "raise" | "allin", to?: total bet for this street after a raise } */
export function act(s, seat, action, now) {
  if (s.result) throw illegal("This game is over.");
  const h = s.hand;
  if (!h || h.street === "done") throw illegal("Wait for the next hand.");
  if (h.toAct !== seat) throw illegal("It is not your turn.");
  const L = legal(s, seat);
  const p = s.players[seat];
  const type = action && action.type;
  if (type === "fold") {
    h.folded[seat] = true; h.lastAction[seat] = "Fold"; log(s, `Seat ${seat + 1} folds`);
  } else if (type === "check") {
    if (!L.check) throw illegal(`You have to call ${L.toCall} or fold.`);
    h.lastAction[seat] = "Check"; log(s, `Seat ${seat + 1} checks`);
  } else if (type === "call") {
    if (L.toCall === 0) throw illegal("There is nothing to call. Check instead.");
    pay(s, seat, L.call);
    h.lastAction[seat] = h.allIn[seat] ? `All-in ${h.bets[seat]}` : `Call ${L.call}`;
    log(s, `Seat ${seat + 1} calls ${L.call}`);
  } else if (type === "raise" || type === "allin") {
    if (!L.raise) {
      if (type === "allin" && L.toCall > 0) return act(s, seat, { type: "call" }, now); // all-in for no more than the call
      throw illegal("You cannot raise here.");
    }
    const to = type === "allin" ? L.raise.max : Math.floor(Number(action.to));
    if (!Number.isFinite(to)) throw illegal("Say how much to raise to.");
    if (to > L.raise.max) throw illegal(`You can raise to at most ${L.raise.max}.`);
    if (to < L.raise.min) throw illegal(`The smallest raise is to ${L.raise.min}.`);
    const increment = to - h.currentBet;
    pay(s, seat, to - h.bets[seat]);
    if (increment >= h.minRaise) { // a full raise reopens the betting for everyone
      h.minRaise = increment;
      for (let i = 0; i < s.n; i++) if (i !== seat) h.canRaise[i] = true;
    } else { // a short all-in: players who already acted may only call or fold
      for (let i = 0; i < s.n; i++) if (i !== seat && h.acted[i]) h.canRaise[i] = false;
    }
    h.currentBet = to;
    for (let i = 0; i < s.n; i++) if (i !== seat) h.acted[i] = false;
    h.lastAction[seat] = h.allIn[seat] ? `All-in ${to}` : `${L.bet ? "Bet" : "Raise to"} ${to}`;
    log(s, `Seat ${seat + 1} ${L.bet ? "bets" : "raises to"} ${to}${h.allIn[seat] ? " (all-in)" : ""}`);
  } else {
    throw illegal("Unknown action.");
  }
  h.acted[seat] = true;
  p.timeouts = 0; p.away = false;
  setTurn(s, seat, now);
}

function pay(s, seat, amount) {
  const h = s.hand, p = s.players[seat];
  const a = Math.min(amount, p.stack);
  p.stack -= a; h.bets[seat] += a; h.contrib[seat] += a;
  if (p.stack === 0) h.allIn[seat] = true;
}

/* ------------------------------------------------------------------ end of a hand */

function showdown(s, now) {
  const h = s.hand;
  while (h.board.length < 5) { h.pos++; h.board.push(h.deck[h.pos++]); } // everyone all-in before the river: run the board out
  endHand(s, now, true);
}

/* the pots, built from what every player put in: [{ amount, eligible: seat[] }] (main pot first) */
export function buildPots(contrib, folded) {
  const rem = contrib.slice();
  const pots = [];
  for (;;) {
    const elig = rem.map((c, i) => (c > 0 && !folded[i] ? i : -1)).filter((i) => i >= 0);
    const left = rem.reduce((a, c) => a + c, 0);
    if (!left) break;
    if (!elig.length) { if (pots.length) pots[pots.length - 1].amount += left; break; }
    const m = Math.min(...elig.map((i) => rem[i]));
    let amount = 0;
    for (let i = 0; i < rem.length; i++) { const t = Math.min(rem[i], m); rem[i] -= t; amount += t; }
    const last = pots[pots.length - 1];
    if (last && last.eligible.join() === elig.join()) last.amount += amount;
    else pots.push({ amount, eligible: elig });
  }
  return pots;
}

function endHand(s, now, toShowdown = false) {
  const h = s.hand;
  const live = h.inHand.map((x, seat) => (x && !h.folded[seat] ? seat : -1)).filter((x) => x >= 0);
  // an uncalled bet goes back to whoever made it
  const top = Math.max(...h.contrib), second = Math.max(0, ...h.contrib.filter((_, i) => i !== h.contrib.indexOf(top)));
  const topSeat = h.contrib.indexOf(top);
  if (top > second && !h.folded[topSeat]) { const back = top - second; h.contrib[topSeat] -= back; s.players[topSeat].stack += back; if (h.allIn[topSeat] && s.players[topSeat].stack > 0) h.allIn[topSeat] = false; }

  const won = Array(s.n).fill(0);
  const shown = {};
  const hands = {};
  let pots;
  if (live.length === 1) {
    const total = h.contrib.reduce((a, c) => a + c, 0);
    won[live[0]] = total;
    pots = [{ amount: total, eligible: live, winners: live, hand: null }];
    log(s, `Seat ${live[0] + 1} wins ${total}`);
  } else {
    for (const seat of live) { hands[seat] = bestHand([...h.holes[seat], ...h.board]); shown[seat] = h.holes[seat]; }
    pots = buildPots(h.contrib, h.folded);
    for (const pot of pots) {
      let best = null, winners = [];
      for (const seat of pot.eligible) {
        const c = best ? compareValues(hands[seat].value, best) : 1;
        if (c > 0) { best = hands[seat].value; winners = [seat]; } else if (c === 0) winners.push(seat);
      }
      // equal shares; an odd chip goes to the first winner left of the button
      const share = Math.floor(pot.amount / winners.length);
      let odd = pot.amount - share * winners.length;
      for (const seat of winners) won[seat] += share;
      for (let seat = nextSeat(s, s.button, () => true), k = 0; odd > 0 && k < s.n; seat = (seat + 1) % s.n, k++) {
        if (winners.includes(seat)) { won[seat] += 1; odd -= 1; }
      }
      pot.winners = winners;
      pot.hand = hands[winners[0]].name;
      log(s, `Seat ${winners.map((w) => w + 1).join(", seat ")} ${winners.length > 1 ? "split" : "wins"} ${pot.amount} with ${pot.hand}`);
    }
  }
  for (let i = 0; i < s.n; i++) s.players[i].stack += won[i];

  // players with no chips are out; several out in the same hand: the bigger stack at the start of the hand places higher
  const busted = s.players.filter((p) => h.inHand[p.seat] && p.stack === 0 && !p.out).sort((a, b) => h.startStacks[a.seat] - h.startStacks[b.seat]);
  for (const p of busted) { p.out = true; p.outOrder = ++s.outCount; }

  s.last = {
    no: h.no, board: h.board.slice(), pots: pots.map((p) => ({ amount: p.amount, winners: p.winners, hand: p.hand })),
    won, shown, hands: Object.fromEntries(Object.entries(hands).map(([k, v]) => [k, { name: v.name, cards: v.cards }])),
    showdown: toShowdown && live.length > 1, out: busted.map((p) => p.seat),
    reveal: { deck: h.deck.join(" "), salt: h.salt, commit: h.commit },
  };
  h.street = "done"; h.toAct = null; h.actionDeadline = null;
  if (alive(s).length <= 1) return finish(s, "last_standing");
  s.nextHandAt = now + (s.last.showdown ? s.o.showdownPauseMs : s.o.foldPauseMs);
}

function finish(s, reason) {
  s.result = { reason };
  if (s.hand) { s.hand.toAct = null; s.hand.actionDeadline = null; }
  s.nextHandAt = null;
}

/* ------------------------------------------------------------------ clock */

/* the next moment the table must do something by itself, or null */
export function deadline(s) {
  if (s.result) return null;
  if (s.hand && s.hand.street === "done") return s.nextHandAt;
  return s.hand ? s.hand.actionDeadline : null;
}

/* time passed: start the next hand, or act for a player who ran out of time (check if free, otherwise fold) */
export function onTimer(s, now) {
  if (s.result) return;
  const h = s.hand;
  if (h.street === "done") { if (now >= s.nextHandAt) startHand(s, now); return; }
  if (h.toAct == null || now < h.actionDeadline) return;
  const seat = h.toAct, p = s.players[seat];
  const L = legal(s, seat);
  const timeouts = p.timeouts + 1;
  act(s, seat, { type: L.check ? "check" : "fold" }, now);
  p.timeouts = timeouts;
  if (timeouts >= 2) p.away = true;
  h.lastAction[seat] = L.check ? "Check (time)" : "Fold (time)";
}

/* a player leaves for good (forfeit): folds now if in a hand, and the chips in front of them leave the table with them.
   What they already put in this hand stays in the pot. */
export function forfeit(s, seat, now) {
  if (s.result) return;
  const p = s.players[seat];
  if (p.out) return;
  const h = s.hand;
  p.out = true; p.outOrder = ++s.outCount; p.stack = 0;
  if (h && h.street !== "done" && h.inHand[seat] && !h.folded[seat]) {
    h.folded[seat] = true; h.lastAction[seat] = "Left";
    const live = h.inHand.filter((x, i) => x && !h.folded[i]).length;
    if (live === 1) endHand(s, now);
    else if (h.toAct === seat) setTurn(s, seat, now);
    else if (h.toAct == null) setTurn(s, s.button, now);
    return;
  }
  if (alive(s).length <= 1) finish(s, "last_standing");
}

/* the match must end now (the hard time cap): the hand in play is called off, everyone gets back what they put in it */
export function finishNow(s) {
  if (s.result) return;
  const h = s.hand;
  if (h && h.street !== "done") for (let i = 0; i < s.n; i++) { s.players[i].stack += h.contrib[i]; h.contrib[i] = 0; }
  finish(s, "time_cap");
}

/* scores for the match service: higher is better. The winner (or everyone still in at the cap, by chips) above anyone out;
   those who went out rank by when they went out. */
export function result(s) {
  if (!s.result) return null;
  const scores = s.players.map((p) => (p.out ? p.outOrder : 1_000_000 + p.stack));
  return { scores, reason: s.result.reason === "time_cap" ? "chips" : "last_standing" };
}

/* the server was down for `ms`: move every clock forward so nobody loses time to it */
export function shift(s, ms) {
  s.startedAt += ms;
  if (s.nextHandAt != null) s.nextHandAt += ms;
  if (s.hand && s.hand.actionDeadline != null) s.hand.actionDeadline += ms;
}

/* ------------------------------------------------------------------ what one seat sees */

export function view(s, seat, now) {
  const h = s.hand;
  const done = !h || h.street === "done" || !!s.result;
  const lv = levelAt(s, now);
  const players = s.players.map((p) => {
    const i = p.seat;
    const inHand = !!(h && h.inHand[i]);
    let cards = null;
    if (inHand && i === seat) cards = h.holes[i];
    else if (inHand && done && s.last && s.last.no === h.no && s.last.shown[i]) cards = s.last.shown[i]; // shown down
    return {
      seat: i, stack: p.stack, out: p.out, away: p.away,
      bet: h && !done ? h.bets[i] : 0,
      inHand, folded: !!(h && h.folded[i]), allIn: !!(h && h.allIn[i]),
      action: h ? h.lastAction[i] : null,
      cards, hasCards: inHand && !(h && h.folded[i]),
    };
  });
  return {
    kind: "poker", you: seat, handNo: s.handNo, button: s.button,
    sbSeat: h ? h.sbSeat : null, bbSeat: h ? h.bbSeat : null,
    blinds: { sb: h ? h.sb : lv.sb, bb: h ? h.bb : lv.bb, next: lv.nextAt != null ? { sb: LEVELS[lv.index + 1][0], bb: LEVELS[lv.index + 1][1], at: lv.nextAt } : null },
    street: h ? h.street : null, board: h ? h.board.slice() : [],
    pot: h ? h.contrib.reduce((a, c) => a + c, 0) : 0,
    currentBet: h && !done ? h.currentBet : 0,
    toAct: h ? h.toAct : null, actionDeadline: h ? h.actionDeadline : null,
    legal: seat != null ? legal(s, seat) : null,
    commit: h ? h.commit : null,
    nextHandAt: s.nextHandAt,
    last: s.last, // the previous (or just finished) hand: pots, winners, shown cards, and its deck + salt for checking
    players, log: h ? h.log.slice(-12) : [],
    over: !!s.result, startStack: s.o.startStack,
  };
}

export function capMs(_n, opts = {}) { return { ...DEFAULTS, ...opts }.capMs; }
