ALTER TABLE "drafts" ADD COLUMN "platform_comment_id" TEXT;
CREATE INDEX "drafts_platform_comment_idx"
  ON "drafts" ("platform_comment_id")
  WHERE "platform_comment_id" IS NOT NULL;
