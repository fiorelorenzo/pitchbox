ALTER TABLE "drafts" ADD COLUMN IF NOT EXISTS "body_edited" boolean NOT NULL DEFAULT false;
