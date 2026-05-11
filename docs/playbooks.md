# Playbooks

A **playbook** is the markdown the agent runner executes. Built-in playbooks ship with the repo (`playbooks/*.md`) and are seeded into the `playbooks` table as `is_builtin = true`. Users create their own from **Dashboard → Playbooks → New playbook** or by duplicating a built-in.

## Snapshot at dispatch

Each run snapshots the playbook body into `runs.playbook_body` at creation time. Editing a playbook later never retroactively changes past runs — the dispatch path always writes the snapshot to a temp file and points the runner there.

If a run has no snapshot (legacy data, or non-campaign kinds like project extraction), the dispatch path falls back to the on-disk file at `playbooks/<slug>.md`.

## Editing

Built-in rows are read-only by design — duplicate them to customise. The editor lives at `/playbooks/[id]` and posts back to `PATCH /api/playbooks/[id]`.

## CLI contract

Playbooks shell out to the `pitchbox` CLI (`bin/pitchbox`) for all DB reads/writes. The CLI is the only place that talks to Postgres from inside a run — playbooks never reach in directly. Useful commands:

- `pitchbox run:start --campaign <id>` — bootstrap a run and surface campaign / accounts / blocklist context.
- `pitchbox drafts:create --run <id>` — bulk-insert drafts from JSON on stdin.
- `pitchbox run:finish --run <id> --status success | failed` — commit terminal state.
