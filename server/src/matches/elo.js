/* Elo, K = 24 — same constants as the front-end (src/core/state.js) so ratings mean the same thing everywhere. */
export const K = 24;
export const START_RATING = 1200;

export const expected = (a, b) => 1 / (1 + Math.pow(10, (b - a) / 400));

/* Rating change for player A. score: 1 win, 0.5 draw, 0 loss. Player B's change is exactly the negative,
   so rating points are conserved (no rounding drift between the two players). */
export const delta = (ratingA, ratingB, score) => Math.round(K * (score - expected(ratingA, ratingB)));
