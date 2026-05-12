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

## Blocklist

`blocklist` covers users, subreddits, and keywords. The dispatch path consults it before drafting; the send path consults it again before flipping a draft to `sent`. Scope is global or per-project.
