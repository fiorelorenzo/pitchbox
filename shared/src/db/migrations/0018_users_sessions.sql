-- Phase-1 auth: local username/password sessions guarded by PITCHBOX_AUTH=on.
-- Multi-tenant orgs/memberships and SSO are intentionally deferred — they
-- bolt on top of this table without a breaking schema change.
CREATE TABLE "users" (
  "id" serial PRIMARY KEY,
  "username" text NOT NULL UNIQUE,
  "password_hash" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE "sessions" (
  "id" text PRIMARY KEY,
  "user_id" integer NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "expires_at" timestamptz NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX "sessions_user_idx" ON "sessions" ("user_id");
