# AGENTS.md

Orientation for AI coding agents (Claude Code, Codex, Cursor, Aider, Gemini CLI,
…) and human contributors working in this repo. This file is the source of
truth; tool-specific files (e.g. `CLAUDE.md`) point here.

## Project

Pitchbox: self-hosted outreach agent for Reddit and Hacker News (future: other platforms). Human-in-the-loop - the system researches, drafts, and bookkeeps; the human approves and sends. Currently `0.9.0`.

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
pnpm run typecheck                   # tsc --noEmit per workspace + svelte-check
pnpm -F web check                    # svelte-check (Svelte-specific types)

# Tests - vitest, hits a real Postgres at pitchbox_test (port 5434)
pnpm test                            # full suite (fileParallelism disabled)
pnpm run test:watch
pnpm exec vitest run path/to/file.test.ts # single file
pnpm exec vitest run -t "pattern"         # single test by name
```

Tests share one Postgres DB (`pitchbox_test`) and run sequentially - do **not** re-enable `fileParallelism`. Global setup (`tests/global-setup.ts`) migrates + seeds core; teardown intentionally leaves data for inspection.

### Local verification: run the minimal covering subset

CI (`.github/workflows/ci.yml`) runs the full lint + typecheck + build + test
matrix on every push and PR - that's the gate at merge. Locally, don't re-run
the whole matrix; run just enough to catch an obviously broken PR in the code
you touched. Scope by **amount** (narrow to your diff), never by **category**
(don't skip a check CI runs - e.g. typecheck or a sub-workspace's own `check`):

```bash
# Tests - filter to the file(s)/pattern you touched, not the full suite
pnpm exec vitest run path/to/changed.test.ts
pnpm exec vitest run -t "pattern"

# Lint - `pnpm run lint` hardcodes `.` (whole repo); call the tools directly
# on your changed files instead
npx eslint path/to/changed/file.ts
npx prettier --check path/to/changed/file.ts

