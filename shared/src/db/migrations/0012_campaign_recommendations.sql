CREATE TABLE "campaign_recommendations" (
  "id" serial PRIMARY KEY,
  "project_id" integer NOT NULL REFERENCES "projects"("id") ON DELETE cascade,
  "scenario_slug" text NOT NULL,
  "name" text NOT NULL,
  "objective" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT NOW() NOT NULL
);
CREATE INDEX "campaign_recommendations_project_idx"
  ON "campaign_recommendations" ("project_id", "created_at" DESC);
