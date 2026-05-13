-- Index audit (issue #44): dm-sync matching, Inbox filters, audit feed.
--   contact_history (account_handle, target_user) — dm-sync looks up the
--     `(accountHandle, targetUser)` pair when attributing incoming Reddit DMs
--     to a contact row (see shared/src/dm-sync.ts). Indexed via the name
--     called out in #44; the columns live on contact_history, not messages.
--   drafts (state, run_id) — campaign-run draft listings filter by state per run.
--   drafts (state, campaign_id, created_at DESC) — Inbox per-campaign filter
--     sorted by createdAt. `campaign_id` is reached through `run_id`, so we
--     index `(state, run_id, created_at DESC)`.
--   draft_events (kind, created_at) — audit feed groups draft events by kind.
--     The column is named `event` on draft_events.
--   run_events (kind, created_at) — audit feed groups run events by kind.
CREATE INDEX IF NOT EXISTS "messages_account_target_idx"
  ON "contact_history" ("account_handle", "target_user");

CREATE INDEX IF NOT EXISTS "drafts_state_run_idx"
  ON "drafts" ("state", "run_id");

CREATE INDEX IF NOT EXISTS "drafts_state_campaign_created_idx"
  ON "drafts" ("state", "run_id", "created_at" DESC);

CREATE INDEX IF NOT EXISTS "draft_events_kind_created_idx"
  ON "draft_events" ("event", "created_at");

CREATE INDEX IF NOT EXISTS "run_events_kind_created_idx"
  ON "run_events" ("kind", "created_at");
