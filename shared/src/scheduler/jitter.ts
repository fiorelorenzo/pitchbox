/**
 * Apply symmetric multiplicative jitter to a base delay.
 *
 * Returns a value uniformly sampled from [baseMs * (1 - p), baseMs * (1 + p)].
 * Used by the daemon to avoid thundering-herd polling when multiple loops
 * (or multiple daemon instances) align on the same cadence.
 *
 * @param baseMs - Base delay in milliseconds (must be >= 0).
 * @param p      - Jitter fraction in [0, 1]. Defaults to 0.1 (±10%).
 *                 Values outside [0, 1] are clamped.
 */
export function applyJitter(baseMs: number, p = 0.1): number {
  if (!Number.isFinite(baseMs) || baseMs <= 0) return baseMs;
  const clamped = Math.max(0, Math.min(1, p));
  if (clamped === 0) return baseMs;
  // Math.random() ∈ [0, 1) → factor ∈ [-1, 1)
  const factor = Math.random() * 2 - 1;
  return baseMs * (1 + factor * clamped);
}
