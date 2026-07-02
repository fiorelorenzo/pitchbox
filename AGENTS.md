# AGENTS.md

Orientation for AI coding agents (Claude Code, Codex, Cursor, Aider, Gemini CLI,
…) and human contributors working in this repo. This file is the source of
truth; tool-specific files (e.g. `CLAUDE.md`) point here.

## Project

Pitchbox: self-hosted outreach agent for Reddit and Hacker News (future: other platforms). Human-in-the-loop - the system researches, drafts, and bookkeeps; the human approves and sends. Alpha, currently `0.4.0`.

## Commands

Requires Node ≥22, pnpm 9.15 (via corepack), Docker, and the `claude` CLI logged into a Claude subscription. An `ENCRYPTION_KEY` (32-byte hex) must be set in `.env`.

```bash
# DB (port 5434 on host, not 5432 - shared by dev + test DBs)
pnpm run db:up                       # start Postgres
pnpm run migrate                     # apply Drizzle migrations to DATABASE_URL
pnpm run migrate:generate            # regenerate SQL after schema.ts edits
pnpm -F @pitchbox/shared seed:core

# Dev - ONE command launches EVERYTHING (postgres + migrations + web + daemon +
# cloud runner + extension + docs), hot-reloaded, on the host. See scripts/dev.sh.
pnpm run dev                         # web on 127.0.0.1:5180, docs on :5181
# RUNNER_PORT=8790 pnpm run dev      # if 8787 is taken
pnpm run dev:web                     # just the web (or dev:extension / dev:docs)

# Quality gates
pnpm run lint                        # eslint + prettier --check
pnpm run format                      # prettier --write
pnpm run typecheck                   # tsc -b (project references)
pnpm -F web check                    # svelte-check (Svelte-specific types)

# Tests - vitest, hits a real Postgres at pitchbox_test (port 5434)
pnpm test                            # full suite (fileParallelism disabled)
pnpm run test:watch
pnpm exec vitest run path/to/file.test.ts # single file
pnpm exec vitest run -t "pattern"         # single test by name
```

Tests share one Postgres DB (`pitchbox_test`) and run sequentially - do **not** re-enable `fileParallelism`. Global setup (`tests/global-setup.ts`) migrates + seeds core; teardown intentionally leaves data for inspection.

## Architecture

pnpm workspaces monorepo (`pnpm-workspace.yaml`). All workspaces share a single version (`0.4.0`), and the dashboard sidebar reads that version from `web/package.json`.

**Data flow:** A campaign (scheduled by cron or triggered manually) spawns a run via the web `/api/run` endpoint. The run launches an `AgentRunner`. Every runner goes through a single `AcpRunner` that drives a coding-agent backend (`claude-code`, `codex`, `gemini`, `copilot`, `opencode`, `qwen-code`) over the open Agent Client Protocol (ACP); a `cloud` runner that dispatches to managed compute is stubbed (see "Cloud runner & repo layout"). The agent executes a markdown playbook from `playbooks/` and reads/writes **all** state through the **Pitchbox MCP server** (`mcp__pitchbox__*` tools) - the single data-access boundary; playbooks no longer shell out to the CLI. A human reviews drafts in the Inbox, approves, sends manually on Reddit/HN, then clicks **Mark as sent** which advances state and logs `contact_history`. The daemon polls sent DMs for replies via a pluggable `ReplyReader`.

**Workspaces:**

