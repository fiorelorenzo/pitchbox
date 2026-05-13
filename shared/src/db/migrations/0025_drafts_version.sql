-- Optimistic-locking version column on drafts. Every state-changing query
-- bumps the version and matches on the prior value so concurrent writes
-- (e.g. dashboard reject racing the extension send) surface as a 409 rather
-- than silently overwriting each other.
ALTER TABLE "drafts"
  ADD COLUMN IF NOT EXISTS "version" integer NOT NULL DEFAULT 0;
