CREATE TABLE "onboarding_state" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer,
	"organization_id" integer NOT NULL,
	"status" text DEFAULT 'not_started' NOT NULL,
	"current_step" text,
	"version" integer DEFAULT 1 NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"skipped_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "onboarding_state" ADD CONSTRAINT "onboarding_state_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_state" ADD CONSTRAINT "onboarding_state_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "onboarding_state_user_org_unique" ON "onboarding_state" USING btree ("user_id","organization_id") WHERE "onboarding_state"."user_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "onboarding_state_org_no_user_unique" ON "onboarding_state" USING btree ("organization_id") WHERE "onboarding_state"."user_id" IS NULL;