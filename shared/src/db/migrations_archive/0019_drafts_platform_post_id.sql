-- Track the Reddit post id (t3_…) once the user submits a reddit-poster draft.
-- The reply-poller compares incoming t3-level replies against this column to
-- attribute comments back to the originating draft.
ALTER TABLE "drafts" ADD COLUMN "platform_post_id" text;
