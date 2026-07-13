ALTER TABLE "contact_history" ADD COLUMN "replied_at" TIMESTAMPTZ;
ALTER TABLE "contact_history" ADD COLUMN "reply_checked_at" TIMESTAMPTZ;
CREATE INDEX "contact_history_reply_check_idx"
  ON "contact_history" ("reply_checked_at")
  WHERE "replied_at" IS NULL;
