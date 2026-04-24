DROP INDEX IF EXISTS "messages_platform_message_unique";
ALTER TABLE "messages" ALTER COLUMN "platform_message_id" SET NOT NULL;
CREATE UNIQUE INDEX "messages_platform_message_unique"
  ON "messages" ("platform_id", "platform_message_id");
