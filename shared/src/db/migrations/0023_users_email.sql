-- users.email (#507): nullable so accounts predating it (first-run bootstrap,
-- `pitchbox seed:owner`) keep working with no backfill story. Required at
-- `POST /api/auth/register` (#504) instead, at the application layer.
--
-- Hand-authored rather than `drizzle-kit generate`: the committed snapshot
-- chain in migrations/meta/ stops at 0018_snapshot.json (0019-0022 landed
-- without a snapshot ever being committed for them, the same drift that
-- forced the 2026-07-13 baseline squash - see migrations_archive/README.md).
-- Running `generate` against that stale base tries to re-CREATE TABLE
-- instance_audit_log and operator_voice_profiles, which would fail outright
-- on any database that already has them. Reconciling that chain is a
-- separate, repo-wide fix; this migration only touches `users`.
ALTER TABLE "users" ADD COLUMN "email" text;
--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_unique" ON "users" USING btree ("email");
