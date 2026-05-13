/**
 * Pure exponential-backoff helper used by the daemon scheduler.
 *
 * Returns the delay (in milliseconds) to wait before the next dispatch attempt,
 * given how many consecutive failures the campaign has accumulated. The schedule
 * follows `baseMs * 2^(attempts - 1)`, capped at `maxMs`.
 *
 * Examples (defaults: base = 60_000, max = 3_600_000):
 *   attempts = 0  → 0          (no failures yet → no delay)
 *   attempts = 1  → 60_000     (1 min)
 *   attempts = 2  → 120_000
 *   attempts = 3  → 240_000
 *   attempts = 6  → 1_920_000  (32 min)
 *   attempts = 7  → 3_600_000  (capped at 1 h)
 *   attempts = 99 → 3_600_000  (still capped)
 *
 * @param attempts - Consecutive failure count. Negative or non-finite values
 *                   are treated as 0.
 * @param opts.baseMs - First-failure delay. Default 60_000 (1 min).
 * @param opts.maxMs  - Hard ceiling on the returned delay. Default 3_600_000 (1 h).
 * @param opts.factor - Growth factor per attempt. Default 2.
 */
export interface BackoffOptions {
  baseMs?: number;
  maxMs?: number;
  factor?: number;
}

const DEFAULT_BASE_MS = 60_000;
const DEFAULT_MAX_MS = 3_600_000;
const DEFAULT_FACTOR = 2;

export function computeBackoff(attempts: number, opts: BackoffOptions = {}): number {
  if (!Number.isFinite(attempts) || attempts <= 0) return 0;
  const baseMs = opts.baseMs ?? DEFAULT_BASE_MS;
  const maxMs = opts.maxMs ?? DEFAULT_MAX_MS;
  const factor = opts.factor ?? DEFAULT_FACTOR;
  // Math.pow blows up quickly past ~30 attempts; clamping the exponent first
  // keeps the result finite even for absurd inputs (e.g. attempts = 1e9).
  const exp = Math.min(attempts - 1, 60);
  const raw = baseMs * Math.pow(factor, exp);
  if (!Number.isFinite(raw)) return maxMs;
  return Math.min(raw, maxMs);
}

/** Threshold at which a campaign is paused by the circuit breaker. */
export const FAILURE_PAUSE_THRESHOLD = 10;
