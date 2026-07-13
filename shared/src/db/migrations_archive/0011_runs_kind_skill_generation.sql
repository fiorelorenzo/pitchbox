ALTER TABLE "runs" DROP CONSTRAINT "runs_kind_target_chk";
ALTER TABLE "runs" ADD CONSTRAINT "runs_kind_target_chk"
  CHECK (
    (kind = 'campaign' AND campaign_id IS NOT NULL)
    OR (kind = 'project_extraction' AND project_id IS NOT NULL)
    OR (kind = 'campaign_skill_generation' AND campaign_id IS NOT NULL)
  );
