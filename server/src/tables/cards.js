/* Playing cards: a 52-card deck, a cryptographically random shuffle, and a Texas Hold'em hand evaluator.

   Cards are two-character strings: rank (2-9, T, J, Q, K, A) + suit (c, d, h, s), e.g. "As", "Td".

   Shuffle: Fisher–Yates driven by crypto.randomInt, which draws from the operating system's CSPRNG and rejects biased
   values, so all 52! orders are equally likely and nothing about one deck predicts the next. */
import crypto from "node:crypto";

export const RANKS = "23456789TJQKA";
export const SUITS = "cdhs";
export const DECK = Object.freeze([...SUITS].flatMap((s) => [...RANKS].map((r) => r + s)));

const rankOf = (c) => RANKS.indexOf(c[0]) + 2; // 2..14
const suitOf = (c) => c[1];

/* a new, shuffled deck. randInt(n) must return a uniform integer in [0, n). */
export function shuffledDeck(randInt = crypto.randomInt) {
  const d = DECK.slice();
  for (let i = d.length - 1; i > 0; i--) {
    const j = randInt(i + 1);
    [d[i], d[j]] = [d[j], d[i]];
  }
  return d;
}

export const CATEGORY = ["High card", "Pair", "Two pair", "Three of a kind", "Straight", "Flush", "Full house", "Four of a kind", "Straight flush"];

/* value of exactly five cards: [category, ...tie-breaking ranks], compared element by element (higher wins) */
export function eval5(cards) {
  const rs = cards.map(rankOf).sort((a, b) => b - a);
  const flush = cards.every((c) => suitOf(c) === suitOf(cards[0]));
  const uniq = [...new Set(rs)];
  let straightHigh = 0;
  if (uniq.length === 5) {
    if (uniq[0] - uniq[4] === 4) straightHigh = uniq[0];
    else if (uniq[0] === 14 && uniq[1] === 5 && uniq[4] === 2) straightHigh = 5; // A-2-3-4-5, the wheel
  }
  if (straightHigh && flush) return [8, straightHigh];
  const counts = new Map();
  for (const r of rs) counts.set(r, (counts.get(r) || 0) + 1);
  const groups = [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0]); // by count, then rank
  const shape = groups.map((g) => g[1]).join("");
  const order = groups.map((g) => g[0]);
  if (shape === "41") return [7, ...order];
  if (shape === "32") return [6, ...order];
  if (flush) return [5, ...rs];
  if (straightHigh) return [4, straightHigh];
  if (shape === "311") return [3, ...order];
  if (shape === "221") return [2, ...order];
  if (shape === "2111") return [1, ...order];
  return [0, ...rs];
}

export function compareValues(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] || 0) - (b[i] || 0);
    if (d) return d;
  }
  return 0;
}

/* the best five of up to seven cards → { value, cards (the five), name } */
export function bestHand(cards) {
  let best = null;
  const n = cards.length;
  const pick = (start, chosen) => {
    if (chosen.length === 5) {
      const value = eval5(chosen);
      if (!best || compareValues(value, best.value) > 0) best = { value, cards: chosen.slice() };
      return;
    }
    for (let i = start; i <= n - (5 - chosen.length); i++) { chosen.push(cards[i]); pick(i + 1, chosen); chosen.pop(); }
  };
  pick(0, []);
  return { ...best, name: handName(best.value) };
}

const RANK_NAME = { 2: "Two", 3: "Three", 4: "Four", 5: "Five", 6: "Six", 7: "Seven", 8: "Eight", 9: "Nine", 10: "Ten", 11: "Jack", 12: "Queen", 13: "King", 14: "Ace" };
const plural = (r) => (r === 6 ? "Sixes" : RANK_NAME[r] + "s");

export function handName(v) {
  switch (v[0]) {
    case 8: return v[1] === 14 ? "Royal flush" : `Straight flush, ${RANK_NAME[v[1]]} high`;
    case 7: return `Four of a kind, ${plural(v[1])}`;
    case 6: return `Full house, ${plural(v[1])} over ${plural(v[2])}`;
    case 5: return `Flush, ${RANK_NAME[v[1]]} high`;
    case 4: return `Straight, ${RANK_NAME[v[1]]} high`;
    case 3: return `Three of a kind, ${plural(v[1])}`;
    case 2: return `Two pair, ${plural(v[1])} and ${plural(v[2])}`;
    case 1: return `Pair of ${plural(v[1])}`;
    default: return `${RANK_NAME[v[1]]} high`;
  }
}
