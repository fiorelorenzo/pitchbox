-- password_reset_tokens (#509): backs POST /api/auth/password/forgot and
-- POST /api/auth/password/reset. Only a hash of the token is ever stored,
-- same convention as extension_devices.token_hash - the raw token exists
-- only in the emailed link and the requester's browser.
--
-- Hand-authored rather than `drizzle-kit generate`, same reason as
-- 0023_users_email.sql: the committed snapshot chain in migrations/meta/
-- stops at 0018_snapshot.json, so `generate` tries to re-CREATE TABLE
-- instance_audit_log and operator_voice_profiles against that stale base
-- and fails on any database that already has them (see
-- migrations_archive/README.md). This migration only adds
-- password_reset_tokens.
CREATE TABLE "password_reset_tokens" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"used_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "password_reset_tokens" ADD CONSTRAINT "password_reset_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "password_reset_tokens_token_hash_unique" ON "password_reset_tokens" USING btree ("token_hash");
--> statement-breakpoint
CREATE INDEX "password_reset_tokens_user_idx" ON "password_reset_tokens" USING btree ("user_id");
