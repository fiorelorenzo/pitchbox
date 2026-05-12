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
