# CLI reference

`bin/pitchbox` is a bash wrapper that runs `cli/src/index.ts` under `tsx`, so there is no build step. The same command logic is also exposed to playbooks through the **Pitchbox MCP server** (`bin/pitchbox-mcp`): playbooks read and write state via the `mcp__pitchbox__*` tools, not by shelling out to this CLI. The commands below are handy for driving or debugging that surface from a shell.

## `pitchbox run:start --campaign <id>`

Bootstraps a run. If `PITCHBOX_RUN_ID` is set in the environment (the dashboard sets it when dispatching), the CLI reuses that row; otherwise it inserts a new `runs` row with `status=running`. Surfaces campaign config, accounts (filtered to the campaign's platform, default first), blocklist, and recent contacts on stdout.

## `pitchbox run:finish --run <id> --status success|failed [--error <msg>] [--tokens <n>]`

Commits terminal state for a run. The dispatcher's `then/catch` blocks tolerate the row being pre-finalised, so playbooks can call this safely.

## `pitchbox drafts:create --run <id>`

Reads a JSON payload from stdin (an array of up to 200 draft inputs) and bulk-inserts the rows. Blocklisted targets are skipped and reported back in the JSON response. Reddit's `subreddit` lives under `metadata.subreddit` - the column itself was dropped in migration 0014.

## `pitchbox drafts:get [--id <id>] [--state <state>] [--project <slug>]`

Read-only. With `--id` it returns a single draft plus its thread messages; otherwise it lists drafts (optionally filtered by `--state`). Useful for debugging the playbook's state from a shell.

## Reddit helpers

The `cli/src/commands/reddit.ts` module exposes Reddit-specific helpers (search subreddits, fetch a thread, etc.) that the scout playbook uses internally. Run `pitchbox --help` for the current list.

## drafts:regenerate

```
pitchbox drafts:regenerate <id> [--hint "..."]
```

Regeneration runs as an agent job dispatched by the web app. The dashboard's `POST /api/drafts/[id]/regenerate` (and the Inbox **Regenerate** action) launch a `draft_regeneration` run that rewrites the draft body honoring the reviewer hint, records the hint into `draft_regeneration_hints`, appends a `regenerated` draft_event that snapshots the previous body (so the change is undoable), and re-scores the draft. The CLI command is a thin pointer to that web flow.
