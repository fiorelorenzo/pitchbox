-- Phase 2 of the auth umbrella: introduce organizations + memberships so the
-- single-tenant self-host and the future multi-tenant cloud edition share the
-- same data model. A default org gets inserted on first boot, and every
-- existing project is backfilled to point at it.
CREATE TABLE "organizations" (
  "id" serial PRIMARY KEY,
  "slug" text NOT NULL UNIQUE,
  "name" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE "memberships" (
  "id" serial PRIMARY KEY,
  "organization_id" integer NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "user_id" integer NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "role" text NOT NULL DEFAULT 'owner',
  "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX "memberships_org_user_unique" ON "memberships" ("organization_id", "user_id");

ALTER TABLE "projects" ADD COLUMN "organization_id" integer REFERENCES "organizations"("id") ON DELETE CASCADE;

-- Seed-time backfill: a guaranteed default org row + every existing project
-- pointed at it. seed:core re-runs this idempotently after migrations.
INSERT INTO "organizations" ("slug", "name") VALUES ('default', 'Default')
  ON CONFLICT (slug) DO NOTHING;

UPDATE "projects"
SET "organization_id" = (SELECT id FROM "organizations" WHERE slug = 'default')
WHERE "organization_id" IS NULL;
