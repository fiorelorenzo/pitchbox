-- LI-16 (#313): the in-page LinkedIn assistant's accept path materialises an
-- accepted suggestion into a real drafts row. drafts.run_id is NOT NULL, so
-- rather than making that column nullable, accept creates a runs row of a
-- new kind = 'assist' (project-targeted, no campaign) to hang the draft off.
--
-- runs_kind_target_chk is not tracked by drizzle (schema.ts declares no
-- check() for it - see the historical-constraint-name warning in AGENTS.md),
-- so `migrate:generate` cannot diff it; this is hand-authored, following the
-- same DROP/ADD-with-the-real-name shape as every prior change to this
-- constraint (migrations_archive/0010, 0011, 0045-0048).
ALTER TABLE "runs" DROP CONSTRAINT IF EXISTS "runs_kind_target_chk";
ALTER TABLE "runs" ADD CONSTRAINT "runs_kind_target_chk"
  CHECK (
    (kind = 'campaign' AND campaign_id IS NOT NULL)
    OR (kind = 'project_extraction' AND project_id IS NOT NULL)
    OR (kind = 'campaign_skill_generation' AND campaign_id IS NOT NULL)
    OR (kind = 'draft_regeneration' AND project_id IS NOT NULL)
    OR (kind = 'reply_drafting' AND project_id IS NOT NULL)
    OR (kind = 'project_insights' AND project_id IS NOT NULL)
    OR (kind = 'assist' AND project_id IS NOT NULL)
  );
