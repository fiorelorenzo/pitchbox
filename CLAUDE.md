# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Pitchbox: self-hosted outreach agent for Reddit (future: other platforms). Human-in-the-loop — the system researches, drafts, and bookkeeps; the human approves and sends. Alpha, currently `0.2.0` (M2 shipped).

## Commands

Requires Node ≥22, Docker, and the `claude` CLI logged into a Claude subscription. An `ENCRYPTION_KEY` (32-byte hex) must be set in `.env`.

```bash
# DB (port 5433 on host, not 5432 — shared by dev + test DBs)
npm run db:up                       # start Postgres
npm run migrate                     # apply Drizzle migrations to DATABASE_URL
npm run migrate:generate            # regenerate SQL after schema.ts edits
npm run -w @pitchbox/shared seed:core

# Dev
npm run dev                         # web dashboard (127.0.0.1:5180)
npm run -w daemon dev               # scheduler + reply poller (optional)

# Quality gates
npm run lint                        # eslint + prettier --check
npm run format                      # prettier --write
npm run typecheck                   # tsc -b (project references)
npm run -w web check                # svelte-check (Svelte-specific types)

# Tests — vitest, hits a real Postgres at pitchbox_test (port 5433)
npm test                            # full suite (fileParallelism disabled)
npm run test:watch
npx vitest run path/to/file.test.ts # single file
npx vitest run -t "pattern"         # single test by name
```

Tests share one Postgres DB (`pitchbox_test`) and run sequentially — do **not** re-enable `fileParallelism`. Global setup (`tests/global-setup.ts`) migrates + seeds core; teardown intentionally leaves data for inspection.

## Architecture

npm workspaces monorepo. All workspaces share a single version (`0.2.0`), and the dashboard sidebar reads that version from `web/package.json`.

**Data flow:** A campaign (scheduled by cron or triggered manually) spawns a run via the web `/api/run` endpoint. The run launches an `AgentRunner` (today only `claude-code`, which spawns `claude -p --verbose --output-format stream-json`). The agent executes a markdown playbook from `playbooks/` — the playbook shells out to the `pitchbox` CLI (`bin/pitchbox`) to read/write the DB and produce drafts. A human reviews drafts in the Inbox, approves, sends manually on Reddit, then clicks **Mark as sent** which advances state and logs `contact_history`. The daemon polls sent DMs for replies via a pluggable `ReplyReader`.

**Workspaces:**

- **`shared/`** — the only workspace that touches the DB directly.
  - `src/db/` — Drizzle schema (`schema.ts`), client, migrations, core seed. Source of truth for all tables: projects, accounts, campaigns, runs, run_events, drafts, draft_events, contact_history, blocklist, daemon_heartbeats.
  - `src/agents/` — `AgentRunner` interface (`base.ts`), `claude-code.ts` implementation, registry. `codex` and `opencode` exist only as typed stubs.
  - `src/platforms/` — Reddit adapter + `base-reply-reader.ts` (`ReplyReader` interface; null reader is wired today).
  - `src/runlog/` — parsers per agent runner, converting stream output into run events.
  - `src/crypto.ts` — `ENCRYPTION_KEY`-backed encryption for secrets at rest.
  - Exports are pinned in `package.json` `exports` — add new public modules there, not via deep imports.

- **`cli/`** — the `pitchbox` command invoked by playbooks. Commands live in `src/commands/` (`run`, `drafts`, `reddit`, `utility`). Entry `bin/pitchbox` is a bash wrapper that runs `cli/src/index.ts` under `tsx`, so playbooks need no build step.

- **`web/`** — SvelteKit 2 + Svelte 5 + Tailwind 4 + shadcn-svelte. Routes: `/`, `/inbox`, `/campaigns`, `/campaigns/[id]`, `/contacts`, `/blocklist`, `/settings`, plus `/api/*`. Server-only DB access lives under `src/lib/server/`; do not import `@pitchbox/shared/db` from client code.

- **`daemon/`** — long-lived Node process. `scheduler.ts` parses `cron_expression` on active campaigns via `cron-parser` and POSTs to the web `/api/run` endpoint (the daemon never touches agent runners directly). `reply-poller.ts` drives the `ReplyReader`. `heartbeat.ts` writes to `daemon_heartbeats` so Settings can show liveness. SIGINT/SIGTERM trigger graceful shutdown.

- **`playbooks/`** — agent-agnostic markdown consumed by an `AgentRunner`. Today: `reddit-scout.md`, `reddit-commenter.md`. They assume `bin/pitchbox` is on PATH within the agent sandbox.

- **`extension/`** — Chrome MV3 companion built with Vite + `@crxjs/vite-plugin`. Reads the `pitchbox_draft=<id>` query param the dashboard appends to compose URLs; calls token-authenticated `/api/extension/*` endpoints on the local web server to flip drafts to `sent` when the user submits on Reddit. Build with `npm run build:extension` then load `extension/dist/` unpacked in `chrome://extensions`. Token lives in `app_config.extension_api_token` (generate/rotate from Settings).
  - Background service worker runs two pollers every 10 min via `chrome.alarms`, both posting to `POST /api/extension/dm-sync`: (1) `src/background/dm-sync.ts` polls `reddit.com/message/inbox.json` for legacy PMs; (2) `src/background/chat-sync.ts` calls `matrix.redditspace.com/_matrix/client/v3/sync` for Reddit Chat (Matrix-based), using the access token captured by the `chat-token` content script from `localStorage` on any reddit.com tab. The server matches on `(account_handle, target_user)` → `contact_history`, records replies in the `messages` table, and flips draft state to `replied`. The matcher (`shared/src/dm-sync.ts`) is pure and shared by both pollers — they only differ in how they fetch raw messages.

## Conventions

- **DB access is centralised in `shared/`.** CLI, web server routes, and daemon all import from `@pitchbox/shared/db` (and subpaths). Never spin up an ad-hoc `pg` client.
- **Runner indirection.** Each campaign snapshots its runner at creation, each run snapshots it again. Code that dispatches a run reads the snapshot — do not hardcode `claude-code`.
- **Platform indirection.** Same for `ReplyReader` — the null reader is the current default for Reddit until a real DM reader lands (M3).
- **`PITCHBOX_ROOT`** in `.env` must be an absolute path; the daemon and CLI use it to locate the repo when spawned by an agent from a different cwd.
- **Secrets.** Account credentials are encrypted with `ENCRYPTION_KEY` via `shared/src/crypto.ts`. Never log decrypted secrets or commit `.env`.
- **Do not run tests against the dev DB.** Vitest pins `DATABASE_URL` to `pitchbox_test` in `vitest.config.ts`; if you override it, match that pattern.
- **Migrations.** Edit `shared/src/db/schema.ts`, run `npm run migrate:generate`, then `npm run migrate`. Never hand-edit generated SQL unless you also regenerate.
