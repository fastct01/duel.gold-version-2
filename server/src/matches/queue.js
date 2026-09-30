/* Pure matchmaking rules (no I/O, so they are easy to test).

   Players queue in a bucket keyed by game + stake (+ private code). Two players are paired when their ratings are
   within the wider of their two search windows. The window starts at ±ratingBase (60, as in the product spec) and
   widens ratingGrowthPerSec per second waited, up to ratingMax, so nobody waits forever for a perfect match.
   A private code skips the rating check: two friends who share a code always meet.                                 */
export const bucketKey = (t) => `${t.game}|${t.stake}|${t.code || ""}`;

export function windowFor(ticket, now, cfg) {
  const waited = Math.max(0, Math.floor((now - ticket.at) / 1000));
  return Math.min(cfg.ratingMax, cfg.ratingBase + waited * cfg.ratingGrowthPerSec);
}

/* Best partner for `ticket` among `others` (same bucket), or null. Never pairs a player with themselves. */
export function findPartner(ticket, others, now, cfg) {
  let best = null, bestDiff = Infinity;
  for (const o of others) {
    if (o === ticket || o.userId === ticket.userId) continue;
    const diff = Math.abs(o.rating - ticket.rating);
    if (!ticket.code && diff > Math.max(windowFor(o, now, cfg), windowFor(ticket, now, cfg))) continue;
    if (diff < bestDiff || (diff === bestDiff && o.at < best.at)) { best = o; bestDiff = diff; }
  }
  return best;
}
