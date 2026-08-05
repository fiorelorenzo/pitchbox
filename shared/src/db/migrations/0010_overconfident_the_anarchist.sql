-- #263 backfill, run before the constraint below.
--
-- 0009 attributed contacts through their draft's project. That left two kinds of
-- row null: self-host rows written before the column existed, and rows whose
-- draft had already been pruned by retention when it ran. Both are now invisible
-- to every read rather than merely unmatchable by dm-sync, so they have to be
-- attributed before the column can be NOT NULL.
--
-- 1. The account that did the contacting is the second real path to a tenant:
--    contact_history.(account_handle, platform_id) -> accounts -> projects ->
--    organization_id. Only applied when the pair resolves to exactly one org, so
--    a handle reused across tenants is left for step 2 rather than guessed.
UPDATE "contact_history" AS ch
SET "organization_id" = m."organization_id"
FROM (
  SELECT a."handle", a."platform_id", MIN(p."organization_id") AS "organization_id"
  FROM "accounts" a
  JOIN "projects" p ON p."id" = a."project_id"
  GROUP BY a."handle", a."platform_id"
  HAVING COUNT(DISTINCT p."organization_id") = 1
) AS m
WHERE ch."organization_id" IS NULL
  AND ch."account_handle" = m."handle"
  AND ch."platform_id" = m."platform_id";
--> statement-breakpoint
-- 2. Anything still unattributed goes to the `default` organization, which is the
--    self-host tenant seed-core creates and the org every single-tenant install
--    runs under. This is a guess on a multi-org install, but the alternative is
--    deleting outreach history or leaving rows no one can see. Ordering by id is
--    the fallback for an install that renamed the default org's slug.
UPDATE "contact_history"
SET "organization_id" = COALESCE(
  (SELECT "id" FROM "organizations" WHERE "slug" = 'default'),
  (SELECT "id" FROM "organizations" ORDER BY "id" LIMIT 1)
)
WHERE "organization_id" IS NULL;
--> statement-breakpoint
ALTER TABLE "contact_history" ALTER COLUMN "organization_id" SET NOT NULL;
