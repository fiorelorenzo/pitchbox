# Opening a pull request in this repository: what the kit's skill leaves to us

The workflow kit's `pr-creation` skill (`.agents/skills/pr-creation/SKILL.md`) is the
procedure; this file is the part only this repository does. Read the skill first, then
this. Where the two disagree, this file is the more specific one and wins. It is kept out
of the published docs site (`srcExclude` in `docs/.vitepress/config.ts`).

## Before you push: preflight

Run `python3 .github/kit/bin/preflight` once the change is committed, or let the installed
`pre-push` hook run it. It reads `.github/preflight.json` and runs `pnpm test` against a
disposable Postgres on `127.0.0.1:5490` (`docker-compose.preflight.yml`): the PR-path
replacement for `Tests (Postgres)`, which `ci` runs only on `push: main`.
`python3 .github/kit/bin/preflight --list` shows what it would run for your diff. A run
takes about nine minutes, so start it in the background and write the body while it runs.
`python3 .github/kit/bin/preflight --install-hook` (re)installs the hook in a checkout;
it writes only `.git/hooks/pre-push`.

For the rebase that only renumbers `docs/design/DECISIONS.md` rows, run it once on the
real change and push the renumbering with `--no-verify`: AGENTS.md, "Working in a
worktree", says why.

## Scopes and the card's labels

The scope in a title is a workspace name, matching the `area:*` label on the card:
`shared`, `web`, `cli`, `daemon`, `extension`, `playbooks`, `tests`, `docs`, `cloud`,
`deploy`, and a comma-separated list when a change spans several
(`fix(shared,web): ...`). `.github/workflow.json` lists every scope the history has used,
and does not require one: `chore:` and `docs:` with no scope are common here.

## Screenshots

The pairs and the video go on with `--attach` on `gh pr create`, or afterwards with
`gh pr edit <n> --attach <file>`. The section stays on the PR when nothing visible
changed, and says so. The dev target, `uishot` and the side panel's own capture route are
in AGENTS.md, "Design and UI".

## Merging

`gh pr merge <n> --squash --delete-branch` is the only method the ruleset allows
(`allowed_merge_methods: ["squash"]`). `allow_auto_merge` is on, so arm
`gh pr merge <n> --auto --squash --delete-branch` right after opening rather than waiting
on `ci` yourself. `delete_branch_on_merge` is also on, so nothing needs deleting on
`origin`; local `main` still needs `git checkout main && git reset --hard origin/main`
afterward, since it diverges on every squash. Remove the worktree with
`git worktree remove`.

## Review

No review bot is configured on this repository (`github.review_bots` is empty), so the
independent review is a fresh reviewer on the diff, applied before the PR opens, with the
review recorded as a PR comment.

## Releases

Production moves on a `v*` tag only (`deploy-prod.yml`), and only when asked. Preview
deploys on every green `ci` run on `main` (`deploy-preview.yml`). Both run on
`[self-hosted, prodbox]` and nothing local reproduces either, so a PR never reports them
as verified.
