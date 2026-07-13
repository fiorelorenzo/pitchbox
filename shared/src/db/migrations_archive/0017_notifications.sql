-- Notifications drive the in-app bell and the outgoing webhook adapter.
-- All events are persisted so the user can scroll the history; readAt
-- separates unread from acknowledged.
CREATE TABLE "notifications" (
  "id" bigserial PRIMARY KEY,
  "kind" text NOT NULL,
  "title" text NOT NULL,
  "body" text,
  "payload" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "severity" text NOT NULL DEFAULT 'info',
  "read_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX "notifications_unread_idx" ON "notifications" ("read_at", "created_at" DESC);
