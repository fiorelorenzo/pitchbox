-- Per-device extension tokens replacing the single shared
-- app_config.extension_api_token. The shared token row stays in app_config
-- for backwards compatibility (used by the legacy "Token" path in the
-- extension popup); new installs use the pairing-code flow.
CREATE TABLE "extension_devices" (
  "id" serial PRIMARY KEY,
  "organization_id" integer REFERENCES "organizations"("id") ON DELETE CASCADE,
  "label" text NOT NULL DEFAULT 'Unnamed device',
  "token_hash" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "last_seen_at" timestamptz,
  "revoked_at" timestamptz
);

CREATE UNIQUE INDEX "extension_devices_token_hash_unique" ON "extension_devices" ("token_hash");

CREATE TABLE "extension_pairings" (
  "code" text PRIMARY KEY,
  "organization_id" integer REFERENCES "organizations"("id") ON DELETE CASCADE,
  "expires_at" timestamptz NOT NULL,
  "consumed_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
