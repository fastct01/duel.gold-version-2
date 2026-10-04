/* Who won a match of N players, derived only from the stored rows (score, forfeited) and the match's reason, so the very
   same functions settle a match and later describe it, including matches settled before multi-player lobbies existed.

   Player rows: { seat, score: number | null, forfeited: 0 | 1 }, ordered by seat.

   Rules
     - A forfeited player loses, whatever they submitted. A player who never submitted by the deadline loses too.
     - If forfeits leave exactly one player standing, that player wins (reason "forfeit") without needing a score.
     - Otherwise the winners are the non-forfeited players with the highest submitted score; several tied at the top
       are all winners and split the payout.
     - Everybody submitted the same score and nobody forfeited: draw. Nobody (still standing) submitted: void.        */

/* → { outcome: "win" | "draw" | "void", why, winners: seat[] }
   why: "forfeit" (forfeits left at most one standing) | "scores" (every player still standing submitted) | "timeout" (deadline,
   somebody still standing never submitted) | "no_result" */
export function decide(players) {
  const n = players.length;
  const alive = players.filter((p) => !p.forfeited);
  const scored = alive.filter((p) => p.score != null);
  if (alive.length < n && alive.length <= 1) {
    return alive.length === 1 ? { outcome: "win", why: "forfeit", winners: [alive[0].seat] } : { outcome: "void", why: "no_result", winners: [] };
  }
  if (!scored.length) return { outcome: "void", why: "no_result", winners: [] };
  if (alive.length === n && scored.length === n && scored.every((p) => p.score === scored[0].score)) return { outcome: "draw", why: "scores", winners: [] };
  const top = Math.max(...scored.map((p) => p.score));
  return { outcome: "win", why: alive.every((p) => p.score != null) ? "scores" : "timeout", winners: scored.filter((p) => p.score === top).map((p) => p.seat) };
}

/* How each player finished, as comparable keys (higher is better): their score; -Infinity for a forfeit or no score; and
   +Infinity for the one player left standing after forfeits, who wins even without a score. */
export function standings(players, reason) {
  const standing = players.filter((p) => !p.forfeited).length;
  const lone = reason === "forfeit" && standing === 1;
  return players.map((p) => (p.forfeited ? -Infinity : lone ? Infinity : p.score == null ? -Infinity : p.score));
}

/* competition ranking: 1 = best, ties share a place and the next place is skipped (1, 1, 3) */
export const placesOf = (keys) => keys.map((k) => 1 + keys.filter((o) => o > k).length);
