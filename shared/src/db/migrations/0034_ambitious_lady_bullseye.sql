ALTER TABLE "org_subscriptions" ADD COLUMN "pending_plan_id" text;--> statement-breakpoint
ALTER TABLE "org_subscriptions" ADD COLUMN "pending_plan_effective_at" timestamp with time zone;