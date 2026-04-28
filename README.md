# Pitchbox

Self-hosted outreach agent for Reddit (and future platforms). You keep the human-in-the-loop; Pitchbox does the research, drafting, and bookkeeping.

> ⚠️ Alpha — currently at **v0.4.0** (M6.1 shipped). Breaking changes possible until v1.0.0.

## Quick start (macOS / Linux)

**Prerequisites**: Node ≥22, Docker, the `claude` CLI logged in to your Claude subscription, an `ENCRYPTION_KEY` (generate with `openssl rand -hex 32`).

```bash
git clone <repo>
cd pitchbox
cp .env.example .env
# edit .env — set DATABASE_URL, PITCHBOX_ROOT (absolute path), ENCRYPTION_KEY
docker compose up -d postgres
npm install
npx playwright install chromium
npm run migrate
npm run -w @pitchbox/shared seed:core
cp scripts/seed-demo.ts.example scripts/seed-demo.ts
npx tsx scripts/seed-demo.ts
npm run dev            # dashboard at http://127.0.0.1:5180
npm run -w daemon dev  # (optional) scheduler + reply poller
```

### Browser extension (optional)

The companion Chrome extension does two things:

1. **Auto-mark drafts as sent.** When you submit a DM or post-comment on Reddit, the extension flips the draft from `approved` → `sent` automatically — no need to click **Mark as sent** in the dashboard.
2. **Sync DM replies back into the dashboard.** Every 10 min (and on demand) the extension reads your Reddit inbox and flips drafts to `replied` when the target user writes back. Replies appear in the Inbox draft detail and in the Conversations page.

#### Install

```bash
npm run build:extension   # outputs extension/dist/
```

In Chrome: `chrome://extensions` → enable **Developer mode** → **Load unpacked** → pick `extension/dist/`.

#### Connect to the dashboard

1. Dashboard → **Settings → Browser extension** → **Generate token**. Copy the 64-character hex token.
2. Open the Pitchbox popup (toolbar icon). Paste the dashboard URL (`http://127.0.0.1:5180` by default) and the token. Click **Connect**.
3. The popup shows _Connected — dashboard vX.Y.Z_ when the handshake succeeds.

#### Sync DM replies

Reddit ships two parallel DM systems and the extension covers both:

- **Legacy private messages** (`reddit.com/message/inbox`). The extension polls `inbox.json` every 10 min — works as long as you stay logged in to Reddit in the same Chrome profile.
- **Reddit Chat** (Matrix-based, used for all DMs sent from new Reddit). The extension auto-captures the Matrix access token from `localStorage` of any open `reddit.com` tab, then talks to `matrix.redditspace.com` directly to fetch new messages. **Open at least one reddit.com tab** while logged in for this to work — closing all Reddit tabs stops the chat sync (the popup keeps the last token but it eventually expires).

**Comment-reply tracking** is included: when someone replies to a comment you posted via Pitchbox, the same `Sync now` action picks it up. Make sure you submit your comments through the dashboard's Open post / extension flow so we can capture the comment id.

Manually trigger a sync any time from the popup → **Sync now**. The popup reports `inserted: N new, M replied`.

When a target user replies, you'll see:

- The draft state flip to **Replied** in the Inbox.
- The reply body shown under the draft, with a `replied` event on the timeline.
- A row on the **Conversations** page with the latest reply snippet.

## What ships today (v0.4.0, M0–M6.1)

**Content pipeline**

- Create projects, accounts, campaigns. Each campaign locks an agent runner (default: `claude-code`, stubs ready for `codex` / `opencode`).
- Manual "Run now" on a scout campaign → Claude Code drafts Reddit DMs via the `reddit-scout` playbook.
- Manual "Run now" on a commenter campaign → Claude Code drafts value-adding comments on relevant posts via the `reddit-commenter` playbook.
- **Blocklist enforcement at draft creation**: `drafts:create` filters out targets matching subreddit / user / keyword entries (global or per-project) and reports skipped counts back to the playbook.

**Review & send loop**

- Inbox with filters (state, kind, run, campaign), keyboard shortcuts, bulk reject.
- Approve a draft → "Open compose" deep-links to the Reddit DM compose URL or the original post/comment thread (for `post_comment` drafts).
- The Chrome extension flips drafts to `sent` automatically when you submit on Reddit (manual **Mark as sent** still available as fallback).
- Per-draft quota line surfaces remaining daily/weekly send budget; over-quota sends raise an audit warning but do not block.
- Blocklist re-checked at send time — a 409 stops the send if the target was added to the blocklist after the draft was created.

**Reply tracking (extension-driven)**

