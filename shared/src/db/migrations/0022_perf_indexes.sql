-- Composite indexes for the hottest dashboard queries:
--   Inbox lists drafts filtered by state + platform, sorted by createdAt.
--   Campaigns list orders by project + lastRunAt; projects page lists by org.
CREATE INDEX IF NOT EXISTS "drafts_state_platform_idx"
  ON "drafts" ("state", "platform_id", "created_at" DESC);

CREATE INDEX IF NOT EXISTS "drafts_account_created_idx"
  ON "drafts" ("account_id", "created_at" DESC);

CREATE INDEX IF NOT EXISTS "campaigns_project_idx"
  ON "campaigns" ("project_id");

CREATE INDEX IF NOT EXISTS "projects_org_idx"
  ON "projects" ("organization_id");

CREATE INDEX IF NOT EXISTS "runs_campaign_started_idx"
  ON "runs" ("campaign_id", "started_at" DESC);
