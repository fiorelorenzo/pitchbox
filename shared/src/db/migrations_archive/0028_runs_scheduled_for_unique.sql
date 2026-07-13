-- Distributed-lock support for run dispatch.
-- `scheduled_for` records the cron tick a scheduled run was created for; the
-- partial UNIQUE index makes the database the final arbiter against
-- double-dispatch even if two schedulers (or a scheduler + a manual /api/run)
-- race past the advisory lock guard.
ALTER TABLE "runs"
  ADD COLUMN IF NOT EXISTS "scheduled_for" timestamptz;

CREATE UNIQUE INDEX IF NOT EXISTS "runs_campaign_scheduled_for_unique"
  ON "runs" ("campaign_id", "scheduled_for")
  WHERE "scheduled_for" IS NOT NULL AND "campaign_id" IS NOT NULL;
