# CLI reference

`bin/pitchbox` is a bash wrapper that runs `cli/src/index.ts` under `tsx`. No build step — playbooks call it directly.

## `pitchbox run:start --campaign <id>`

Bootstraps a run. If `PITCHBOX_RUN_ID` is set in the environment (the dashboard sets it when dispatching), the CLI reuses that row; otherwise it inserts a new `runs` row with `status=running`. Surfaces campaign config, accounts (filtered to the campaign's platform, default first), blocklist, and recent contacts on stdout.

## `pitchbox run:finish --run <id> --status success|failed [--error <msg>] [--tokens <n>]`

Commits terminal state for a run. The dispatcher's `then/catch` blocks tolerate the row being pre-finalised, so playbooks can call this safely.

## `pitchbox drafts:create --run <id>`

Reads a JSON payload from stdin (an array of up to 200 draft inputs) and bulk-inserts the rows. Blocklisted targets are skipped and reported back in the JSON response. Reddit's `subreddit` lives under `metadata.subreddit` — the column itself was dropped in migration 0014.

## `pitchbox drafts:get [--state <state>] [--project <slug>]`

Read-only listing. Useful for debugging the playbook's state from a shell.

## Reddit helpers

The `cli/src/commands/reddit.ts` module exposes Reddit-specific helpers (search subreddits, fetch a thread, etc.) that the scout playbook uses internally. Run `pitchbox --help` for the current list.

## drafts:regenerate

```
pitchbox drafts:regenerate <id> [--hint "..."]
```

Bumps `drafts.regeneration_count` for the target draft, optionally records a reviewer hint into `draft_regeneration_hints`, and appends a `regenerated` draft_event. The runner invocation is currently stubbed — the helper is invoked verbatim by the dashboard's `POST /api/drafts/[id]/regenerate` so both surfaces share an audit trail until the `regenerate-single` runner mode lands.
