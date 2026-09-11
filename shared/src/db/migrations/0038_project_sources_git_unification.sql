-- Collapses the redundant `github` project-source kind into `git`.
--
-- A repository was addable twice: as `git` (a clone URL a description run
-- reads in full) and as `github` (the same repository read shallowly
-- through the API into a cached README excerpt). Two rows, two states, two
-- names for one thing, and the person adding "my repo" had to guess which
-- half of the product would read it. `git` covers both now: its re-sync
-- reads the GitHub metadata when the URL is a GitHub one, and a description
-- run clones the tree whatever the host is (shared/src/project-source-sync.ts).
--
-- The rewrite also backfills `config.value`, which is the key every reader
-- uses. Migration 0018 built its `github` rows out of `github_sources` and
-- wrote `{ owner, repo, url }` with no `value` at all, so `syncGithub` -
-- which only ever read `value` - failed every one of those rows with "not a
-- github url at all". Those rows have been unsyncable since the day they
-- were created; this is where they start working.
UPDATE "project_sources"
SET
	"kind" = 'git',
	"config" = "config" || jsonb_build_object(
		'value',
		COALESCE(NULLIF("config" ->> 'value', ''), NULLIF("config" ->> 'url', ''))
	),
	"updated_at" = now()
WHERE
	"kind" = 'github'
	AND COALESCE(NULLIF("config" ->> 'value', ''), NULLIF("config" ->> 'url', '')) IS NOT NULL;
--> statement-breakpoint
-- A `github` row carrying neither key is unreadable either way. It still
-- becomes a `git` row rather than keeping a kind no code path handles: the
-- sources panel then shows it with "This source carries no repository URL."
-- and an operator can delete or retype it, which is strictly better than a
-- row that renders as an unknown kind.
UPDATE "project_sources" SET "kind" = 'git', "updated_at" = now() WHERE "kind" = 'github';
