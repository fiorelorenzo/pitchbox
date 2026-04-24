-- Structurally prevent two concurrent "running" runs for the same campaign.
-- This backs up the application-level guard in runner.ts: even if two requests race
-- past the SELECT, Postgres will reject the second INSERT/UPDATE.

CREATE UNIQUE INDEX IF NOT EXISTS "runs_one_running_per_campaign"
  ON "runs" ("campaign_id")
  WHERE "status" = 'running';
