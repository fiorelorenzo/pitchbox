ALTER TABLE "organizations" ADD COLUMN "monthly_run_budget_usd" numeric(10, 2);--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "max_concurrent_runs" integer;