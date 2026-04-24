# Pitchbox

Self-hosted outreach agent for Reddit (and future platforms). You keep the human-in-the-loop; Pitchbox does the research, drafting, and bookkeeping.

> ⚠️ Alpha. Breaking changes possible until v1.0.0.

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
npm run dev   # opens http://127.0.0.1:5180
```

## What works (M0+M1)

- Create a project, accounts, campaigns.
- Click "Run now" on a scout campaign → Claude Code drafts Reddit DMs via the `reddit-scout` playbook.
- Click "Run now" on a commenter campaign → Claude Code drafts value-adding comments on relevant posts via the `reddit-commenter` playbook.
- Review drafts in the Inbox (filter by kind: DMs / Posts / Comments / Replies), approve, click "Open" — launches the appropriate Reddit URL (compose for DMs, permalink for comments).

## Architecture

- **Postgres** (via Docker) — all state: projects, campaigns, runs, drafts, draft events, contact history, blocklist.
- **`shared/`** — Drizzle schema, platform adapters (Reddit), `AgentRunner` interface.
- **`cli/`** — the `pitchbox` CLI that playbooks call to read/write DB.
- **`web/`** — SvelteKit dashboard (Tailwind 4, Svelte 5): Inbox, Campaigns, Settings.
- **`daemon/`** _(future)_ — scheduler + reply pollers + safety brake.
- **`extension/`** _(future)_ — Chrome MV3 extension for mark-as-sent + DM reply sync.
- **`playbooks/`** — agent-agnostic markdown instructions consumed by the `AgentRunner`.

## Roadmap

- ✅ M0: repo scaffold, Postgres, Drizzle migrations, CLI skeleton
- ✅ M1: reddit scout + commenter playbooks, Inbox, manual "Run now"
- ⏳ M2: cron scheduler + daemon + reddit-poster playbook
- ⏳ M3: Chrome extension + automatic sent tracking
- ⏳ M4: reply tracking (post comments + DMs via extension)
- ⏳ M5: safety brake + blocklist enforcement + smart rate-limiting
- ⏳ M6+: templates, keyword watches, analytics, A/B tests

## License

MIT
