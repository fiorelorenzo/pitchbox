-- Structured taxonomy for run failures. Nullable; only set when status='failed'.
-- The valid value set lives in TypeScript (shared/src/runlog/classify-failure.ts)
-- to keep the schema flexible — no DB enum so we can grow the taxonomy without
-- a migration each time.
ALTER TABLE "runs"
  ADD COLUMN IF NOT EXISTS "failure_reason" text;
