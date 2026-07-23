ALTER TABLE "contact_history" ADD COLUMN "organization_id" integer;--> statement-breakpoint
ALTER TABLE "contact_history" ADD CONSTRAINT "contact_history_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "contact_history_org_idx" ON "contact_history" USING btree ("organization_id","platform_id","last_contacted_at");--> statement-breakpoint
-- #215 backfill: attribute existing contacts to their tenant via the draft's
-- project. Rows whose draft was already pruned (draft_id IS NULL) stay NULL and
-- remain unmatchable for org-scoped devices, same as before this column.
UPDATE "contact_history" AS ch
SET "organization_id" = p."organization_id"
FROM "drafts" AS d
JOIN "projects" AS p ON p."id" = d."project_id"
WHERE ch."draft_id" = d."id" AND ch."organization_id" IS NULL;