- **`shared/`** - the only workspace that touches the DB directly.
  - `src/db/` - Drizzle schema (`schema.ts`), client, migrations, core seed. Source of truth for all tables: projects, accounts, campaigns, runs, run_events, drafts, draft_events, contact_history, messages, blocklist, daemon_heartbeats, app_config.
  - `src/blocklist.ts` - `isBlocklisted` helper (global + project scope) used by `drafts:create` and the send path.
  - `src/quota.ts` / `src/quota-server.ts` - per-account usage + per-platform quota limits (loaded from `app_config.quota_defaults`, editable from Settings).
  - `src/dm-sync.ts` / `src/comment-sync.ts` - pure matchers used by the extension's `/api/extension/dm-sync` route to attribute incoming DMs and `t1` comment-replies to drafts.
  - `src/agents/` - `AgentRunner` interface (`base.ts`) and the single ACP implementation (`acp/runner.ts`) that backs every backend (specs in `acp/backends.ts`, event normalizer + permission policy alongside). `registry.ts` maps the slugs; `cloud.ts` is the stub for the managed cloud runner. The OSS wire contract for the cloud runner lives in `agents/cloud/protocol.ts`.
  - `src/platforms/` - Reddit (Playwright-scraped) + Hacker News (Algolia) adapters + `base-reply-reader.ts` (`ReplyReader` interface; null reader is wired today).
  - `src/runlog/` - run-event types, the failure classifier (`classify-failure.ts`), and cost/usage helpers.
  - `src/crypto.ts` - `ENCRYPTION_KEY`-backed encryption for secrets at rest.
  - Exports are pinned in `package.json` `exports` - add new public modules there, not via deep imports.

- **`cli/`** - the `pitchbox` command **and** the Pitchbox MCP server. Command logic lives in `src/commands/` (`run`, `drafts`, `reddit`, `hn`, `project`, `skill`, `utility`), extracted into plain functions that both the CLI and the MCP server call. `src/mcp/` (`server.ts` builds the server, `index.ts` is the stdio entry) exposes that surface as the `mcp__pitchbox__*` tools used by playbooks and relayed by the cloud runner. Entries `bin/pitchbox` and `bin/pitchbox-mcp` are bash wrappers running the source under `tsx`, so playbooks need no build step.

- **`web/`** - SvelteKit 2 + Svelte 5 + Tailwind 4 + shadcn-svelte. Routes: `/`, `/inbox`, `/campaigns`, `/campaigns/[id]`, `/contacts`, `/conversations`, `/blocklist`, `/settings`, plus `/api/*` (including `/api/extension/*` for the Chrome extension and `/api/settings/quota` for editable quota limits). Server-only DB access lives under `src/lib/server/`; do not import `@pitchbox/shared/db` from client code.

- **`daemon/`** - long-lived Node process. `scheduler.ts` parses `cron_expression` on active campaigns via `cron-parser` and POSTs to the web `/api/run` endpoint (the daemon never touches agent runners directly). `reply-poller.ts` drives the `ReplyReader`. `heartbeat.ts` writes to `daemon_heartbeats` so Settings can show liveness. SIGINT/SIGTERM trigger graceful shutdown.

- **`playbooks/`** - agent-agnostic markdown consumed by an `AgentRunner`: `reddit-scout`, `reddit-commenter`, `reddit-poster`, `hn-commenter`, `hn-poster`, `project-extractor`, `project-insighter`, `campaign-skill-generator`, `reply-drafter`. They read and write state through the `mcp__pitchbox__*` MCP tools (run/campaign/project ids are bound via the session env, not chosen by the agent); they do **not** shell out to the CLI.

- **`extension/`** - Chrome MV3 companion built with Vite + `@crxjs/vite-plugin`. Reads the `pitchbox_draft=<id>` query param the dashboard appends to compose URLs; calls token-authenticated `/api/extension/*` endpoints on the local web server to flip drafts to `sent` when the user submits on Reddit. Build with `pnpm run build:extension` then load `extension/dist/` unpacked in `chrome://extensions`. Token lives in `app_config.extension_api_token` (generate/rotate from Settings).
  - Background service worker runs two pollers every 10 min via `chrome.alarms`, both posting to `POST /api/extension/dm-sync`: (1) `src/background/inbox-sync.ts` polls `reddit.com/message/inbox.json` for legacy PMs **and** comment-replies (`t1` items), splitting them into the `items[]` and `comments[]` arrays of the request body; (2) `src/background/chat-sync.ts` calls `matrix.redditspace.com/_matrix/client/v3/sync` for Reddit Chat. The server matches DMs on `(account_handle, target_user)` and comment-replies on `parent_id == drafts.platform_comment_id`, recording everything in the `messages` table and flipping draft state to `replied`. The matchers (`shared/src/dm-sync.ts` and `shared/src/comment-sync.ts`) are pure and reused across both pollers.

## Cloud runner & repo layout

