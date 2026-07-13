-- Per-run token usage + cost. The legacy `tokens_used` column stays as the
-- aggregate (input+output) for back-compat; the columns added here are the
-- detailed split parsed from the runner's `usage` block, plus the USD cost
-- (either reported by the runner or derived from the token columns using the
-- runner's price table; see shared/src/runlog/parsers/claude-code.ts).
ALTER TABLE "runs"
  ADD COLUMN IF NOT EXISTS "input_tokens" integer,
  ADD COLUMN IF NOT EXISTS "output_tokens" integer,
  ADD COLUMN IF NOT EXISTS "cache_read_tokens" integer,
  ADD COLUMN IF NOT EXISTS "cache_creation_tokens" integer,
  ADD COLUMN IF NOT EXISTS "cost_usd" numeric(10, 4);
