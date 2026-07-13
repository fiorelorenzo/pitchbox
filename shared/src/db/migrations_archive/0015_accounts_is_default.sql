-- Mark one default account per (project, platform). Used by the CLI run path
-- and by the playbook to pick the account without forcing the user to wire
-- it into every campaign. A partial unique index guarantees at most one
-- default per scope; rows can flip freely with regular UPDATEs.
ALTER TABLE "accounts" ADD COLUMN "is_default" boolean NOT NULL DEFAULT false;

CREATE UNIQUE INDEX "accounts_one_default_per_project_platform"
  ON "accounts" ("project_id", "platform_id")
  WHERE "is_default" = true;
