# Retention policy

The daemon prunes ageing rows once an hour so an unattended Pitchbox install
doesn't grow unbounded. The policy lives in `app_config.retention` (jsonb) and
is editable from **Settings → Retention**.

Defaults (in days):

- `drafts_days` - `90`. Only drafts in a terminal state (`sent`, `rejected`,
  `replied`) are pruned. Drafts still in `pending_review` are never touched.
- `run_events_days` - `30`. Stream-json events captured from agent runs.
- `draft_events_days` - `90`. The audit trail on individual drafts.

A floor of **7 days** is enforced server-side; lower values are clamped on
save. **Contact history is never pruned** - the `contact_history` table is the
long-term record used by the blocklist and per-account quota signals, and a
draft's `contact_history` row survives even when the draft itself ages out
(`contact_history.draft_id` is set to `NULL` rather than deleted).

The worker deletes in batches of 10k rows and is configurable via the
`PITCHBOX_RETENTION_MS` environment variable (default `3600000`).

## Retention is not plan-scoped, as shipped

The plan catalogue (`shared/src/plans.ts`) declares a `retentionDays` ceiling
per plan (14/30/90/180 for Free/Solo/Growth/Scale, mirrored from Stripe's
`limit_retention_days` product metadata for the paid tiers) and
`resolveEntitlements` returns it on every `Entitlements` value. As shipped,
nothing reads that field to clamp anything: the policy above is one
instance-wide `app_config` row, set by an instance admin, and the daemon's
`retention.ts` worker prunes every organization on the deployment against
that same policy - on **both** the cloud edition and self-host, with no
per-org distinction and no reference to an org's plan. An org on Free and an
org on Scale are pruned identically today. This is a real gap between the
catalogue's declared field and enforcement, not a documentation choice - if
per-plan retention ships, it reads `entitlements.retentionDays` the same way
every other metered limit reads its own field, and this section moves back
to describing self-host as the one edition with no ceiling.
