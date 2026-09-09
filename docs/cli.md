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

## `pitchbox seed:owner`

Creates the owner user (and default-org owner membership) from
`PITCHBOX_OWNER_USERNAME`/`PITCHBOX_OWNER_PASSWORD` in the environment, through
the same `createUser()` path the first-run login bootstrap uses. A no-op
(logs and exits 0) if a user already exists or either env var is unset, so
it's safe to run on every deploy - the deploy pipeline runs it right after
migrations so the owner account is never left unclaimed on a public URL. See
[auth.md](auth.md#first-run-bootstrap).

## `pitchbox user:create <username> [--admin]`

Creates an account (and default-org owner membership, same `createUser()` path `seed:owner` and first-login bootstrap use) - the way an operator with shell access gets in without writing a `password_hash` into Postgres by hand. Takes no `--email`: a CLI-created account has none, and nothing in the app can set one later, so it can never use the emailed forgot-password flow (see [auth.md](auth.md#account-recovery-from-the-shell)) - only `user:reset-password` recovers it. Fails with `user_exists` and an actionable message, not a stack trace, on a username that already exists. `--admin` grants instance-admin at creation; it is a separate, explicit flag rather than something a fresh account gets for free.

The password is never a command-line argument - it lands in shell history and is visible to every other process on the box via `ps`. It's read, in order: from `PITCHBOX_CLI_PASSWORD`, or from stdin when piped (`echo "$PW" | pitchbox user:create alice`), or from an interactive echo-suppressed prompt otherwise.

## `pitchbox user:reset-password <username>`

Sets a new password for an existing account: rehashes, revokes every one of that account's sessions, and clears its `auth_failures` login-throttle bucket - same as the self-service `/settings/password` flow, minus the "keep my own tab signed in" exception (there is no signed-in tab from a shell). Fails with `user_not_found` and an actionable message on an unknown username. Reads the password the same way `user:create` does - see above.

## `pitchbox user:list`

Read-only. Prints every account's id, username, email, instance-admin flag, and org membership/role - the fastest way to answer "who can get into this deployment" without a database client.

## When to reach for these instead of the email flow

Registration and the forgot/reset flow (see [auth.md](auth.md#registration))
cover anyone with an address, on a deployment with mail configured. Reach for
the commands above instead when either isn't true: bootstrapping or
recovering a self-host before mail is set up (the default sends nothing),
creating an account for someone without going through a public registration
form at all, or recovering any account made from the shell in the first
place - it has no email to reset by.
