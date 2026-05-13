-- Per-device sync liveness from the browser extension. The extension probes
-- the Matrix `/whoami` endpoint before each chat sync and reports the result
-- (chat + legacy inbox channels) alongside every `/api/extension/dm-sync` POST.
-- The dashboard surfaces an alert when any device reports `chat=unauthorized`.
ALTER TABLE "extension_devices"
  ADD COLUMN IF NOT EXISTS "last_sync_status" jsonb;
