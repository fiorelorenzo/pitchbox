# Pitchbox

Self-hosted outreach agent for Reddit (and future platforms). You keep the human-in-the-loop; Pitchbox does the research, drafting, and bookkeeping.

> ⚠️ Alpha — currently at **v0.2.0** (M2 shipped; M3 in development branch). Breaking changes possible until v1.0.0.

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

Auto-flip drafts to `sent` when you submit them on Reddit, instead of clicking **Mark as sent** in the dashboard.

```bash
npm run build:extension   # outputs extension/dist/
```

Then in Chrome: `chrome://extensions` → enable _Developer mode_ → **Load unpacked** → pick `extension/dist/`. In the dashboard Settings → Browser extension, click **Generate token**, then paste the dashboard URL + token into the extension popup and click **Connect**.

## What ships today (v0.2.0, M0–M2)

**Content pipeline**

- Create projects, accounts, campaigns. Each campaign locks an agent runner (default: `claude-code`, stubs ready for `codex` / `opencode`).
- Manual "Run now" on a scout campaign → Claude Code drafts Reddit DMs via the `reddit-scout` playbook.
- Manual "Run now" on a commenter campaign → Claude Code drafts value-adding comments on relevant posts via the `reddit-commenter` playbook.

**Review & send loop**

- Inbox with filters (state, kind, run, campaign), keyboard shortcuts, bulk reject.
- Approve a draft → the "Open compose" button unlocks; after sending on Reddit, click **Mark as sent** to log the final content, add a row to `contact_history`, and advance the draft to `sent`.

**Dashboard & admin**

- **Home** — drafts awaiting review, approved-not-sent, 24h sent, reply rate, 7-day run health, unique contacts; live recent-runs + campaigns panels.
- **Campaigns** — list with live "Running" state and the last status + time + duration on a single row; detail page with expandable per-run log rows.
- **Contacts** — every outreach with platform/account/kind, plus a `replied` badge driven by the daemon.
- **Blocklist** — add/remove subreddit / user / keyword entries, scoped globally or per-project.
- **Settings** — live daemon heartbeat status, agent runner info.

**Daemon (M2)**

- Node process (`npm run -w daemon dev`) that writes heartbeats to `daemon_heartbeats`, wakes up on a tick, and:
  - triggers active campaigns whose `cron_expression` is due (parsed with `cron-parser`) via the web `/api/run` endpoint,
  - polls sent DMs for replies through a pluggable `ReplyReader` interface (null reader wired for Reddit until a real DM reader lands).
- Graceful SIGINT/SIGTERM shutdown.

## Architecture

Monorepo using npm workspaces. Every workspace versions to the same number (`0.2.0` today), and the sidebar version is sourced from `web/package.json`.

- **Postgres** (via Docker) — single source of truth: projects, campaigns, runs, run events, drafts, draft events, contact history, blocklist, daemon heartbeats.
- **`shared/`** — Drizzle schema + migrations, platform adapters (Reddit), `AgentRunner` + `ReplyReader` interfaces, run-log parsers (claude-code + stubs for codex/opencode).
- **`cli/`** — the `pitchbox` CLI that playbooks call to read/write DB (`run:start`, `run:finish`, `reddit:scout`, `drafts:create`, …).
- **`web/`** — SvelteKit 2 + Svelte 5 + Tailwind 4 + shadcn-svelte dashboard. Routes: `/` (home), `/inbox`, `/campaigns`, `/campaigns/[id]`, `/contacts`, `/blocklist`, `/settings`.
- **`daemon/`** — heartbeat + scheduler + reply poller (real DM reader still pending).
- **`extension/`** — Chrome MV3 companion (Vite + `@crxjs/vite-plugin`) that auto-marks drafts as `sent` when you submit on Reddit. DM reply sync comes in M4.
- **`playbooks/`** — agent-agnostic markdown instructions consumed by the `AgentRunner`.

## Roadmap

- ✅ **M0** — repo scaffold, Postgres, Drizzle migrations, CLI skeleton
- ✅ **M1** — reddit-scout + reddit-commenter playbooks, Inbox, manual "Run now"
- ✅ **M2** — mark-as-sent flow, Home dashboard, Contacts, Blocklist, daemon scaffold (heartbeat + cron scheduler + reply-poller skeleton)
- ✅ **M3** — Chrome extension, auto mark-as-sent for DM compose + post-comment drafts
- ⏳ **M4** — reply tracking: live Reddit DM reader + post-reply poller, Conversations UI
- ⏳ **M5** — safety brake + blocklist enforcement + smart rate-limiting
- ⏳ **M6** — templates, keyword watches, analytics, A/B tests
- ⏳ **M7+** — additional platform adapters, posting automation, team mode

## Agent runners

Each campaign snapshots its runner at creation time; each run snapshots the runner it used. Today only `claude-code` is implemented (spawns `claude -p --verbose --output-format stream-json`). `codex` and `opencode` adapters exist as typed stubs so new runners can be wired in without touching the rest of the pipeline.

## License

**AGPL-3.0-or-later** for the open-source (self-hosted) edition — see
[LICENSE](./LICENSE). A future **Pitchbox Cloud** edition will ship under a
separate commercial licence. See [NOTICE.md](./NOTICE.md) for the full dual-
licensing framework and the contributor terms.
