CREATE TABLE "org_subscriptions" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" integer NOT NULL,
	"stripe_customer_id" text NOT NULL,
	"stripe_subscription_id" text NOT NULL,
	"plan_id" text NOT NULL,
	"status" text NOT NULL,
	"current_period_end" timestamp with time zone NOT NULL,
	"cancel_at_period_end" boolean DEFAULT false NOT NULL,
	"limit_runs" integer,
	"limit_suggestions" integer,
	"limit_projects" integer,
	"limit_seats" integer,
	"limit_devices" integer,
	"limit_concurrency" integer,
	"limit_budget_usd" numeric(10, 2),
	"limit_retention_days" integer,
	"limit_premium_models" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "plan" text DEFAULT 'free' NOT NULL;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "plan_source" text DEFAULT 'default' NOT NULL;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "plan_updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "org_subscriptions" ADD CONSTRAINT "org_subscriptions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "org_subscriptions_org_unique" ON "org_subscriptions" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "org_subscriptions_stripe_subscription_unique" ON "org_subscriptions" USING btree ("stripe_subscription_id");

-- #544: every existing org gets the column defaults above ('free'/'default'),
-- which is right for every self-created and invited org. The one exception is
-- the seeded `default` org, the single-tenant self-host fallback
-- (shared/src/db/seed-core.ts) - it must keep behaving exactly as before this
-- migration (unlimited, unconfigured caps), and `resolveEntitlements`
-- (shared/src/plans.ts) grants that only to a self-hosted edition OR a
-- 'grant' org. Marking it 'scale'/'grant' here is belt and suspenders: on
-- self-host `resolveEntitlements` ignores `plan` entirely, and on a cloud
-- install that reused the seeded slug on purpose (mine, or a friend's) it
-- reads as the highest grant rather than silently dropping to Free.
UPDATE "organizations"
SET "plan" = 'scale', "plan_source" = 'grant', "plan_updated_at" = now()
WHERE "slug" = 'default';