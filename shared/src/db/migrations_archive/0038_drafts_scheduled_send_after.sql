ALTER TABLE "drafts" ADD COLUMN IF NOT EXISTS "scheduled_send_after" timestamp with time zone;
