# Concepts

## Projects

A **project** is a single product, brand, or initiative you're doing outreach for. Each project owns its accounts, campaigns, and contact history.

## Accounts

An **account** is a platform identity (e.g. `u/myhandle` on Reddit) tied to a project. Accounts carry a `platformId` plus optional encrypted credentials. Each `(project, platform)` pair can have one **default** account - the dispatch path surfaces it first to the playbook.

## Campaigns

A **campaign** scopes an outreach intent: which platform, which skill (`reddit-scout` for DMs, `reddit-commenter` for comment-replies, `reddit-poster` for top-level posts), which agent runner, which cron schedule. Campaigns snapshot their runner at creation; runs snapshot the runner and playbook at start.

### Campaign readiness and live setup banner

Each campaign page evaluates a small readiness check on every load (`web/src/lib/server/campaign-readiness.ts`) and renders the result as a banner at the top of the page. Two kinds of items can appear:

- **Blocking issues** (orange "Setup required" header): the campaign cannot run until they are resolved. Examples: profile not generated, profile invalid against the skill schema, no account linked to the project, agent runner CLI not installed. Each blocking issue has an action button (Generate profile, Add account, Open settings, ...).
- **In-progress operations** (amber "In progress" header with a spinner, no button): a long-running operation is already executing against this campaign. Today this surfaces a `campaign_skill_generation` run, i.e. the agent producing the profile. The banner reads "Generating campaign profile…" and updates live: the page subscribes to the dashboard's SSE stream and re-invalidates the readiness snapshot when a relevant `run:started` / `run:finished` arrives, so the banner clears itself without a manual refresh.

The page also reads two booleans alongside the issues list, `generatingProfile` and `campaignRunning`, and uses them to disable redundant triggers. The "Run now" button shows "Running…" while a `campaign` run for this campaign is alive; clicking "Generate profile" while a generation is already running raises a toast instead of opening the modal.

Project description extraction follows the same pattern: the **Auto-extract** button on a project page disables itself while a `project_extraction` run is alive (`extractionRunning` derived in `ProjectOverviewTab.svelte`).

## Runs

A **run** is one execution of a campaign or background task. The dashboard streams `run_events` as the agent works, including normalised tool-use / message events. The run-log UI (`web/src/lib/components/RunLog.svelte`) coalesces ACP-streamed `agent_message_chunk` tokens into a single assistant bubble per turn, pairs `tool_call` with its `tool_call_update` completion so each tool invocation renders as one expandable row with command + output, and timestamps every event with a granular `Ns ago` / `Nm Ks ago` label (see `relativeTimeFine` in `web/src/lib/utils/time.ts`).

## Drafts

A **draft** is the agent's proposed outreach - DM, post, post comment, or comment reply. Drafts live in `pending_review` until a human approves, rejects, or sends them. Edits made in the dashboard are saved on the draft for future reference.

## Contact history & conversations

Once a draft is sent, the row in `contact_history` becomes the per-target source of truth. The Chrome extension picks up replies (DMs and comment-replies) and the **Conversations** page lists every thread; clicking a row opens `/conversations/<thread-id>`, a Matrix/iMessage-style transcript that renders the parent draft and every captured message, with outgoing bubbles right-aligned in the primary color and incoming bubbles left-aligned in muted styling. When an inbound reply lands, `enqueueReplyDraft` materialises an auto-drafted reply (V1 ships a placeholder body) that surfaces at the bottom of the thread with Approve / Reject actions; a textarea lets reviewers edit or override the suggested body before sending.

## Audit feed

The `/audit` page surfaces a unified, time-ordered feed of every recorded event in the system. It unions `draft_events` (state transitions, approvals, rejections, sends - each tagged with an `actor`) with `run_events` (agent runner stream output and lifecycle markers) via a single `UNION ALL` query, discriminating each row by a synthetic `kind` column (`draft` or `run`). Rows are ordered newest first by `(created_at, id)` and the page exposes filters for event name, draft id, run id, actor, and a date range. Each leg is filtered before the union so the indexes on `draft_events_kind_created_idx` and `run_events_kind_created_idx` stay usable. Keyset pagination on `(created_at, id)` powers the "Load more" button.

## Blocklist

`blocklist` covers users, subreddits, and keywords. The dispatch path consults it before drafting; the send path consults it again before flipping a draft to `sent`. Scope is global or per-project.

## i18n

Pitchbox ships with a tiny hand-rolled i18n module at `web/src/lib/i18n/`. English (`dict-en.ts`) is the source of truth; other locales (today just `dict-it.ts`) mirror its keys and fall back to English when a key is missing. In Svelte components, use the reactive store: `import { t } from '$lib/i18n'` then `{$t('nav.inbox')}`. Templates support `{name}` placeholders interpolated by `t()`. To add a key, add it to `dict-en.ts` first, then mirror it in every other locale dictionary. To contribute a new locale, copy `dict-en.ts` to `dict-<code>.ts`, translate the values, register it in `index.ts`, and add the code to `LOCALES` in `types.ts`. The active locale is exposed via `setLocale()` / `getLocale()` and will eventually be persisted in `app_config.ui_locale`.

## Templates (few-shot examples)

Each project owns a list of **templates** - short, agent-facing examples that anchor the voice of generated drafts. A template has a `kind` (`dm`, `comment`, or `post`), a human-friendly `title`, a `body`, and an `isActive` flag for archiving without deletion. Manage them from **Projects → [project] → Templates**.

