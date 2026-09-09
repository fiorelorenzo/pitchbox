-- #521: LI-16/#313's accept path used to write a `runs` row of kind =
-- 'assist' plus a `drafts` row hanging off it, purely because
-- `drafts.run_id` was NOT NULL. 0031 adds the assist plane's own ledger
-- (assist_accepted_suggestions); this migration moves every row that old
-- path already wrote into it, so nothing is left orphaned behind the
-- dropped constraint branch below, then removes the 'assist' branch from
-- runs_kind_target_chk.
--
-- Hand-authored, not drizzle-generated: this is a data move (drizzle-kit
-- only emits DDL) plus the same hand-maintained CHECK constraint every
-- prior change to it has been (migrations_archive/0010, 0011, 0045-0048,
-- 0013, 0022 - see their own comments and the historical-constraint-name
-- warning in AGENTS.md).
--
-- Field mapping, matching exactly what the pre-#521 accept route
-- (web/src/routes/api/extension/suggest/accept/+server.ts) wrote:
--   - post_urn        <- drafts.source_ref->>'externalId'
--   - author_handle   <- drafts.target_user, falling back to the metadata/
--                        source_ref copies the old route also wrote
--   - author_name     <- drafts.metadata->>'authorName'
--   - post_url        <- drafts.source_ref->>'url'
--   - reported/recomputed_cost_usd <- runs.params, written by #522
-- No device_id or edited_from: neither was ever recorded on the old shape.
INSERT INTO assist_accepted_suggestions (
	organization_id, project_id, platform_id, device_id, kind,
	post_urn, author_handle, author_name, post_url, body, edited_from,
	agent_runner, input_tokens, output_tokens, cache_read_tokens,
	cache_creation_tokens, reported_cost_usd, recomputed_cost_usd, created_at
)
SELECT
	p.organization_id,
	d.project_id,
	d.platform_id,
	NULL,
	d.kind,
	d.source_ref ->> 'externalId',
	COALESCE(d.target_user, d.metadata ->> 'authorHandle', d.source_ref ->> 'authorHandle'),
	d.metadata ->> 'authorName',
	d.source_ref ->> 'url',
	d.body,
	NULL,
	r.agent_runner,
	r.input_tokens,
	r.output_tokens,
	r.cache_read_tokens,
	r.cache_creation_tokens,
	(r.params ->> 'reportedCostUsd')::numeric(10, 4),
	(r.params ->> 'recomputedCostUsd')::numeric(10, 4),
	d.created_at
FROM drafts d
JOIN runs r ON r.id = d.run_id
JOIN projects p ON p.id = d.project_id
WHERE r.kind = 'assist';

-- The migrated drafts' own draft_events rows (the 'created' event the old
-- accept path wrote in the same transaction) go with them.
DELETE FROM draft_events
WHERE draft_id IN (
	SELECT d.id FROM drafts d JOIN runs r ON r.id = d.run_id WHERE r.kind = 'assist'
);
DELETE FROM drafts WHERE run_id IN (SELECT id FROM runs WHERE kind = 'assist');
DELETE FROM runs WHERE kind = 'assist';

ALTER TABLE "runs" DROP CONSTRAINT IF EXISTS "runs_kind_target_chk";
ALTER TABLE "runs" ADD CONSTRAINT "runs_kind_target_chk"
  CHECK (
    (kind = 'campaign' AND campaign_id IS NOT NULL)
    OR (kind = 'project_extraction' AND project_id IS NOT NULL)
    OR (kind = 'campaign_skill_generation' AND campaign_id IS NOT NULL)
    OR (kind = 'draft_regeneration' AND project_id IS NOT NULL)
    OR (kind = 'reply_drafting' AND project_id IS NOT NULL)
    OR (kind = 'project_insights' AND project_id IS NOT NULL)
    OR (kind = 'project_description_refresh' AND project_id IS NOT NULL)
  );
