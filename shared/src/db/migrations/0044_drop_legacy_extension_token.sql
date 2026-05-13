-- Drop the legacy single shared extension token. Extension auth is now
-- per-device only via extension_devices (minted by /api/extension/auto-pair).
DELETE FROM "app_config" WHERE "key" IN ('extension_api_token', 'extension_token_created_at');