Active templates are loaded by `pitchbox run:start` and surfaced to the playbook under a `templates` key, so the agent can quote them verbatim or paraphrase tone-of-voice. Archived templates are excluded. Campaign-level overrides are reserved for a future release; today templates are project-wide.

## Project insights

Each project accumulates an outreach history - drafts sent, replies recorded, runs executed. **Project insights** ask an LLM to read that history once a day and write a short Markdown brief: which subreddits convert, which opening lines correlate with replies, what to stop doing. The brief lives in the `project_insights` table; the dashboard's **Projects → [project] → Insights** tab renders the latest row, with a **Regenerate now** button for ad-hoc refresh.

Insights are produced by the `project-insighter` playbook (see `playbooks.md`). The daemon's insights worker schedules one run per active project per day, skipping projects without recent activity or with a fresh insight already on file. Evidence is stored as JSON citing draft/message IDs so any claim can be audited back to the source.

When a project has fewer than 5 drafts the playbook emits a "Not enough data yet" stub instead of fabricating patterns from thin air.

## Contact deduplication

Pitchbox tracks every successful outreach in `contact_history`. Before creating a draft, `pitchbox drafts:create` queries `shared/src/contact-dedup.ts` (`checkContactDedup`) against the same `(platform, target_user)` pair within a configurable window.

Behaviour is governed by `app_config.dedup_policy`:

```json
{ "window_days": 90, "mode": "warn" }
```

- `warn` (default): the draft is still created but `drafts.dedup_warning` is set, and the inbox shows an amber `dedup` badge next to the target.
- `skip`: the draft is not created at all, and the CLI returns it under `dedupSkipped` alongside blocklist skips.

## Inline edit of draft body

While a draft is in `pending_review` or `proposed`, reviewers can rewrite the body in-place from the inbox detail panel. The endpoint `PATCH /api/drafts/[id]` accepts `{ body }`, bumps the optimistic `version`, sets `drafts.body_edited = true`, and records a `body_edited` draft_event carrying the prior body for audit. Once the draft transitions out of those states the endpoint returns 409.

## Bulk inbox actions

The inbox toolbar exposes two bulk endpoints that operate on the current row selection:

- `POST /api/drafts/bulk-approve` `{ ids: number[] }` flips eligible drafts to `approved`. Drafts already past review (or with a stale `version`) are returned as `{ status: 'skipped', reason }`.
- `POST /api/drafts/bulk-reschedule` `{ ids, send_after }` sets `drafts.scheduled_send_after`. `evaluateDraftSend` treats a future `scheduled_send_after` as "not ready to send" so the quota path remains the single source of truth.

Both endpoints return `{ results: [{ id, status, reason? }] }` so the UI can surface partial successes accurately.

## Regenerating drafts with reviewer feedback

The inbox detail panel offers a `Regenerate` action alongside Approve/Reject. The user can optionally supply a short hint (e.g. "shorter and warmer"); the API `POST /api/drafts/[id]/regenerate` invokes the shared helper which records the hint into `draft_regeneration_hints`, increments `drafts.regeneration_count`, and appends a `regenerated` draft_event. The same helper backs `pitchbox drafts:regenerate <id>` so CLI-triggered regenerations leave the same audit trail.

## LLM-judge quality scoring

New drafts can be scored 0-100 by an LLM judge invoked from `shared/src/quality-judge.ts`. The rubric and thresholds live in `app_config.quality_rubric`:

```json
{
  "rubric_template": "Score the draft 0-100 on clarity, relevance, personalization, tone. Return JSON.",
  "threshold_red": 40,
  "threshold_green": 75
}
```

The score, reason and judge model are persisted on `drafts.quality_score`, `drafts.quality_reason`, `drafts.quality_model`. The inbox renders a colour-coded `Q<score>` badge next to each draft (red `< threshold_red`, green `>= threshold_green`, amber in between) and exposes a `?minQuality=<n>` filter on the URL.

Scoring is inline: the agent that writes a draft body (on creation, regeneration, or reply) scores it 0-100 against `rubric_template` and passes the score back on the same tool call that persists the body, so every draft is scored at write time with no separate scoring pass.

## A/B variant drafts

A playbook may surface multiple alternative bodies for the same target by including a `variants: ["...", "..."]` array in each `drafts:create` entry (the primary `body` is variant A, each entry of `variants` becomes B, C, ...). The CLI persists every sibling with a shared `variant_group_id` and an alphabetical `variant_label`.

Approving (or sending) one variant cascade-rejects every still-pending sibling in the same group through `shared/src/draft-variants.ts:cascadeRejectSiblings`, which appends a `rejected` draft_event with `details.reason = "variant_lost"` and the winning draft id. The inbox renders each variant with its label badge so reviewers can compare them side-by-side.

## Reply drafting

When the extension's dm-sync flips an outbound draft to `replied`, Pitchbox automatically enqueues a continuation draft via `shared/src/reply-drafter.ts:enqueueReplyDraft`. The new draft uses `kind = 'reply_dm'` (or `'reply_comment'`) and stores the inbound message's id on `drafts.parent_message_id` so the runner / reviewer can rebuild the full conversation history.

V1 inserts a placeholder body and a `reply_drafting_enqueued` draft_event; a future iteration will spawn an agent runner with `playbooks/reply-drafter.md` to fill in the real body. The Conversations page surfaces the pending reply with Approve / Reject buttons.
