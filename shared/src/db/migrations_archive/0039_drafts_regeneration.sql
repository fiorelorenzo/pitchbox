ALTER TABLE "drafts" ADD COLUMN IF NOT EXISTS "regeneration_count" integer NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS "draft_regeneration_hints" (
  "id" bigserial PRIMARY KEY,
  "draft_id" integer NOT NULL REFERENCES "drafts"("id") ON DELETE CASCADE,
  "hint_text" text,
  "author_user_id" integer,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);
