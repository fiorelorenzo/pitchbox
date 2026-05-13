# Retention policy

The daemon prunes ageing rows once an hour so an unattended Pitchbox install
doesn't grow unbounded. The policy lives in `app_config.retention` (jsonb) and
is editable from **Settings → Retention**.

Defaults (in days):

- `drafts_days` — `90`. Only drafts in a terminal state (`sent`, `rejected`,
  `replied`) are pruned. Drafts still in `pending_review` are never touched.
- `run_events_days` — `30`. Stream-json events captured from agent runs.
- `draft_events_days` — `90`. The audit trail on individual drafts.

A floor of **7 days** is enforced server-side; lower values are clamped on
save. **Contact history is never pruned** — the `contact_history` table is the
long-term record used by the blocklist and per-account quota signals, and a
draft's `contact_history` row survives even when the draft itself ages out
(`contact_history.draft_id` is set to `NULL` rather than deleted).

The worker deletes in batches of 10k rows and is configurable via the
`PITCHBOX_RETENTION_MS` environment variable (default `3600000`).
