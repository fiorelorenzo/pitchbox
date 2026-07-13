-- Drop the project_configs table. No code reads project-level configs anymore;
-- per-campaign config lives on campaigns.config and is the only consumed source.
DROP TABLE IF EXISTS "project_configs";
