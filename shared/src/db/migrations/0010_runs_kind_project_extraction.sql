ALTER TABLE "runs" ALTER COLUMN "campaign_id" DROP NOT NULL;
ALTER TABLE "runs" ADD COLUMN "kind" text DEFAULT 'campaign' NOT NULL;
ALTER TABLE "runs" ADD COLUMN "project_id" integer;
ALTER TABLE "runs" ADD COLUMN "params" jsonb DEFAULT '{}'::jsonb NOT NULL;
ALTER TABLE "runs" ADD CONSTRAINT "runs_project_id_projects_id_fk"
  FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE cascade;
CREATE INDEX "runs_project_kind_idx" ON "runs" ("project_id","kind","started_at" DESC);
ALTER TABLE "runs" ADD CONSTRAINT "runs_kind_target_chk"
  CHECK (
    (kind = 'campaign' AND campaign_id IS NOT NULL)
    OR (kind = 'project_extraction' AND project_id IS NOT NULL)
  );
