ALTER TABLE "drafts" ADD COLUMN IF NOT EXISTS "variant_group_id" text;
ALTER TABLE "drafts" ADD COLUMN IF NOT EXISTS "variant_label" text;
CREATE INDEX IF NOT EXISTS "drafts_variant_group_idx" ON "drafts" ("variant_group_id");
