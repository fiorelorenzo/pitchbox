CREATE TABLE IF NOT EXISTS "org_invites" (
  "id" serial PRIMARY KEY,
  "organization_id" integer NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "token" text NOT NULL UNIQUE,
  "email" text,
  "role" text NOT NULL DEFAULT 'member',
  "expires_at" timestamptz NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "accepted_at" timestamptz,
  "created_by_user_id" integer REFERENCES "users"("id") ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS "org_invites_org_idx" ON "org_invites" ("organization_id");
