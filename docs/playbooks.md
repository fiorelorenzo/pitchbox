# Playbooks

A **playbook** is the markdown the agent runner executes. Built-in playbooks ship with the repo (`playbooks/*.md`) and are seeded into the `playbooks` table as `is_builtin = true`. Users create their own from **Dashboard → Playbooks → New playbook** or by duplicating a built-in.

## Snapshot at dispatch

Each run snapshots the playbook body into `runs.playbook_body` at creation time. Editing a playbook later never retroactively changes past runs - the dispatch path always writes the snapshot to a temp file and points the runner there.

If a run has no snapshot (legacy data, or non-campaign kinds like project extraction), the dispatch path falls back to the on-disk file at `playbooks/<slug>.md`.

## Editing

Built-in rows are read-only by design - duplicate them to customise. The editor lives at `/playbooks/[id]` and posts back to `PATCH /api/playbooks/[id]`.

## MCP tool contract

Playbooks never shell out to the `pitchbox` CLI and never touch Postgres directly. All state reads and writes go through the **Pitchbox MCP server** (`bin/pitchbox-mcp`), exposed to the agent as `mcp__pitchbox__*` tools. The run, campaign, and project ids are bound to the session by the dispatcher through environment variables (`PITCHBOX_RUN_ID`, `PITCHBOX_CAMPAIGN_ID`, `PITCHBOX_PROJECT_ID`) - the agent never chooses or passes an id itself; every tool defaults to the id already bound to its run when the argument is omitted.

The full tool surface (`cli/src/mcp/server.ts`), grouped by what calls it:

- `run_start` / `run_finish` - open and close a run; `run_start` loads the campaign, project, accounts, blocklist, recently-contacted handles, and few-shot templates in one call.
- `blocklist_check`, `contact_history_check` - dedup guards a playbook can call before drafting.
- `reddit_scout`, `staging_candidates`, `subreddit_snapshot`, `hn_search`, `mastodon_scout` - platform research helpers used by the scout/commenter/poster playbooks.
- `drafts_create`, `drafts_get`, `drafts_update` - the draft CRUD surface every playbook writes through.
- `draft_regen_start` / `draft_regen_finish` - the draft-regenerator playbook's contract.
- `reply_draft_start` / `reply_draft_finish` - the reply-drafter playbook's contract.
- `project_extract_start` / `project_extract_finish` - the project-extractor playbook's contract.
- `project_insights_context` / `project_insights` - the project-insighter playbook's contract.
- `skill_generate_start` / `skill_generate_finish` - the campaign-skill-generator playbook's contract.

Each tool's Zod input schema and description live next to its implementation in `cli/src/mcp/server.ts`. The same command functions back both the MCP tools and the `pitchbox` CLI (see [`docs/cli.md`](cli.md)), so the CLI remains useful for driving or debugging this surface from a shell, but playbooks themselves only ever call the MCP tools.

## Mastodon playbooks (mastodon-scout, mastodon-commenter, mastodon-poster)

At scenario parity with Reddit (`scout` -> DM, `commenter`, `poster`), but deliberately conservative in tone: the fediverse is bot-averse, so all three playbooks prioritize genuine, contextual replies over volume, discourage cold DMs (drafting one only when the candidate has already engaged with the project or is explicitly asking for what it offers), and treat a run that produces zero drafts as a success. All three discover candidates via `mastodon_scout` (hashtag-timeline discovery, honoring the `#nobot` hard rule server-side) plus `staging_candidates`, and never call the send path themselves - a Mastodon `dm`/`post_comment`/`post` draft is sent later, on human approval, either manually or automatically via `mcp__pitchbox__mastodon_post` when the campaign's `autoPost` flag is on. See [`docs/mastodon-integration-design.md`](mastodon-integration-design.md) for the full platform design.

## Tuning a campaign (campaign-skill-generator)

Each campaign exposes a **Tuning** tab that runs the `campaign-skill-generator` playbook in **preview** mode. The agent drafts a fresh JSON profile (matching the scenario schema) but does NOT touch `campaigns.config`. Instead, both the previous config and the freshly generated config are stashed on the run row (`runs.params.previousConfig` and `runs.params.generatedConfig`).

Workflow:

