ALTER TABLE "webhook_deliveries" ADD COLUMN "organization_id" integer;--> statement-breakpoint
UPDATE "webhook_deliveries" SET "organization_id" = (
  SELECT "n"."organization_id"
  FROM "notifications" "n"
  WHERE "n"."id" = ("webhook_deliveries"."payload" #>> '{body,id}')::bigint
) WHERE "organization_id" IS NULL;--> statement-breakpoint
UPDATE "webhook_deliveries" SET "organization_id" = (SELECT "id" FROM "organizations" WHERE "slug" = 'default') WHERE "organization_id" IS NULL;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ALTER COLUMN "organization_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "webhook_deliveries_org_idx" ON "webhook_deliveries" USING btree ("organization_id","created_at" DESC NULLS LAST);