# Typecheck - tsc/svelte-check are whole-project by nature (no per-file mode),
# but still scope to the workspace(s) you touched, not every workspace
pnpm -F @pitchbox/shared typecheck    # or cli / daemon
pnpm -F web check                     # or @pitchbox/extension check
```

Run the full `pnpm run lint`, `pnpm run typecheck`, and `pnpm test` only for
release-critical changes (migrations, auth, the runner protocol) or when the
change is genuinely repo-wide.

## Architecture

pnpm workspaces monorepo (`pnpm-workspace.yaml`). All workspaces share a single version (`0.9.0`), and the dashboard sidebar reads that version from `web/package.json`.

**Data flow:** A campaign (scheduled by cron or triggered manually) spawns a run via the web `/api/run` endpoint. The run launches an `AgentRunner`. Local runners go through a single `AcpRunner` that drives a coding-agent backend (`claude-code`, `codex`, `gemini`, `copilot`, `opencode`, `qwen-code`) over the open Agent Client Protocol (ACP); the default `cloud` runner instead dispatches to a managed runner service that runs the agent on its own compute and relays every MCP frame back to the client (see "Cloud runner & repo layout"). The agent executes a markdown playbook from `playbooks/` and reads/writes **all** state through the **Pitchbox MCP server** (`mcp__pitchbox__*` tools) - the single data-access boundary; playbooks no longer shell out to the CLI. A human reviews drafts in the Inbox, approves, sends manually on Reddit/HN, then clicks **Mark as sent** which advances state and logs `contact_history`. The daemon polls sent DMs for replies via a pluggable `ReplyReader`.

**Workspaces:**

- **`shared/`** - the only workspace that touches the DB directly.
  - `src/db/` - Drizzle schema (`schema.ts`), client, migrations, core seed. Source of truth for the tables (see `schema.ts` for the full set): projects, accounts, campaigns, runs, run_events, drafts, draft_events, contact_history, messages, blocklist, keyword_watches, daemon_heartbeats, notifications, webhook_deliveries, extension_pairings, app_config, plus the multi-tenant tables (organizations, memberships, users).
  - `src/blocklist.ts` - `isBlocklisted` helper (global + project scope) used by `drafts:create` and the send path.
  - `src/quota.ts` / `src/quota-server.ts` - per-account usage + per-platform quota limits (loaded from `app_config.quota_defaults`, editable from Settings).
  - `src/dm-sync.ts` / `src/comment-sync.ts` - pure matchers used by the extension's `/api/extension/dm-sync` route to attribute incoming DMs and `t1` comment-replies to drafts.
  - `src/agents/` - `AgentRunner` interface (`base.ts`) and the single ACP implementation (`acp/runner.ts`) that backs every local backend (specs in `acp/backends.ts`, event normalizer + permission policy alongside; per-runner model + maxTurns reach the claude-code backend via `_meta.claudeCode.options`). `registry.ts` maps the slugs; `cloud.ts` is the `cloud` runner, which lazily loads the private client adapter (`@pitchbox/cloud-adapter`) when `PITCHBOX_EDITION=cloud`. The OSS wire contract for the cloud runner lives in `agents/cloud/protocol.ts`.
  - `src/platforms/` - Reddit (Playwright-scraped) + Hacker News (Algolia) adapters + `base-reply-reader.ts` (`ReplyReader` interface; null reader is wired today).
  - `src/runlog/` - run-event types, the failure classifier (`classify-failure.ts`), and cost/usage helpers.
  - `src/crypto.ts` - `ENCRYPTION_KEY`-backed encryption for secrets at rest.
  - Exports are pinned in `package.json` `exports` - add new public modules there, not via deep imports.

- **`cli/`** - the `pitchbox` command **and** the Pitchbox MCP server. Command logic lives in `src/commands/` (`run`, `drafts`, `reddit`, `hn`, `project`, `skill`, `utility`), extracted into plain functions that both the CLI and the MCP server call. `src/mcp/` (`server.ts` builds the server, `index.ts` is the stdio entry) exposes that surface as the `mcp__pitchbox__*` tools used by playbooks and relayed by the cloud runner. Entries `bin/pitchbox` and `bin/pitchbox-mcp` are bash wrappers running the source under `tsx`, so playbooks need no build step.

- **`web/`** - SvelteKit 2 + Svelte 5 + Tailwind 4 + shadcn-svelte. Routes: `/`, `/inbox`, `/projects`, `/campaigns` (+ `/campaigns/[id]`), `/people` (Threads / All contacts tabs, merging the old `/contacts` and `/conversations` - both still redirect there), `/conversations/[id]` (thread detail), `/blocklist`, `/playbooks`, `/notifications`, `/analytics`, `/audit`, `/settings`, plus `/login` + `/invite` when auth/orgs are on, and `/api/*` (including `/api/extension/*` for the Chrome extension and `/api/settings/*` for runner + quota config). Server-only DB access lives under `src/lib/server/`; do not import `@pitchbox/shared/db` from client code.
  - **Multi-tenant orgs and roles.** Every tenant-scoped table (projects, campaigns, drafts, runs, accounts, blocklist, contact_history, …) is scoped to an `organizations` row, reached directly or through `projects.organization_id`. Three ranked roles - `member < admin < owner` - are enforced server-side by `requireRole(event, minRole)` (`src/lib/server/auth.ts`), a no-op when `PITCHBOX_AUTH!=on` (self-host default keeps full access). See [`docs/orgs.md`](docs/orgs.md) for the tenancy/invite model and [`docs/permissions.md`](docs/permissions.md) for the full route-to-role table. `contact_history.organization_id` is `NOT NULL` and holds the org of its draft's project, so contact dedup does not cross tenants (#263); the one deliberate exception is the daemon reply poller, a system process that polls every tenant.
  - **Settings is seven flat routes, not tabs.** `/settings/status`, `/runners`, `/extension`, `/quota`, `/organization`, `/retention`, `/security`, each its own page reached from a rail in `settings/+layout.svelte` (bare `/settings` redirects to `/settings/status`). Every route enforces its own role gate in its own loader per [`docs/permissions.md`](docs/permissions.md); `status` deliberately has no loader, since daemon health is a client-side store with nothing server-side to gate. Links are deep-linkable, so point at the exact route rather than relying on the redirect. The UI hides what a member cannot use, but the API stays the actual enforcement boundary.

- **`daemon/`** - long-lived Node process running a set of independent loops. `scheduler.ts` parses `cron_expression` on active campaigns via `cron-parser` and POSTs to the web `/api/run` endpoint (the daemon never touches agent runners directly). `cron.ts` exports that same parsing as `describeCron` + `nextCronRuns` (reachable as `@pitchbox/daemon/cron`), so the campaign form's schedule preview cannot disagree with the scheduler that will actually fire it. `reply-poller.ts` drives the `ReplyReader` but only polls platforms with a real (non-Null) reader registered: it polls Mastodon (mentions via its API) and skips Null-reader platforms (Reddit, whose reply detection runs through the Chrome extension `inbox-sync`/`chat-sync` below instead). `heartbeat.ts` writes to `daemon_heartbeats` so Settings can show liveness. `retention.ts` prunes ageing run/draft events, `keyword-watcher.ts` polls saved keyword watches, and `webhook-sender.ts` drains the outbound notification-webhook queue. The same loops can run embedded inside the web process (`PITCHBOX_EMBED_DAEMON=1`) instead of as a separate process. SIGINT/SIGTERM trigger graceful shutdown.

- **`playbooks/`** - agent-agnostic markdown consumed by an `AgentRunner`: `reddit-scout`, `reddit-commenter`, `reddit-poster`, `hn-commenter`, `hn-poster`, `mastodon-scout`, `mastodon-commenter`, `mastodon-poster`, `project-extractor`, `project-insighter`, `campaign-skill-generator`, `reply-drafter`, `draft-regenerator`. They read and write state through the `mcp__pitchbox__*` MCP tools (run/campaign/project ids are bound via the session env, not chosen by the agent); they do **not** shell out to the CLI. The Mastodon three are conservative by design (see [`docs/mastodon-integration-design.md`](docs/mastodon-integration-design.md)): genuine contextual replies over volume, cold DMs discouraged, `#nobot` and opt-outs respected.
  - **Every playbook carries the same verbatim `## House style: write like a human` section**, right before its `## Steps`: the bans (em dashes and the other typographic tells, filler openers, puffery, wrap-up closers) and what to write instead, so drafts do not read as machine-written. It is duplicated on purpose, since a playbook body ships standalone (seeded into `playbooks.body`, handed to the agent as the whole prompt) and there is no include mechanism. `shared/tests/playbook-house-style.test.ts` is what keeps the copies from drifting: edit the section in one playbook and you must edit it in all of them.

- **`extension/`** - Chrome MV3 companion built with Vite + `@crxjs/vite-plugin`. Reads the `pitchbox_draft=<id>` query param the dashboard appends to compose URLs; calls bearer-token-authenticated `/api/extension/*` endpoints on the local web server to flip drafts to `sent` when the user submits on Reddit. Build with `pnpm run build:extension` then load `extension/dist/` unpacked in `chrome://extensions`. Auth is per-device: each install holds its own token, minted either by auto-pairing against the dashboard origin while logged in (`GET /api/extension/auto-pair`, session-authenticated, binds the token to the caller's active org) or by redeeming a short-lived pairing code an admin issues (`POST /api/settings/extension-pairing`, admin-only, 10 min TTL) via `POST /api/extension/pair` (public, the code itself is the one-time secret). Each token is a row in `extension_devices` (`token_hash`, `label`, `last_seen_at`), independently revocable (`DELETE /api/settings/extension-devices/:id`, admin-only).
  - Background service worker runs two pollers every 10 min via `chrome.alarms`, both posting to `POST /api/extension/dm-sync`: (1) `src/background/inbox-sync.ts` polls `reddit.com/message/inbox.json` for legacy PMs **and** comment-replies (`t1` items), splitting them into the `items[]` and `comments[]` arrays of the request body; (2) `src/background/chat-sync.ts` calls `matrix.redditspace.com/_matrix/client/v3/sync` for Reddit Chat. The server matches DMs on `(account_handle, target_user)` and comment-replies on `parent_id == drafts.platform_comment_id`, recording everything in the `messages` table and flipping draft state to `replied`. The matchers (`shared/src/dm-sync.ts` and `shared/src/comment-sync.ts`) are pure and reused across both pollers.

## Cloud runner & repo layout

The cloud runner lets the agent run on managed compute without a local agent CLI. It is **compute-only**: the runner spawns the agent plus an HTTP MCP relay and tunnels every MCP frame over a WebSocket to the client, which runs the Pitchbox MCP server locally - so data and credentials never leave the client. The wire contract is OSS (`@pitchbox/shared/agents/cloud/protocol`); the runner service and the client adapter are private. Full design + end-to-end validation: [`docs/cloud-runner.md`](docs/cloud-runner.md).

**Repo layout (umbrella).** This public repo is the umbrella. Private cloud code lives in **separate git repos under `cloud/`**: `cloud/runner` and `cloud/adapter` are tracked as **git submodules** of this umbrella (see `.gitmodules`; their content lives in the private `pitchbox-runner-service` / `pitchbox-cloud-adapter` repos, and `.gitignore` keeps any other `cloud/*` path and `private/` untracked). The runner service is at `cloud/runner/`. To land a change: commit inside the submodule and push its own remote, then bump the umbrella's submodule pointer with `git add cloud/<x>` and commit that here (never `git add` submodule content from the umbrella). Always launch agents from this repo directory: chat history is keyed by the launch path (Claude Code + Emdash), so launching from a parent/other folder loses it. The submodules use pnpm standalone and import the OSS protocol contract by relative path.

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

## The GitHub Project is the source of truth

Current state and future roadmap live on **Project #3 "Pitchbox roadmap"** (owner `fiorelorenzo`), not in this file and not in a chat transcript. Keeping it current is part of doing the work, not paperwork at the end: the board is how Lorenzo sees where the project stands without reading session logs, so a board that lags reality is worse than no board.

**Status is a claim about reality, keep it true.**

- Before you write code for an issue, move it to `In Progress`. If what you are about to do has no issue, create one first (see below), then start.
- Move it to `Done` only when the change is merged and verified, not when the code is written. Merged but something is still open? Say so in a comment and leave it `In Progress`.
- Board fields, the same four on every one of Lorenzo's roadmap boards on purpose: `Status` (`Todo` / `In Progress` / `Done`), `Priority` (P0-P3), `Effort` (S/M/L/XL) and `Parallel` (Yes/No, whether a parallel agent can take the issue without colliding with other work). Set all four on anything you file. Never write a value that is not already an option, read the schema instead of guessing, and never add, rename or drop a field on this board alone: the convention is shared across the projects.

**Comment when a reader would want to know.** A decision taken, an approach tried and abandoned, a blocker hit, a surprise in the code, a scope change, a finding that invalidates the issue as written. One comment per meaningful turn in the work, not one per commit, and no routine progress narration.

**File the work you discover.** When something real surfaces mid-task or in a conversation with Lorenzo (a bug you noticed on the way, a follow-up the fix implies, an idea worth doing later), open an issue for it instead of silently widening the current change or letting it evaporate. Then say in the current issue that you split it out, with a link.

**Conventions for a new issue.** Match what the board already shows, do not invent a parallel style:

- Title in conventional-commit form with the affected workspaces as scope, lowercase after the colon: `fix(web,shared): new projects snapshot a runner the deployment cannot launch`. A plain descriptive sentence is acceptable when no single scope fits.
- Labels follow one taxonomy, identical in every repo: exactly one `type:*` (`feature`, `fix`, `refactor`, `test`, `chore`, `ci`, `docs`, `design`, `security`, `spike`), exactly one of `priority:P0`-`priority:P3`, and one or more `area:*` naming the surfaces the change touches. `epic` and `flagship` (an epic, and headline work) are the only unprefixed labels. Priority is deliberately in two places, the `Priority` board field and the `priority:*` label, so set both.
- `area:*` values here: `cli-mcp`, `cloud`, `daemon`, `deploy`, `docs`, `extension`, `playbooks`, `shared`, `tests`, `web`. Add one only when the surface really is new, and never reintroduce an unprefixed or differently shaped label.
- Milestone: one of the `v0.10`/`v1.0`/`v1.1`/`v1.2`/`v1.3` milestones, when the work belongs to one.
- **Every issue hangs off an epic.** Epics are titled `[Epic] Name` and carry the `epic` label. Look for an open one before creating another: `gh issue list -R fiorelorenzo/pitchbox --label epic --state open`. Keep them coarse, one per coherent theme or area (for example `[Epic] Cloud runner productionization`), and parent the issue to it. Close an epic only when every child is closed; if the work it named is done but follow-ups discovered along the way still hang off it, leave it open and say so in a comment. While you are in an unparented issue anyway, give it a parent too. An issue with no parent is a defect in the board.

```bash
# Read the schema, never guess an option value
gh project field-list 3 --owner fiorelorenzo --format json
gh api repos/fiorelorenzo/pitchbox/milestones --jq '.[].title'

# Fill these three in; everything below runs as written, no placeholders to edit
ISSUE=123                 # the issue you are working on
EPIC=456                  # its parent epic
STATUS="In Progress"      # Todo | In Progress | Done

PROJECT_ID=$(gh project view 3 --owner fiorelorenzo --format json --jq '.id')
STATUS_FIELD=$(gh project field-list 3 --owner fiorelorenzo --format json \
  --jq '.fields[] | select(.name=="Status") | .id')
OPTION_ID=$(gh project field-list 3 --owner fiorelorenzo --format json \
  --jq ".fields[] | select(.name==\"Status\") | .options[] | select(.name==\"$STATUS\") | .id")
ITEM_ID=$(gh project item-list 3 --owner fiorelorenzo --format json --limit 500 \
  --jq ".items[] | select(.content.number==$ISSUE) | .id")
gh project item-edit --id "$ITEM_ID" --project-id "$PROJECT_ID" \
  --field-id "$STATUS_FIELD" --single-select-option-id "$OPTION_ID"

# New issue: create, put it on the board, hang it off its epic.
# `gh issue create` prints the new issue's URL, so capture it and reuse it.
ISSUE_URL=$(gh issue create -R fiorelorenzo/pitchbox --title "fix(cloud): ..." --body "..." \
  --label "area:cloud,type:fix,priority:P1")
gh project item-add 3 --owner fiorelorenzo --url "$ISSUE_URL"
gh api graphql -f query='mutation($p:ID!,$c:ID!){addSubIssue(input:{issueId:$p,subIssueId:$c}){subIssue{number}}}' \
  -f p="$(gh issue view $EPIC -R fiorelorenzo/pitchbox --json id --jq '.id')" \
  -f c="$(gh issue view "$ISSUE_URL" --json id --jq '.id')"
```

`item-edit` is idempotent, so re-setting a value that is already correct is a fine way to make sure the board is right. An issue can have only one parent: to move it to a different epic, pass `replaceParent: true` in the same mutation.
