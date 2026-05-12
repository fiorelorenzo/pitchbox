-- Daemon-scheduler backoff + circuit-breaker state on campaigns.
-- failure_attempts counts consecutive dispatch failures (reset to 0 on success).
-- next_attempt_after, when set, overrides the cron tick during backoff.
-- paused_due_to_failures trips after 10 consecutive failures so the scheduler
-- stops trying without losing the cron expression itself.
ALTER TABLE "campaigns"
  ADD COLUMN IF NOT EXISTS "failure_attempts" integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "next_attempt_after" timestamptz,
  ADD COLUMN IF NOT EXISTS "paused_due_to_failures" boolean NOT NULL DEFAULT false;
