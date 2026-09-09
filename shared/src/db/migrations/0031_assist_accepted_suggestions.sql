CREATE TABLE "assist_accepted_suggestions" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"organization_id" integer NOT NULL,
	"project_id" integer,
	"platform_id" integer NOT NULL,
	"device_id" integer,
	"kind" text NOT NULL,
	"post_urn" text,
	"author_handle" text,
	"author_name" text,
	"post_url" text,
	"body" text NOT NULL,
	"edited_from" text,
	"agent_runner" text NOT NULL,
	"input_tokens" integer,
	"output_tokens" integer,
	"cache_read_tokens" integer,
	"cache_creation_tokens" integer,
	"reported_cost_usd" numeric(10, 4),
	"recomputed_cost_usd" numeric(10, 4),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "assist_usage" DROP CONSTRAINT "assist_usage_project_id_projects_id_fk";
--> statement-breakpoint
ALTER TABLE "assist_usage" ALTER COLUMN "project_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "assist_accepted_suggestions" ADD CONSTRAINT "assist_accepted_suggestions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assist_accepted_suggestions" ADD CONSTRAINT "assist_accepted_suggestions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assist_accepted_suggestions" ADD CONSTRAINT "assist_accepted_suggestions_platform_id_platforms_id_fk" FOREIGN KEY ("platform_id") REFERENCES "public"."platforms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assist_accepted_suggestions" ADD CONSTRAINT "assist_accepted_suggestions_device_id_extension_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."extension_devices"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "assist_accepted_suggestions_org_created_idx" ON "assist_accepted_suggestions" USING btree ("organization_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "assist_accepted_suggestions_author_idx" ON "assist_accepted_suggestions" USING btree ("organization_id","platform_id","author_handle","created_at" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "assist_usage" ADD CONSTRAINT "assist_usage_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;