- The Chrome extension polls Reddit's legacy inbox **and** Reddit Chat (Matrix) every 10 min and POSTs new messages to `/api/extension/dm-sync`.
- DM replies match on `(account_handle, target_user)`; comment-replies match on `parent_id == drafts.platform_comment_id`. Both flip the draft to `replied` and append a `replied` event.
- **Conversations** page lists every reply thread, with a kind filter (DM / comment) and per-kind deep links back to the original Reddit thread.

**Dashboard & admin**

- **Home** — drafts awaiting review, approved-not-sent, 24h sent, reply rate, 7-day run health, unique contacts; live recent-runs + campaigns panels.
- **Inbox** — filters, bulk actions, per-draft quota line, blocklist warnings, draft detail with timeline of events and inline reply body.
- **Campaigns** — list with live "Running" state and the last status + time + duration on a single row; detail page with expandable per-run log rows.
- **Contacts** — every outreach with platform/account/kind, plus a `replied` badge.
- **Conversations** — reply threads across DMs and comment-replies, with kind filter.
- **Blocklist** — add/remove subreddit / user / keyword entries, scoped globally or per-project.
- **Settings** — tabbed layout (Status / Integrations / Quota): daemon heartbeat, agent runner info, extension API token (generate / rotate), editable per-platform quota limits.

**Daemon**

- Node process (`npm run -w daemon dev`) that writes heartbeats to `daemon_heartbeats`, wakes up on a tick, and:
  - triggers active campaigns whose `cron_expression` is due (parsed with `cron-parser`) via the web `/api/run` endpoint,
  - polls sent DMs for replies through a pluggable `ReplyReader` interface (null reader wired today; the Chrome extension covers reply ingestion in practice).
- Graceful SIGINT/SIGTERM shutdown.

## Architecture

Monorepo using npm workspaces. Every workspace versions to the same number (`0.3.0` today), and the sidebar version is sourced from `web/package.json`.

- **Postgres** (via Docker) — single source of truth: projects, campaigns, runs, run events, drafts, draft events, contact history, blocklist, daemon heartbeats.
- **`shared/`** — Drizzle schema + migrations, platform adapters (Reddit), `AgentRunner` + `ReplyReader` interfaces, run-log parsers (claude-code + stubs for codex/opencode).
- **`cli/`** — the `pitchbox` CLI that playbooks call to read/write DB (`run:start`, `run:finish`, `reddit:scout`, `drafts:create`, …).
- **`web/`** — SvelteKit 2 + Svelte 5 + Tailwind 4 + shadcn-svelte dashboard. Routes: `/` (home), `/inbox`, `/campaigns`, `/campaigns/[id]`, `/contacts`, `/conversations`, `/blocklist`, `/settings`.
- **`daemon/`** — heartbeat + scheduler + reply poller (real DM reader still pending).
- **`extension/`** — Chrome MV3 companion (Vite + `@crxjs/vite-plugin`) that auto-marks drafts as `sent` when you submit on Reddit and polls your DM inbox to flip drafts to `replied` once the target user writes back.
- **`playbooks/`** — agent-agnostic markdown instructions consumed by the `AgentRunner`.

## Roadmap

- ✅ **M0** — repo scaffold, Postgres, Drizzle migrations, CLI skeleton
- ✅ **M1** — reddit-scout + reddit-commenter playbooks, Inbox, manual "Run now"
- ✅ **M2** — mark-as-sent flow, Home dashboard, Contacts, Blocklist, daemon scaffold (heartbeat + cron scheduler + reply-poller skeleton)
- ✅ **M3** — Chrome extension, auto mark-as-sent for DM compose + post-comment drafts
- ✅ **M4** — DM reply tracking via the extension's inbox poller, Conversations UI (post-comment reply tracking deferred to M4.5)
- ✅ **M4.5** — comment-reply tracking via the extension's inbox poller
- ✅ **M5** — blocklist enforcement (creation + send) + advisory rate-limiting (Inbox badge + over-quota warning); safety brake deferred
- ✅ **M6.1** — full project CRUD (UI + API; basic fields + versioned configs + accounts)
- ⏳ **M6.2** — templates (few-shot examples + reusable snippets, scoped to project, override per campaign)
- ⏳ **M6.x** — keyword watches, analytics, A/B tests
- ⏳ **M7+** — additional platform adapters, posting automation, team mode

## Agent runners

Each campaign snapshots its runner at creation time; each run snapshots the runner it used. Today only `claude-code` is implemented (spawns `claude -p --verbose --output-format stream-json`). `codex` and `opencode` adapters exist as typed stubs so new runners can be wired in without touching the rest of the pipeline.

## License

**AGPL-3.0-or-later** for the open-source (self-hosted) edition — see
[LICENSE](./LICENSE). A future **Pitchbox Cloud** edition will ship under a
separate commercial licence. See [NOTICE.md](./NOTICE.md) for the full dual-
licensing framework and the contributor terms.
