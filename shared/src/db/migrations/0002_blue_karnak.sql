ALTER TABLE "notifications" ADD COLUMN "organization_id" integer;--> statement-breakpoint
UPDATE "notifications" SET "organization_id" = (SELECT "id" FROM "organizations" WHERE "slug" = 'default') WHERE "organization_id" IS NULL;--> statement-breakpoint
ALTER TABLE "notifications" ALTER COLUMN "organization_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "notifications_org_idx" ON "notifications" USING btree ("organization_id","created_at" DESC NULLS LAST);