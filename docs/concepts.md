# Concepts

## Projects

A **project** is a single product, brand, or initiative you're doing outreach for. Each project owns its accounts, campaigns, and contact history.

## Accounts

An **account** is a platform identity (e.g. `u/myhandle` on Reddit) tied to a project. Accounts carry a `platformId` plus optional encrypted credentials. Each `(project, platform)` pair can have one **default** account — the dispatch path surfaces it first to the playbook.

## Campaigns

A **campaign** scopes an outreach intent: which platform, which skill (`reddit-scout` for DMs, `reddit-commenter` for comment-replies, `reddit-poster` for top-level posts), which agent runner, which cron schedule. Campaigns snapshot their runner at creation; runs snapshot the runner and playbook at start.

## Runs

A **run** is one execution of a campaign or background task. The dashboard streams `run_events` as the agent works, including normalised tool-use / message events.

## Drafts

A **draft** is the agent's proposed outreach — DM, post, post comment, or comment reply. Drafts live in `pending_review` until a human approves, rejects, or sends them. Edits made in the dashboard are saved on the draft for future reference.

## Contact history & conversations

Once a draft is sent, the row in `contact_history` becomes the per-target source of truth. The Chrome extension picks up replies (DMs and comment-replies) and the **Conversations** page lists every thread; clicking a row opens `/conversations/<thread-id>`, a Matrix/iMessage-style transcript that renders the parent draft and every captured message, with outgoing bubbles right-aligned in the primary color and incoming bubbles left-aligned in muted styling. A composer placeholder is shown at the bottom — reply drafting from the dashboard is coming next.

## Audit feed

The `/audit` page surfaces a unified, time-ordered feed of every recorded event in the system. It unions `draft_events` (state transitions, approvals, rejections, sends — each tagged with an `actor`) with `run_events` (agent runner stream output and lifecycle markers) via a single `UNION ALL` query, discriminating each row by a synthetic `kind` column (`draft` or `run`). Rows are ordered newest first by `(created_at, id)` and the page exposes filters for event name, draft id, run id, actor, and a date range. Each leg is filtered before the union so the indexes on `draft_events_kind_created_idx` and `run_events_kind_created_idx` stay usable. Keyset pagination on `(created_at, id)` powers the "Load more" button.

## Blocklist

`blocklist` covers users, subreddits, and keywords. The dispatch path consults it before drafting; the send path consults it again before flipping a draft to `sent`. Scope is global or per-project.

## i18n

Pitchbox ships with a tiny hand-rolled i18n module at `web/src/lib/i18n/`. English (`dict-en.ts`) is the source of truth; other locales (today just `dict-it.ts`) mirror its keys and fall back to English when a key is missing. In Svelte components, use the reactive store: `import { t } from '$lib/i18n'` then `{$t('nav.inbox')}`. Templates support `{name}` placeholders interpolated by `t()`. To add a key, add it to `dict-en.ts` first, then mirror it in every other locale dictionary. To contribute a new locale, copy `dict-en.ts` to `dict-<code>.ts`, translate the values, register it in `index.ts`, and add the code to `LOCALES` in `types.ts`. The active locale is exposed via `setLocale()` / `getLocale()` and will eventually be persisted in `app_config.ui_locale`.

## Templates (few-shot examples)

Each project owns a list of **templates** — short, agent-facing examples that anchor the voice of generated drafts. A template has a `kind` (`dm`, `comment`, or `post`), a human-friendly `title`, a `body`, and an `isActive` flag for archiving without deletion. Manage them from **Projects → [project] → Templates**.

Active templates are loaded by `pitchbox run:start` and surfaced to the playbook under a `templates` key, so the agent can quote them verbatim or paraphrase tone-of-voice. Archived templates are excluded. Campaign-level overrides are reserved for a future release; today templates are project-wide.

## Project insights

Each project accumulates an outreach history — drafts sent, replies recorded, runs executed. **Project insights** ask an LLM to read that history once a day and write a short Markdown brief: which subreddits convert, which opening lines correlate with replies, what to stop doing. The brief lives in the `project_insights` table; the dashboard's **Projects → [project] → Insights** tab renders the latest row, with a **Regenerate now** button for ad-hoc refresh.

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
