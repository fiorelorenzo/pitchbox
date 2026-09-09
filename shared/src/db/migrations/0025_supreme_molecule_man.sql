CREATE TABLE "assist_usage" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"organization_id" integer,
	"project_id" integer NOT NULL,
	"device_id" integer,
	"platform_id" integer NOT NULL,
	"kind" text NOT NULL,
	"agent_runner" text NOT NULL,
	"model" text,
	"input_tokens" integer,
	"output_tokens" integer,
	"cache_read_tokens" integer,
	"cache_creation_tokens" integer,
	"cost_usd" numeric(10, 4),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "assist_usage" ADD CONSTRAINT "assist_usage_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assist_usage" ADD CONSTRAINT "assist_usage_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assist_usage" ADD CONSTRAINT "assist_usage_device_id_extension_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."extension_devices"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assist_usage" ADD CONSTRAINT "assist_usage_platform_id_platforms_id_fk" FOREIGN KEY ("platform_id") REFERENCES "public"."platforms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "assist_usage_org_created_idx" ON "assist_usage" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "assist_usage_project_created_idx" ON "assist_usage" USING btree ("project_id","created_at");