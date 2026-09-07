CREATE TABLE "github_sources" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" integer NOT NULL,
	"project_id" integer,
	"owner" text NOT NULL,
	"repo" text NOT NULL,
	"url" text NOT NULL,
	"description" text,
	"primary_language" text,
	"readme_excerpt" text,
	"recent_commits" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"fetched_at" timestamp with time zone,
	"fetch_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "operator_profiles" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" integer NOT NULL,
	"handle" text,
	"display_name" text,
	"headline" text,
	"about" text,
	"experiences" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"notes" text,
	"source" text DEFAULT 'linkedin_capture' NOT NULL,
	"captured_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "operator_voice_samples" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" integer NOT NULL,
	"external_id" text NOT NULL,
	"platform_id" integer NOT NULL,
	"text" text NOT NULL,
	"url" text,
	"posted_at" timestamp with time zone,
	"excluded" boolean DEFAULT false NOT NULL,
	"captured_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "github_sources" ADD CONSTRAINT "github_sources_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_sources" ADD CONSTRAINT "github_sources_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operator_profiles" ADD CONSTRAINT "operator_profiles_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operator_voice_samples" ADD CONSTRAINT "operator_voice_samples_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operator_voice_samples" ADD CONSTRAINT "operator_voice_samples_platform_id_platforms_id_fk" FOREIGN KEY ("platform_id") REFERENCES "public"."platforms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "github_sources_org_repo_unique" ON "github_sources" USING btree ("organization_id","owner","repo");--> statement-breakpoint
CREATE UNIQUE INDEX "operator_profiles_org_unique" ON "operator_profiles" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "operator_voice_samples_org_external_unique" ON "operator_voice_samples" USING btree ("organization_id","external_id");--> statement-breakpoint
CREATE INDEX "operator_voice_samples_org_idx" ON "operator_voice_samples" USING btree ("organization_id","excluded");