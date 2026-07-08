-- Project insights worker (#52): add the project_insights run kind (project-scoped).
ALTER TABLE "runs" DROP CONSTRAINT IF EXISTS "runs_kind_target_chk";
ALTER TABLE "runs" ADD CONSTRAINT "runs_kind_target_chk"
  CHECK (
    (kind = 'campaign' AND campaign_id IS NOT NULL)
    OR (kind = 'project_extraction' AND project_id IS NOT NULL)
    OR (kind = 'campaign_skill_generation' AND campaign_id IS NOT NULL)
    OR (kind = 'draft_regeneration' AND project_id IS NOT NULL)
    OR (kind = 'reply_drafting' AND project_id IS NOT NULL)
    OR (kind = 'project_insights' AND project_id IS NOT NULL)
  );
