CREATE TABLE "messages" (
  "id" BIGSERIAL PRIMARY KEY,
  "contact_id" BIGINT NOT NULL REFERENCES "contact_history"("id") ON DELETE CASCADE,
  "draft_id" INTEGER REFERENCES "drafts"("id") ON DELETE SET NULL,
  "platform_id" INTEGER NOT NULL REFERENCES "platforms"("id"),
  "author" TEXT NOT NULL,
  "is_from_us" BOOLEAN NOT NULL DEFAULT FALSE,
  "body" TEXT NOT NULL,
  "platform_message_id" TEXT,
  "created_at_platform" TIMESTAMPTZ NOT NULL,
  "captured_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "source" TEXT NOT NULL
);

CREATE INDEX "messages_contact_idx" ON "messages" ("contact_id", "created_at_platform");

CREATE UNIQUE INDEX "messages_platform_message_unique"
  ON "messages" ("platform_id", "platform_message_id")
  WHERE "platform_message_id" IS NOT NULL;
