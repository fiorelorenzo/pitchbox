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

## Tuning a campaign (campaign-skill-generator)

Each campaign exposes a **Tuning** tab that runs the `campaign-skill-generator` playbook in **preview** mode. The agent drafts a fresh JSON profile (matching the scenario schema) but does NOT touch `campaigns.config`. Instead, both the previous config and the freshly generated config are stashed on the run row (`runs.params.previousConfig` and `runs.params.generatedConfig`).

Workflow:

1. Open the campaign, switch to **Tuning**, describe the change in natural language ("tighten the tone, add r/foo, drop the disclosure line"), and click **Tune this campaign**.
2. The dashboard subscribes to the `run:finished` SSE event. When the run completes, the UI renders a unified line diff (red = removed, green = added) between `previousConfig` and `generatedConfig`.
3. Review the diff and either:
   - **Adopt** → `POST /api/campaigns/:id/skill-runs/:runId/adopt` copies `generatedConfig` into `campaigns.config`, flips a `draft` campaign to `active`, and marks the run `params.adopted = true`.
   - **Discard** → `POST /api/campaigns/:id/skill-runs/:runId/discard` leaves `campaigns.config` untouched and marks the run `params.discarded = true` for audit.
4. Past tuning runs (up to the last 20) are listed in the same tab with timestamp, status, and adopted/discarded badge — a "View diff" button restores the diff view for any historical run that still has a `generatedConfig`.

The legacy **Profile → Regenerate** dialog still runs in `apply` mode (auto-writes the new profile) for parity with prior releases; the Tuning tab is the recommended surface for human-in-the-loop tuning.

## Templates injected into runs

`pitchbox run:start` includes a `templates` array in its output containing every **active** template for the campaign's project, filtered by an inferred kind (e.g. `reddit-commenter` and `reddit-scout` request `kind = 'comment'`). Each entry has `{ id, kind, title, body }`. Playbooks can quote these in prompts to ground drafts in the project's voice; if no templates exist, the array is empty and the playbook should fall back to whatever defaults it ships.

Manage templates under **Projects → [project] → Templates** in the dashboard, or via `POST /api/projects/:id/templates` and `PATCH /api/projects/:id/templates/:templateId`.
