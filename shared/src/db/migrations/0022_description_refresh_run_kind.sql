-- #434: a proposed re-derivation of a project's description after its
-- sources changed (or the decision on one) is recorded as a runs row of a
-- new kind = 'project_description_refresh' (project-targeted, no campaign) -
-- see shared/src/project-description-refresh.ts. No model call and no new
-- table: the proposal itself is computed on demand from projects.description
-- and the active project_sources set, and only a decision (accept/decline)
-- is ever persisted, in runs.params.
--
-- runs_kind_target_chk is not tracked by drizzle (schema.ts declares no
-- check() for it - see the historical-constraint-name warning in AGENTS.md),
-- so `migrate:generate` cannot diff it; this is hand-authored, following the
-- same DROP/ADD-with-the-real-name shape as every prior change to this
-- constraint (migrations_archive/0010, 0011, 0045-0048, 0013).
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
    OR (kind = 'project_description_refresh' AND project_id IS NOT NULL)
  );
