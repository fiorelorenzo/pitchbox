-- #523: the `personal` project (shared/src/personal-project.ts, decided
-- 2026-09-07, reversed 2026-09-09) is retired - the assist plane binds to
-- the operator and its own ledger directly (#521) and a project is now
-- optional context for a suggestion rather than something every org must
-- have one of. `ensurePersonalProject` no longer runs anywhere, so this is
-- the one-time cleanup of what it already created.
--
-- Deletes only a `personal` project that is genuinely untouched: its own
-- columns still hold the exact auto-created name/description/voice, and it
-- carries no accounts, campaigns, drafts, project_sources or templates. A
-- project matching the slug but touched in any of those ways survived real
-- use and is left alone - this checks rather than assumes, per #523's own
-- acceptance criterion. #521's own migration (0032) already moved every
-- assist-only draft out of `drafts` before this runs, so a `personal`
-- project's remaining drafts here, if any, are real campaign work.
DELETE FROM projects p
WHERE p.slug = 'personal'
	AND p.name = 'Personal'
	AND p.description = 'Your own voice. The in-page assistant writes as this project when a suggestion is not about one of your products, and its drafts stay out of the other projects'' numbers.'
	AND p.voice_tone IS NULL
	AND p.voice_tone_notes IS NULL
	AND NOT EXISTS (SELECT 1 FROM accounts a WHERE a.project_id = p.id)
	AND NOT EXISTS (SELECT 1 FROM campaigns c WHERE c.project_id = p.id)
	AND NOT EXISTS (SELECT 1 FROM drafts d WHERE d.project_id = p.id)
	AND NOT EXISTS (SELECT 1 FROM project_sources s WHERE s.project_id = p.id)
	AND NOT EXISTS (SELECT 1 FROM templates t WHERE t.project_id = p.id)
	AND NOT EXISTS (SELECT 1 FROM blocklist b WHERE b.project_id = p.id)
	AND NOT EXISTS (SELECT 1 FROM assist_usage u WHERE u.project_id = p.id)
	AND NOT EXISTS (
		SELECT 1 FROM assist_accepted_suggestions s2 WHERE s2.project_id = p.id
	);

-- A device or org binding still naming a now-deleted personal project as
-- `linkedin_assist.project_id` would otherwise resolve to a dead id -
-- loadLinkedInAssistDeviceState already re-validates that live on every
-- read (shared/src/linkedin-assist.ts), so nothing further is needed here.
