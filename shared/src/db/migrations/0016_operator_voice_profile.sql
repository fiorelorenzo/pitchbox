CREATE TABLE "operator_voice_profiles" (
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
ALTER TABLE "operator_voice_profiles" ADD CONSTRAINT "operator_voice_profiles_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "operator_voice_profiles_org_unique" ON "operator_voice_profiles" USING btree ("organization_id");
