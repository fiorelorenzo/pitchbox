-- Reply auto-draft (#49): a flag pointing at the in-flight reply_drafting run.
ALTER TABLE "drafts" ADD COLUMN "drafting_run_id" integer REFERENCES "runs"("id") ON DELETE SET NULL;

-- Extend the run kind/target CHECK for reply_drafting (project_id always set;
-- campaign may be null), mirroring 0046's draft_regeneration branch.
ALTER TABLE "runs" DROP CONSTRAINT IF EXISTS "runs_kind_target_chk";
ALTER TABLE "runs" ADD CONSTRAINT "runs_kind_target_chk"
  CHECK (
    (kind = 'campaign' AND campaign_id IS NOT NULL)
    OR (kind = 'project_extraction' AND project_id IS NOT NULL)
    OR (kind = 'campaign_skill_generation' AND campaign_id IS NOT NULL)
    OR (kind = 'draft_regeneration' AND project_id IS NOT NULL)
    OR (kind = 'reply_drafting' AND project_id IS NOT NULL)
  );
