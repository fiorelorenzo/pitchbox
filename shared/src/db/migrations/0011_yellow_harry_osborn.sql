CREATE TABLE "observed_targets" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"organization_id" integer NOT NULL,
	"project_id" integer NOT NULL,
	"platform_id" integer NOT NULL,
	"external_id" text NOT NULL,
	"url" text NOT NULL,
	"author_handle" text,
	"author_name" text,
	"text" text,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"consumed_by_run_id" integer
);
--> statement-breakpoint
ALTER TABLE "observed_targets" ADD CONSTRAINT "observed_targets_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "observed_targets" ADD CONSTRAINT "observed_targets_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "observed_targets" ADD CONSTRAINT "observed_targets_platform_id_platforms_id_fk" FOREIGN KEY ("platform_id") REFERENCES "public"."platforms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "observed_targets" ADD CONSTRAINT "observed_targets_consumed_by_run_id_runs_id_fk" FOREIGN KEY ("consumed_by_run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "observed_targets_dedup_idx" ON "observed_targets" USING btree ("organization_id","platform_id","external_id");--> statement-breakpoint
CREATE INDEX "observed_targets_project_unconsumed_idx" ON "observed_targets" USING btree ("project_id","consumed_by_run_id","observed_at");