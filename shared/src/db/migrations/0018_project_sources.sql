CREATE TABLE "project_sources" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_id" integer NOT NULL,
	"kind" text NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"output" jsonb,
	"active" boolean DEFAULT true NOT NULL,
	"fetched_at" timestamp with time zone,
	"fetch_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "project_sources" ADD CONSTRAINT "project_sources_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "project_sources_project_idx" ON "project_sources" USING btree ("project_id","active");--> statement-breakpoint
-- Data backfill (#431): github_sources.project_id was always nullable and
-- meant for a repo that belongs to one project rather than the operator, but
-- no real caller ever set it - every one (`/settings/companion`,
-- `assist/context.ts`) reads across the whole organization. A row that does
-- carry a project_id becomes a project_sources row of kind 'github' here,
-- carrying its cached read forward, so a project that had one keeps working.
-- Everything else in github_sources is organization-wide and stays put.
INSERT INTO "project_sources" ("project_id", "kind", "config", "output", "active", "fetched_at", "fetch_error", "created_at", "updated_at")
SELECT
	"project_id",
	'github',
	jsonb_build_object('owner', "owner", 'repo', "repo", 'url', "url"),
	jsonb_build_object(
		'description', "description",
		'primaryLanguage', "primary_language",
		'readmeExcerpt', "readme_excerpt",
		'recentCommits', "recent_commits"
	),
	"active",
	"fetched_at",
	"fetch_error",
	"created_at",
	"updated_at"
FROM "github_sources"
WHERE "project_id" IS NOT NULL;
--> statement-breakpoint
DELETE FROM "github_sources" WHERE "project_id" IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "github_sources" DROP CONSTRAINT "github_sources_project_id_projects_id_fk";
--> statement-breakpoint
ALTER TABLE "github_sources" DROP COLUMN "project_id";