The cloud runner lets the agent run on managed compute without a local agent CLI. It is **compute-only**: the runner spawns the agent plus an HTTP MCP relay and tunnels every MCP frame over a WebSocket to the client, which runs the Pitchbox MCP server locally - so data and credentials never leave the client. The wire contract is OSS (`@pitchbox/shared/agents/cloud/protocol`); the runner service and the client adapter are private. Full design + end-to-end validation: [`docs/cloud-runner.md`](docs/cloud-runner.md).

**Repo layout (umbrella).** This public repo is the umbrella. Private cloud code lives in **separate git repos nested in the gitignored `cloud/` (and `private/`) dirs** that the public repo never tracks - the runner service is at `cloud/runner/`. Always launch agents from this repo directory: chat history is keyed by the launch path (Claude Code + Emdash), so launching from a parent/other folder loses it. Nested private repos use pnpm standalone and import the OSS protocol contract by relative path.

## Docker (cloud-edition deployment)

The client stack (web + daemon + Postgres) ships as Docker via `Dockerfile.app`
plus the `docker-compose.app.*` overlays, parameterised by `.env` (copy
`.env.docker.example`). The web is a SvelteKit **adapter-node** build run under
`node --import tsx`: the app is bundled, but `@pitchbox/*` stay **external** and
load from TS source at runtime (see `web/vite.config.ts`), which keeps their CJS
deps - ajv via the MCP SDK, the reddit stealth stack - out of the ESM bundle where
`require()` would be undefined. The daemon runs from TS source via tsx. The web
image bundles Google Chrome (the Reddit MCP tool scrapes with Playwright
`channel: 'chrome'`, client-side). `pnpm -F web dev` (Vite) is the dev overlay.

```bash
# The main dev command runs everything on the HOST + postgres in Docker (see the
# Dev section above): `pnpm run dev`. The Docker variant below runs the whole stack
# IN Docker instead (postgres + migrations + web + daemon + cloud runner), same
# local-Claude auth; it does NOT include the extension/docs.
pnpm run docker:dev

# prod: restart, resource limits, optional cloudflared tunnel (--profile tunnel)
docker compose -f docker-compose.yml -f docker-compose.app.yml -f docker-compose.app.prod.yml up -d
```

The Docker stack is **cloud edition only**: it sets `PITCHBOX_EDITION=cloud` and
dispatches every run to a cloud runner (`PITCHBOX_RUNNER_URL`), whose image lives
in `cloud/runner/` (its own `Dockerfile` + compose). The build context is the
umbrella root so the web's Vite alias can bundle the private `cloud/adapter`.

`pnpm run dev` (and `docker:dev`) use the **cloud** runner. To develop with a
**local** runner edition instead (no cloud runner - the web spawns a local agent
CLI like `claude-code` directly), run without `PITCHBOX_EDITION=cloud`:
`pnpm run db:up && pnpm run migrate`, then `pnpm run dev:web` + `pnpm -F daemon dev`
with a local agent CLI installed. The Docker images deliberately omit the local
agent CLIs to stay lean.

## Conventions

- **DB access is centralised in `shared/`.** CLI, web server routes, and daemon all import from `@pitchbox/shared/db` (and subpaths). Never spin up an ad-hoc `pg` client.
- **Runner indirection.** Each campaign snapshots its runner at creation, each run snapshots it again. Code that dispatches a run reads the snapshot - do not hardcode `claude-code`.
- **Platform indirection.** Same for `ReplyReader` - the null reader is the current default for Reddit until a real DM reader lands (M3).
- **`PITCHBOX_ROOT`** in `.env` must be an absolute path; the daemon and CLI use it to locate the repo when spawned by an agent from a different cwd.
- **Secrets.** Account credentials are encrypted with `ENCRYPTION_KEY` via `shared/src/crypto.ts`. Never log decrypted secrets or commit `.env`.
- **Do not run tests against the dev DB.** Vitest pins `DATABASE_URL` to `pitchbox_test` in `vitest.config.ts`; if you override it, match that pattern.
- **Migrations.** Edit `shared/src/db/schema.ts`, run `pnpm run migrate:generate`, then `pnpm run migrate`. Never hand-edit generated SQL unless you also regenerate.
- **English everywhere.** All in-code comments and user-facing UI strings are in English (even when the conversation is in another language). No em dashes in any text - use regular hyphens or colons.
