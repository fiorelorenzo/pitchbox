CREATE TABLE IF NOT EXISTS "project_insights" (
  "id" serial PRIMARY KEY NOT NULL,
  "project_id" integer NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "generated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "summary_md" text NOT NULL,
  "evidence" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "project_insights_project_idx" ON "project_insights" ("project_id", "generated_at");
