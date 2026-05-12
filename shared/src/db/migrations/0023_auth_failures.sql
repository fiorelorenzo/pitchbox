-- Auth hardening (#45): track recent failed login attempts so the login route
-- can rate-limit by IP and by username, and the Security settings page can
-- show recent failures + offer an unlock action. Rows are append-only and
-- only the last `window_minutes` window is consulted by the limiter.
CREATE TABLE IF NOT EXISTS "auth_failures" (
  "id" bigserial PRIMARY KEY,
  "identifier" text NOT NULL,
  "failed_at" timestamptz NOT NULL DEFAULT now(),
  "kind" text NOT NULL DEFAULT 'login_attempt'
);

CREATE INDEX IF NOT EXISTS "auth_failures_identifier_idx"
  ON "auth_failures" ("identifier", "failed_at");
