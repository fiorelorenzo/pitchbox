/**
 * Minimal dependency-free, in-memory, fixed-window rate limiter.
 *
 * This is process-local state: correct as long as the prod web runs as a
 * single container (see docker-compose.app.prod.yml, no horizontal scaling
 * of the web service today). A multi-instance deployment would need a
 * shared store (e.g. Redis) instead, since each instance would keep its own
 * counters and an attacker could just spread requests across instances.
 *
 * `consume` is a single synchronous check-and-increment. Callers MUST call
 * it before any `await` in the request handler: because Node runs handler
 * code synchronously between awaits, a burst of concurrent requests for the
 * same key can never interleave inside `consume` itself, so they can't all
 * read the pre-increment count before any of them writes it back. A version
 * split into a separate check-then-record step (with an await in between)
 * would let a whole concurrent burst slip past the check before any of them
 * recorded an attempt.
 */
type Bucket = {
  count: number;
  windowStart: number;
};

export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  /**
   * Records one attempt for `key` and reports whether it is still within
   * the limit for the current fixed window. Returns `false` once `key` has
   * used up its budget for the window (the caller should reject/429).
   */
  // Cap on distinct keys before an opportunistic sweep runs. Bounds memory so
  // this public endpoint's limiter can't be turned into a memory-exhaustion
  // DoS by an attacker rotating source IPs (trivial over IPv6): expired buckets
  // are evicted once the map grows large, keeping it proportional to the number
  // of ACTIVE (within-window) keys rather than every key seen for the process
  // lifetime.
  private static readonly SWEEP_THRESHOLD = 10_000;

  consume(key: string, now = Date.now()): boolean {
    const bucket = this.buckets.get(key);
    if (!bucket || now - bucket.windowStart >= this.windowMs) {
      if (this.buckets.size >= RateLimiter.SWEEP_THRESHOLD) this.sweep(now);
      this.buckets.set(key, { count: 1, windowStart: now });
      return true;
    }
    if (bucket.count >= this.limit) return false;
    bucket.count += 1;
    return true;
  }

  /**
   * Drops expired buckets so the map doesn't grow unbounded over the
   * process lifetime. Not called automatically; invoke occasionally (e.g.
   * from a caller that already runs periodically) if a limiter sees many
   * distinct keys.
   */
  sweep(now = Date.now()): void {
    for (const [key, bucket] of this.buckets) {
      if (now - bucket.windowStart >= this.windowMs) this.buckets.delete(key);
    }
  }
}
