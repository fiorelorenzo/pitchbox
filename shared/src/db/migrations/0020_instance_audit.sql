-- Instance-wide config writes (#414): the audit surface in audit-feed.ts
-- unions draft_events and run_events, both reached through a project's
-- organization_id, so a change that is not org-scoped (a model swapped for
-- every tenant, a quota default raised, an account promoted) has nowhere to
-- land there. This is its own table for exactly that reason.
CREATE TABLE "instance_audit_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"actor" text NOT NULL,
	"before" jsonb,
	"after" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "instance_audit_log_created_idx" ON "instance_audit_log" USING btree ("created_at");
