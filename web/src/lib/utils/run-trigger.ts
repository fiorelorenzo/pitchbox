// Allow-listed run triggers, extracted from the /api/run route so the pure
// normalization logic can be unit-tested directly. SvelteKit +server.ts route
// files may only export GET/POST/etc, so a shared helper cannot live there.
const ALLOWED_TRIGGERS = new Set(['manual', 'scheduled', 'api', 'keyword']);

// Normalize an inbound trigger to a known value, defaulting unknown/missing to
// 'manual'.
export function normalizeTrigger(raw: string | undefined): string {
  return raw && ALLOWED_TRIGGERS.has(raw) ? raw : 'manual';
}
