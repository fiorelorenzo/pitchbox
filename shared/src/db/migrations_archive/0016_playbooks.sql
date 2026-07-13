-- Playbooks become first-class DB-backed objects so users can edit them from
-- the dashboard. Runs snapshot the body at dispatch time (runs.playbook_body)
-- so editing a playbook never retroactively changes past runs.
CREATE TABLE "playbooks" (
  "id" serial PRIMARY KEY,
  "slug" text NOT NULL UNIQUE,
  "name" text NOT NULL,
  "description" text,
  "body" text NOT NULL,
  "is_builtin" boolean NOT NULL DEFAULT false,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE "runs" ADD COLUMN "playbook_body" text;
