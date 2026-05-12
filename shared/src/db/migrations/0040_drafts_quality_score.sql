ALTER TABLE "drafts" ADD COLUMN IF NOT EXISTS "quality_score" smallint;
ALTER TABLE "drafts" ADD COLUMN IF NOT EXISTS "quality_reason" text;
ALTER TABLE "drafts" ADD COLUMN IF NOT EXISTS "quality_model" text;
