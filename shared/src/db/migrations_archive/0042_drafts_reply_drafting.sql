ALTER TABLE "drafts" ADD COLUMN IF NOT EXISTS "parent_message_id" bigint;
CREATE INDEX IF NOT EXISTS "drafts_parent_message_idx" ON "drafts" ("parent_message_id");