1. Open the campaign, switch to **Tuning**, describe the change in natural language ("tighten the tone, add r/foo, drop the disclosure line"), and click **Tune this campaign**.
2. The dashboard subscribes to the `run:finished` SSE event. When the run completes, the UI renders a unified line diff (red = removed, green = added) between `previousConfig` and `generatedConfig`.
3. Review the diff and either:
   - **Adopt** → `POST /api/campaigns/:id/skill-runs/:runId/adopt` copies `generatedConfig` into `campaigns.config`, flips a `draft` campaign to `active`, and marks the run `params.adopted = true`.
   - **Discard** → `POST /api/campaigns/:id/skill-runs/:runId/discard` leaves `campaigns.config` untouched and marks the run `params.discarded = true` for audit.
4. Past tuning runs (up to the last 20) are listed in the same tab with timestamp, status, and adopted/discarded badge - a "View diff" button restores the diff view for any historical run that still has a `generatedConfig`.

The legacy **Profile → Regenerate** dialog still runs in `apply` mode (auto-writes the new profile via `skill_generate_finish`) for parity with prior releases; the Tuning tab is the recommended surface for human-in-the-loop tuning.

## Templates injected into runs

`run_start` returns a `templates` array in its result, containing every **active** template for the campaign's project, filtered by an inferred kind (e.g. `reddit-commenter` and `reddit-scout` request `kind = 'comment'`). Each entry has `{ id, kind, title, body }`. Playbooks can quote these in prompts to ground drafts in the project's voice; if no templates exist, the array is empty and the playbook should fall back to whatever defaults it ships.

Manage templates under **Projects → [project] → Templates** in the dashboard, or via `POST /api/projects/:id/templates` and `PATCH /api/projects/:id/templates/:templateId`.

## project-insighter

Reads a project's drafts, messages and recent runs, and emits a short Markdown summary citing draft/message IDs as evidence.

- **Context tool:** `project_insights_context` (no arguments; the project is bound via `PITCHBOX_PROJECT_ID`) returns the project name, draft/reply counts, and a sample of recent drafts and messages.
- **Submit tool:** the playbook writes a single `{summaryMd, evidence}` payload and calls `project_insights` with it, which inserts one row into `project_insights`.
- **Gate:** if `draftCount < 5` the playbook emits a "Not enough data yet" stub instead of speculating.
- **Cadence:** the daemon's insights worker schedules at most one run per active project per 24h (and only if the project saw draft/message activity in that window).
- **Rendering:** the latest row is shown verbatim under **Projects → [project] → Insights** via the dashboard's Markdown component.

## A/B variant drafts (#20)

Playbooks may emit multiple bodies for a single target by adding a `variants` array to a draft object, alongside the primary `body`, in the array passed to `drafts_create`. Example payload:

```json
[
  {
    "accountId": 1,
    "kind": "dm",
    "targetUser": "bob",
    "body": "Variant A body…",
    "variants": ["Variant B body…", "Variant C body…"]
  }
]
```

Pitchbox materialises each body as a separate draft sharing a `variant_group_id` and an alphabetical label (`A`, `B`, `C`, …). Approving one variant flips the others to `rejected` with reason `variant_lost`.

## reply-drafter (#49)

`playbooks/reply-drafter.md` is invoked once per incoming reply that matches a previously-sent draft, with the reply bound to the run via `PITCHBOX_RUN_ID`. It calls `reply_draft_start` (no arguments) to load the placeholder reply draft, the parent outbound draft (for voice), and the full thread history in chronological order, then writes a single short continuation back with `reply_draft_finish`. It never sends.

## draft-regenerator (#22)

`playbooks/draft-regenerator.md` runs when a reviewer clicks **Regenerate** on a pending draft in the Inbox, optionally with a hint about what to change. It calls `draft_regen_start` (no arguments; the draft is bound via `PITCHBOX_RUN_ID`) to load the draft body, its target, the reviewer hint, the platform, and the originating persona, then rewrites the body to satisfy the hint while keeping the same voice, target, and platform constraints. `draft_regen_finish` overwrites the draft body, bumps its version, records the previous body for undo (`POST /api/drafts/:id/regenerate/undo`), and finalizes the run. It never sends and never touches any draft other than the one bound to the run.
