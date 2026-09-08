-- Re-issue of 0016_operator_voice_profile, which drizzle silently skipped on
-- every database that had already applied 0017 or 0018 (#493). 0016 was
-- authored on a branch with `when` 1788960000003 and merged after two branches
-- carrying 1788960000004 and 1788960000005, so the migrator never ran it and
-- still reported success. The preview deployment therefore had no
-- `operator_voice_profiles` table, and the first suggestion that read it
-- failed with a 500.
--
-- Written to be safe against a database that already has the table (a fresh
-- one, where 0016 did run), so both histories converge here. 0016 stays in the
-- journal untouched: editing an applied migration in place is how a schema
-- and its history stop agreeing.
CREATE TABLE IF NOT EXISTS "operator_voice_profiles" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" integer NOT NULL,
	"summary" text DEFAULT '' NOT NULL,
	"traits" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"openings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"closings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"common_words" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"words_per_sentence" integer DEFAULT 0 NOT NULL,
	"item_count" integer DEFAULT 0 NOT NULL,
	"word_count" integer DEFAULT 0 NOT NULL,
	"evidence" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"source" text DEFAULT 'derived' NOT NULL,
	"derived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "operator_voice_profiles" ADD CONSTRAINT "operator_voice_profiles_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "operator_voice_profiles_org_unique" ON "operator_voice_profiles" USING btree ("organization_id");
