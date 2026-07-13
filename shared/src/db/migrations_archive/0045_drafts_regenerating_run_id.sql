ALTER TABLE "drafts" ADD COLUMN "regenerating_run_id" integer REFERENCES "runs"("id") ON DELETE SET NULL;

-- Allow the new 'draft_regeneration' run kind through the kind/target check
-- constraint (same pattern as 0011 for campaign_skill_generation): a
-- draft_regeneration run always inherits its campaign from the originating run.
ALTER TABLE "runs" DROP CONSTRAINT "runs_kind_target_chk";
ALTER TABLE "runs" ADD CONSTRAINT "runs_kind_target_chk"
  CHECK (
    (kind = 'campaign' AND campaign_id IS NOT NULL)
    OR (kind = 'project_extraction' AND project_id IS NOT NULL)
    OR (kind = 'campaign_skill_generation' AND campaign_id IS NOT NULL)
    OR (kind = 'draft_regeneration' AND campaign_id IS NOT NULL)
  );
