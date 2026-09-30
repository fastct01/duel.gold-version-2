/* In-memory token buckets. Fine for one process; a multi-instance deployment would move this to Redis or the edge. */
export class RateLimiter {
  /* `perMinute` tokens refill continuously; `burst` is the bucket size */
  constructor({ perMinute, burst = perMinute, now = () => Date.now() }) {
    this.rate = perMinute / 60000;
    this.burst = burst;
    this.now = now;
    this.buckets = new Map();
    this.lastSweep = now();
  }

  /* true if allowed */
  take(key, cost = 1) {
    const t = this.now();
    let b = this.buckets.get(key);
    if (!b) { b = { tokens: this.burst, at: t }; this.buckets.set(key, b); }
    b.tokens = Math.min(this.burst, b.tokens + (t - b.at) * this.rate);
    b.at = t;
    if (t - this.lastSweep > 60000) this.#sweep(t);
    if (b.tokens < cost) return false;
    b.tokens -= cost;
    return true;
  }

  /* seconds until a request would be allowed */
  retryAfter(key) {
    const b = this.buckets.get(key);
    return b ? Math.max(1, Math.ceil((1 - b.tokens) / this.rate / 1000)) : 1;
  }

  #sweep(t) {
    this.lastSweep = t;
    for (const [k, b] of this.buckets) if (t - b.at > 120000) this.buckets.delete(k);
  }
}
