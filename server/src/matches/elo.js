/* Elo, K = 24 — same constants as the front-end (src/core/state.js) so ratings mean the same thing everywhere. */
export const K = 24;
export const START_RATING = 1200;

export const expected = (a, b) => 1 / (1 + Math.pow(10, (b - a) / 400));

/* Rating change for player A. score: 1 win, 0.5 draw, 0 loss. Player B's change is exactly the negative,
   so rating points are conserved (no rounding drift between the two players). */
export const delta = (ratingA, ratingB, score) => Math.round(K * (score - expected(ratingA, ratingB)));

/* Rating changes for a match of any size, as pairwise Elo. `keys[i]` is how player i finished: higher is better, equal keys
   draw, and -Infinity marks a player with nothing to show (forfeited, or no score), who loses to everyone who has one and
   draws with other such players. Every pair (i, j) is rated with delta() — the same formula as a 1v1 — and the pairs are
   averaged: player i's change is the sum over opponents divided by (n - 1), rounded half away from zero.
   For n = 2 that is exactly delta(), with the second player getting the negative, so 1v1 ratings are unchanged.
   Each pair is rated once and credited ±, so before the final rounding the points are conserved; rounding the n totals
   can leave the sum of changes off by a point or two when n > 2. */
export function pairwiseDeltas(ratings, keys) {
  const n = ratings.length;
  const total = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const s = keys[i] > keys[j] ? 1 : keys[i] === keys[j] ? 0.5 : 0;
      const d = delta(ratings[i], ratings[j], s);
      total[i] += d;
      total[j] -= d;
    }
  }
  return total.map((t) => { const v = t / (n - 1); return (Math.sign(v) * Math.round(Math.abs(v))) || 0; }); // `|| 0`: never -0
}
