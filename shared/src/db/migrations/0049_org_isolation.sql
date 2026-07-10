-- Organization isolation: store the active org on sessions, make projects
-- org-owned (backfill legacy null-org projects to the default org), and make
-- project slugs unique per organization instead of globally.
ALTER TABLE "sessions" ADD COLUMN "active_organization_id" integer REFERENCES "organizations"("id") ON DELETE SET NULL;
UPDATE "projects" SET "organization_id" = (SELECT "id" FROM "organizations" WHERE "slug" = 'default') WHERE "organization_id" IS NULL;
ALTER TABLE "projects" ALTER COLUMN "organization_id" SET NOT NULL;
ALTER TABLE "projects" DROP CONSTRAINT "projects_slug_unique";
CREATE UNIQUE INDEX "projects_org_slug_unique" ON "projects" ("organization_id", "slug");
