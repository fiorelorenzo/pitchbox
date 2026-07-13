-- Move the Reddit-specific subreddit field off drafts. Backfill existing rows
-- into drafts.metadata.subreddit, then drop the column. Reddit playbooks
-- continue to emit `subreddit` in their CLI payload; cli/src/commands/drafts.ts
-- now writes it into metadata.
UPDATE "drafts"
SET "metadata" = jsonb_set(COALESCE("metadata", '{}'::jsonb), '{subreddit}', to_jsonb("subreddit"))
WHERE "subreddit" IS NOT NULL;

ALTER TABLE "drafts" DROP COLUMN "subreddit";
