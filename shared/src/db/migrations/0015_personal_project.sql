-- Every organization gets a `personal` project, because the in-page assistant
-- writes as a person and `drafts.project_id` is NOT NULL: a suggestion that is
-- not about a specific product still has to land somewhere honest, and putting
-- it under a product's project makes that product's analytics count outreach it
-- never got (Lorenzo's call, 2026-09-07).
--
-- Hand-written rather than generated: this is a data backfill for the
-- organizations that already exist, and drizzle-kit only emits DDL. New
-- organizations get theirs from `ensurePersonalProject` at creation time.
--
-- Idempotent through the existing `projects_org_slug_unique` index, so a
-- re-run, or an organization that already has a project with this slug, is a
-- no-op rather than a conflict.
INSERT INTO projects (organization_id, slug, name, description)
SELECT
	o.id,
	'personal',
	'Personal',
	'Your own voice. The in-page assistant writes as this project when a suggestion is not about one of your products, and its drafts stay out of the other projects'' numbers.'
FROM organizations o
ON CONFLICT (organization_id, slug) DO NOTHING;
