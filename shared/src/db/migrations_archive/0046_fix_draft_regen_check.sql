-- 0045 required campaign_id IS NOT NULL for the new 'draft_regeneration' run
-- kind, but startDraftRegeneration() inherits campaignId from the originating
-- run, which can be null (e.g. reply drafts have no campaign). Relax that
-- branch to require project_id instead, since drafts.projectId is always set.
ALTER TABLE "runs" DROP CONSTRAINT IF EXISTS "runs_kind_target_chk";
ALTER TABLE "runs" ADD CONSTRAINT "runs_kind_target_chk"
  CHECK (
    (kind = 'campaign' AND campaign_id IS NOT NULL)
    OR (kind = 'project_extraction' AND project_id IS NOT NULL)
    OR (kind = 'campaign_skill_generation' AND campaign_id IS NOT NULL)
    OR (kind = 'draft_regeneration' AND project_id IS NOT NULL)
  );
