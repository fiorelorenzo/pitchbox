-- Webhook delivery queue with retry + dead-letter support.
-- The webhook notifier writes a 'pending' row here instead of POSTing inline;
-- a daemon worker (daemon/src/webhook-sender.ts) picks rows up, attempts
-- delivery, and on failure increments `attempts` and schedules
-- `next_attempt_at` using shared/src/scheduler/backoff.ts (cap ~1h).
-- When attempts >= max_attempts, status flips to 'dead' (DLQ); operators can
-- re-enqueue from Settings → Notifications.
CREATE TABLE IF NOT EXISTS "webhook_deliveries" (
  "id" bigserial PRIMARY KEY,
  "webhook_id" text NOT NULL,
  "event_type" text NOT NULL,
  "payload" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "attempts" integer NOT NULL DEFAULT 0,
  "max_attempts" integer NOT NULL DEFAULT 8,
  "next_attempt_at" timestamptz NOT NULL DEFAULT now(),
  "status" text NOT NULL DEFAULT 'pending',
  "last_error" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "webhook_deliveries_due_idx"
  ON "webhook_deliveries" ("status", "next_attempt_at");

CREATE INDEX IF NOT EXISTS "webhook_deliveries_recent_idx"
  ON "webhook_deliveries" ("created_at" DESC);
