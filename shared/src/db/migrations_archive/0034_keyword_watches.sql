CREATE TABLE IF NOT EXISTS "keyword_watches" (
  "id" serial PRIMARY KEY NOT NULL,
  "project_id" integer NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "campaign_id" integer NOT NULL REFERENCES "campaigns"("id") ON DELETE CASCADE,
  "subreddit" text NOT NULL,
  "pattern" text NOT NULL,
  "match_field" text NOT NULL,
  "is_active" boolean DEFAULT true NOT NULL,
  "last_seen_at" timestamp with time zone,
  "cooldown_minutes" integer DEFAULT 30 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "keyword_watches_campaign_idx" ON "keyword_watches" ("campaign_id", "is_active");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "keyword_watches_project_idx" ON "keyword_watches" ("project_id", "is_active");
