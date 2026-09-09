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
# extension + docs), hot-reloaded, on the host. See scripts/dev.sh.
pnpm run dev                         # web on 127.0.0.1:5180, docs on :5181
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

**Fresh devbox: `pitchbox_test` doesn't exist until you create it.**
`docker-compose.yml` only provisions `POSTGRES_DB=pitchbox` (the dev DB);
global setup migrates `pitchbox_test` but never creates it, so a first run
fails at `migrate` with an InitPostgres error. One-time fix: `docker exec
pitchbox-postgres psql -U pitchbox -d pitchbox -c "CREATE DATABASE
pitchbox_test OWNER pitchbox;"` - it then persists in the `pitchbox-pg-data`
volume until `docker compose down -v`.

**There are two vitest configs, and a third one for compliance.** The root
`vitest.config.ts` is what CI runs and what a `pnpm exec vitest run` from the
repo root uses. `extension/vitest.config.ts` exists so a workspace-scoped
`pnpm -F @pitchbox/extension exec vitest run` resolves the same Svelte the root
config does: it merges `extension/vite.config.ts` (which is also the crxjs
build config, so the fix does not belong there) with
`resolve.conditions: ['browser']`. Without it, Svelte resolves to its server
build and every `mount()` test fails in the workspace run while passing in CI,
which cost a bisect against `main` before #339 fixed it. Both entry points now
report the same 239 tests.

Both configs compile Svelte now, so a test can mount a real component and read
its rendered shadow root rather than a hand-written stand-in. That is why
`@sveltejs/vite-plugin-svelte` is a root devDependency: without it the root
config, which is the one CI runs, could not compile a component test, and
`panel-host.ts`'s `update()` was able to ship as a silent no-op behind an
`expect(...).not.toThrow()` for exactly that reason (#369).

**A content script that renders a Svelte panel is built by us, not by crxjs.**
crxjs builds every `contentScripts.standaloneFiles` entry through a nested Vite
build that hardcodes `plugins: []` (`@crxjs/vite-plugin@2.7.1`,
`dist/index.mjs:1397`), so `svelte()` never runs there and a panel component
fails to parse. That path is not optional: a dynamically registered MV3 script
cannot be an ES module, and registering dynamically is what keeps the LinkedIn
host permission optional (#317). So:

- `extension/src/content/panel-scripts.ts` is the registry. Both
  `extension/vite-plugins/panel-content-scripts.ts` (which emits the IIFE) and
  the background worker's registration read it, so the emitted path and the
  registered path cannot drift. A panel-bearing script goes there, never in
  `standaloneFiles`.
- `extension/src/content/panel.css` must stay **plain CSS**. That build runs no
  Tailwind, so a `@theme`, `@source`, `@custom-variant` or `@import 'tailwindcss'`
  in it resolves to nothing, and the symptom is an unstyled panel on a page we
  do not own rather than an error. `assertNoTailwindDirectives` fails the build
  if one comes back.
- The check that a new content script is really shipped is
  `ls extension/dist/src/content/` after `pnpm run build:extension`, plus
  confirming the file has no top-level `import`/`export`. A script missing from
  the registry still builds, as a module with a loader, and Chrome then refuses
  to run it. No suite notices, which is how #366 nearly shipped.
- The compliance checker knows both mechanisms: rule 2's scan set is the static
  `content_scripts`, plus any `registerContentScripts` call whose matches
  mention LinkedIn, plus the panel registry. A LinkedIn-looking script under
  `content/` that none of the three accounts for is itself a violation.

`pnpm run test:linkedin-compliance` is a **third** config
(`vitest.compliance.config.ts`) and a required CI check. It is not a unit suite:
it parses the real extension source and manifest and fails the build on six
prohibitions (no request toward linkedin.com or licdn, no cookie or storage read
inside a LinkedIn content script, no synthetic click or submit on a
`linkedin-dom.ts` node, no alarm reachable from LinkedIn code, no network call
in the LinkedIn platform directory, and `https://www.linkedin.com/*` staying an
optional host permission rather than a blanket grant). Run it before touching
anything under `extension/src/content/linkedin-*` or the manifest. Rule 2
derives its scan set from the static `content_scripts` **and** from any
`chrome.scripting.registerContentScripts` call whose matches mention LinkedIn,
because the LinkedIn grant is optional and its scripts register at runtime; a
LinkedIn-looking script under `content/` that no registration accounts for is
itself a violation, so wire the registration rather than working around the
checker (#350).

### Local verification: run the minimal covering subset

CI (`.github/workflows/ci.yml`) now has three tiers. On a PR it runs a single
scoped `quality` job (lint + typecheck + build) - skipped entirely when the
diff can't touch it, per the `changes` filter job. `Tests (Postgres)` no
longer runs on a PR at all: it moved to `push: main`, since it's the heaviest
job (5.2m) and doesn't need to block a review. The `ci` job aggregates all of
the above (skips count as passing) and is the one required status check.
Locally, don't try to reproduce the whole matrix; run just enough to catch an
obviously broken PR in the code you touched. Scope by **amount** (narrow to
your diff), never by **category** (don't skip a check CI runs - e.g.
typecheck or a sub-workspace's own `check`):

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
change is genuinely repo-wide. `pnpm test` is also what `preflight` runs
locally (see "CI and preflight" below) against its own disposable Postgres,
so a green `preflight` run before you push already covers it.

## Working in a worktree, next to other agents

**Isolate a parallel test run by database name, not by container.** `pnpm run
db:up` starts one Postgres (`docker-compose.yml`'s fixed `container_name:
pitchbox-postgres`, `127.0.0.1:5434`) meant to be shared by every worktree on
this box - that part is fine to share. What isn't shared by default is the
database _inside_ it: `vitest.config.ts`'s `testDatabaseUrl()` and
`tests/global-setup.ts` both default to `pitchbox_test`, but honor a
`DATABASE_URL` override only when it still names `pitchbox_test` or
`pitchbox_test_<suffix>` - anything else is silently ignored, on purpose, so a
stray real-DB URL can never reach the test suite. Two worktrees running `pnpm
test` against that default therefore share one `pitchbox_test` and do collide;
`fileParallelism: false` only keeps files inside one run from colliding with each
other, not one worktree from another. To isolate, create the database once
(`psql postgres://pitchbox:pitchbox@127.0.0.1:5434/pitchbox -c "CREATE DATABASE
pitchbox_test_<suffix>"`) and export `DATABASE_URL=postgres://pitchbox:pitchbox@
127.0.0.1:5434/pitchbox_test_<suffix>` before `pnpm test` - nothing creates that
database for you.

**And it has to be exported, not written into the worktree's `.env`.** That
distinction cost a wave of parallel agents a round of results on 2026-09-04.
`vitest.config.ts`'s `testDatabaseUrl()` and `tests/global-setup.ts` both read
`process.env.DATABASE_URL` at config-load time, while dotenv only loads much
later, inside `shared/src/db/client.ts`. So a `DATABASE_URL` that exists only in
`.env` is not visible when the decision is made: `pnpm test` and `pnpm run
migrate` fall back to the shared `pitchbox_test`, four worktrees truncate the
same tables in each other's `beforeEach`, and the failures read like flaky tests
rather than like a collision. `set -a && source .env && set +a` in the shell that
runs the command works; putting the value in `.env` alone does not. Confirm it
rather than assuming, since the fallback is silent:
`psql "$DATABASE_URL" -c 'select current_database()'`.

**`.env` has two values a second worktree can't reuse as-is.** `PITCHBOX_ROOT`
(`.env.example`) must be this worktree's own absolute path - the daemon and CLI
use it to locate the repo when an agent spawns them from elsewhere, and a stale
value pointing at a sibling worktree silently operates on the wrong checkout.
`WEB_PORT` (`web/vite.config.ts` sets `strictPort: true`, so a collision fails
loudly instead of sliding to the next port) needs to differ if two worktrees run
`pnpm run dev` at once. `ENCRYPTION_KEY` can be shared as-is; it only needs to be
_a_ valid 32-byte hex, not one per worktree.

**The two `cloud/*` submodules are optional for a fresh worktree, and after
#420 nothing needs them at all.** `git worktree add` doesn't populate them -
that needs its own `git submodule update --init`, against two private repos
your credentials may not reach. Neither is in `pnpm-workspace.yaml`'s package
list, and nothing in the umbrella (Vite config, Dockerfile, compose) references
either anymore: `pnpm install`, `pnpm test`, `pnpm run dev`, `pnpm run dev:web`,
and `pnpm run docker:dev` all work identically with `cloud/` present or entirely
absent, including the default cloud-edition dev loop - it dispatches to the
in-process SDK runner, not to either submodule.

**Migrations are drizzle-generated, so two migration-authoring issues in one
wave collide.** `pnpm run migrate:generate` (`drizzle-kit generate`) numbers the
next file sequentially under `shared/src/db/migrations/` and rewrites
`shared/src/db/migrations/meta/_journal.json` alongside it. Two agents
generating at the same time produce the same next number and both edit the
journal - a rebase doesn't resolve that; the second one waits for the first to
land, then regenerates rather than hand-renumbering.
(`shared/src/db/migrations_archive/README.md` is the record of what happens when
this drifts unrecovered: `generate` was unusable repo-wide for months until the
schema was squashed into today's `0000_baseline.sql`.)

**CI's `quality` job checks more than lint/typecheck/build; the two deploy
workflows aren't reproducible here.** It also runs `pnpm run version:check`
(workspace versions in lockstep, #207) - easy to miss since "Local verification"
above only calls out lint/typecheck/test. `deploy-preview.yml` (on every CI
success on `main`) and `deploy-prod.yml` (on a `v*` tag) both run on
`[self-hosted, prodbox]` and rsync into `/opt/apps/pitchbox{-preview}/`: nothing
local reproduces either, so don't report them as verified.

**CI and preflight.** The one required status check on `main` is `ci`, an
aggregate job that needs every other job in `.github/workflows/ci.yml` and
treats a `skipped` dependency as passing - that's what lets a docs-only PR go
green without paying for `quality` or `Tests (Postgres)`. `Tests (Postgres)`
only runs on `push: main` now; its PR-path replacement is `preflight`
(`.github/preflight.json`), which runs `pnpm test` locally against a
disposable Postgres on `127.0.0.1:5490` (`docker-compose.preflight.yml`,
its own compose project so it can never touch the dev Postgres on 5434).
Run `preflight` (or let the installed `pre-push` hook run it) before you
push; `preflight --list` shows what it would run for your current diff.

**Merging requires a PR, squash-only, and cleans up after itself.** Two active
rulesets (`gh api repos/fiorelorenzo/pitchbox/rulesets`) protect `main`:
deletion and non-fast-forward pushes are blocked outright, and a pull request is
required with `allowed_merge_methods: ["squash"]` - a direct `git push` to
`main` is rejected, not just discouraged, and the other two merge buttons
(`allow_merge_commit`, `allow_rebase_merge`) are off at the repo level too.
`delete_branch_on_merge` is on, so a merged branch is gone from `origin` on its
own - nothing to clean up by hand.

## Architecture

pnpm workspaces monorepo (`pnpm-workspace.yaml`). All workspaces share a single version (`0.9.0`), and the dashboard sidebar reads that version from `web/package.json`.

**Data flow:** A campaign (scheduled by cron or triggered manually) spawns a run via the web `/api/run` endpoint. The run launches an `AgentRunner`. Local runners go through a single `AcpRunner` that drives a coding-agent backend (`claude-code`, `codex`, `gemini`, `copilot`, `opencode`, `qwen-code`) over the open Agent Client Protocol (ACP); the default `cloud` runner instead drives the same model loop in-process against the AI Gateway - no separate compute service, no relay (see "Cloud runner & repo layout"). The agent executes a markdown playbook from `playbooks/` and reads/writes **all** state through the **Pitchbox MCP server** (`mcp__pitchbox__*` tools) - the single data-access boundary; playbooks no longer shell out to the CLI. A human reviews drafts in the Inbox, approves, sends manually on Reddit/HN, then clicks **Mark as sent** which advances state and logs `contact_history`. The daemon polls sent DMs for replies via a pluggable `ReplyReader`.

**Workspaces:**

- **`shared/`** - the only workspace that touches the DB directly.
  - `src/db/` - Drizzle schema (`schema.ts`), client, migrations, core seed. Source of truth for the tables (see `schema.ts` for the full set): projects, accounts, campaigns, runs, run_events, drafts, draft_events, contact_history, messages, blocklist, keyword_watches, daemon_heartbeats, notifications, webhook_deliveries, extension_pairings, app_config, plus the multi-tenant tables (organizations, memberships, users).
  - `src/blocklist.ts` - `isBlocklisted` helper (global + project scope) used by `drafts:create` and the send path.
  - `src/quota.ts` / `src/quota-server.ts` - per-account usage + per-platform quota limits (loaded from `app_config.quota_defaults`, editable from Settings).
  - `src/dm-sync.ts` / `src/comment-sync.ts` - pure matchers used by the extension's `/api/extension/dm-sync` route to attribute incoming DMs and `t1` comment-replies to drafts.
  - `src/agents/` - `AgentRunner` interface (`base.ts`) and the single ACP implementation (`acp/runner.ts`) that backs every local backend (specs in `acp/backends.ts`, event normalizer + permission policy alongside; per-runner model + maxTurns reach the claude-code backend via `_meta.claudeCode.options`). `registry.ts` maps the slugs; `sdk/runner.ts` is the `cloud` runner - an ordinary `AgentRunner` that drives the model loop in-process against the AI Gateway (`AI_GATEWAY_API_KEY`), no separate compute service.
  - `src/platforms/` - Reddit (Playwright-scraped) + Hacker News (Algolia) adapters + `base-reply-reader.ts` (`ReplyReader` interface; null reader is wired today).
  - `src/runlog/` - run-event types, the failure classifier (`classify-failure.ts`), and cost/usage helpers.
  - `src/crypto.ts` - `ENCRYPTION_KEY`-backed encryption for secrets at rest.
  - Exports are pinned in `package.json` `exports` - add new public modules there, not via deep imports.

- **`cli/`** - the `pitchbox` command **and** the Pitchbox MCP server. Command logic lives in `src/commands/` (`run`, `drafts`, `reddit`, `hn`, `project`, `skill`, `utility`), extracted into plain functions that both the CLI and the MCP server call. `src/mcp/` (`server.ts` builds the server, `index.ts` is the stdio entry) exposes that surface as the `mcp__pitchbox__*` tools used by playbooks and reached in-process by the cloud runner over an in-memory transport (`shared/src/agents/sdk/tools.ts`). Entries `bin/pitchbox` and `bin/pitchbox-mcp` are bash wrappers running the source under `tsx`, so playbooks need no build step.

- **`web/`** - SvelteKit 2 + Svelte 5 + Tailwind 4 + shadcn-svelte. Routes: `/`, `/inbox`, `/projects`, `/campaigns` (+ `/campaigns/[id]`), `/people` (Threads / All contacts tabs, merging the old `/contacts` and `/conversations` - both still redirect there), `/conversations/[id]` (thread detail), `/blocklist`, `/playbooks`, `/notifications`, `/analytics`, `/audit`, `/settings`, plus `/login`, `/register`, `/invite/[token]` and `/reset` (+ `/reset/[token]`) when auth/orgs are on, and `/api/*` (including `/api/extension/*` for the Chrome extension and `/api/settings/*` for runner + quota config). Server-only DB access lives under `src/lib/server/`; do not import `@pitchbox/shared/db` from client code.
  - **Multi-tenant orgs and roles.** Every tenant-scoped table (projects, campaigns, drafts, runs, accounts, blocklist, contact_history, …) is scoped to an `organizations` row, reached directly or through `projects.organization_id`. Three ranked roles - `member < admin < owner` - are enforced server-side by `requireRole(event, minRole)` (`src/lib/server/auth.ts`), a no-op when `PITCHBOX_AUTH!=on` (self-host default keeps full access). An account is never magic: it comes from the first-run login bootstrap, `pitchbox seed:owner`, self-registration at `POST /api/auth/register` (gated by `app_config.registration_policy` - `open`/`invite`/`off`, code default `invite`, `shared/src/registration-policy.ts`), an org invite accepted at `/invite/[token]`, or `pitchbox user:create`. See [`docs/auth.md`](docs/auth.md) for all of these and [`docs/orgs.md`](docs/orgs.md) for the tenancy/invite model. The trap: `users.email` is nullable and only registration ever writes it - `seed:owner`, the login bootstrap, and `user:create` all leave it null, and no route or CLI command can set one on an account afterward, so those accounts can never use the emailed forgot-password flow (`@pitchbox/shared/mail`, a null transport by default until `MAIL_PROVIDER` is set - #528) and stay CLI-only for password recovery permanently, not just until mail is configured. See [`docs/permissions.md`](docs/permissions.md) for the full route-to-role table. `contact_history.organization_id` is `NOT NULL` and holds the org of its draft's project, so contact dedup does not cross tenants (#263); the one deliberate exception is the daemon reply poller, a system process that polls every tenant.
  - **Settings is ten flat routes, not tabs.** `/settings/status`, `/runners`, `/extension`, `/quota`, `/organization`, `/retention`, `/security`, `/linkedin-assist`, `/companion`, `/password` (#506, self-service password change - gated on being signed in at all rather than an org role, 404s when auth is off), each its own page reached from a rail in `settings/+layout.svelte` (bare `/settings` redirects to `/settings/status`). Every route enforces its own role gate in its own loader per [`docs/permissions.md`](docs/permissions.md); `status` deliberately has no loader, since daemon health is a client-side store with nothing server-side to gate. Links are deep-linkable, so point at the exact route rather than relying on the redirect. The UI hides what a member cannot use, but the API stays the actual enforcement boundary. `settings/admin` is an eleventh entry on the same rail, visually separated by a divider: it belongs to the operator of the deployment rather than to an organization, gates in `settings/admin/+layout.server.ts` (one `requireInstanceAdmin` call covering the whole area rather than per-page, since a sibling page is expected to land under it) instead of per-route `requireRole`, and shows regardless of org role (see [`docs/permissions.md`](docs/permissions.md) "Instance admin area").

- **`daemon/`** - long-lived Node process running a set of independent loops. `scheduler.ts` parses `cron_expression` on active campaigns via `cron-parser` and POSTs to the web `/api/run` endpoint (the daemon never touches agent runners directly). `cron.ts` exports that same parsing as `describeCron` + `nextCronRuns` (reachable as `@pitchbox/daemon/cron`), so the campaign form's schedule preview cannot disagree with the scheduler that will actually fire it. `reply-poller.ts` drives the `ReplyReader` but only polls platforms with a real (non-Null) reader registered: it polls Mastodon (mentions via its API) and skips Null-reader platforms (Reddit, whose reply detection runs through the Chrome extension `inbox-sync`/`chat-sync` below instead). `heartbeat.ts` writes to `daemon_heartbeats` so Settings can show liveness. `retention.ts` prunes ageing run/draft events, `keyword-watcher.ts` polls saved keyword watches, and `webhook-sender.ts` drains the outbound notification-webhook queue. The same loops can run embedded inside the web process (`PITCHBOX_EMBED_DAEMON=1`) instead of as a separate process. SIGINT/SIGTERM trigger graceful shutdown.

- **`playbooks/`** - agent-agnostic markdown consumed by an `AgentRunner`: `reddit-scout`, `reddit-commenter`, `reddit-poster`, `hn-commenter`, `hn-poster`, `mastodon-scout`, `mastodon-commenter`, `mastodon-poster`, `project-extractor`, `project-insighter`, `campaign-skill-generator`, `reply-drafter`, `draft-regenerator`. They read and write state through the `mcp__pitchbox__*` MCP tools (run/campaign/project ids are bound via the session env, not chosen by the agent); they do **not** shell out to the CLI. The Mastodon three are conservative by design (see [`docs/mastodon-integration-design.md`](docs/mastodon-integration-design.md)): genuine contextual replies over volume, cold DMs discouraged, `#nobot` and opt-outs respected.
  - **Every playbook carries the same verbatim `## House style: write like a human` section**, right before its `## Steps`: the bans (em dashes and the other typographic tells, filler openers, puffery, wrap-up closers) and what to write instead, so drafts do not read as machine-written. It is duplicated on purpose, since a playbook body ships standalone (seeded into `playbooks.body`, handed to the agent as the whole prompt) and there is no include mechanism. `shared/tests/playbook-house-style.test.ts` is what keeps the copies from drifting: edit the section in one playbook and you must edit it in all of them.

- **`extension/`** - Chrome MV3 companion built with Vite + `@crxjs/vite-plugin`. Reads the `pitchbox_draft=<id>` query param the dashboard appends to compose URLs; calls bearer-token-authenticated `/api/extension/*` endpoints on the local web server to flip drafts to `sent` when the user submits on Reddit. Build with `pnpm run build:extension` then load `extension/dist/` unpacked in `chrome://extensions`. Auth is per-device: each install holds its own token, minted either by auto-pairing against the dashboard origin while logged in (`GET /api/extension/auto-pair`, session-authenticated, binds the token to the caller's active org) or by redeeming a short-lived pairing code an admin issues (`POST /api/settings/extension-pairing`, admin-only, 10 min TTL) via `POST /api/extension/pair` (public, the code itself is the one-time secret). Each token is a row in `extension_devices` (`token_hash`, `label`, `last_seen_at`), independently revocable (`DELETE /api/settings/extension-devices/:id`, admin-only).
  - Background service worker runs two pollers every 10 min via `chrome.alarms`, both posting to `POST /api/extension/dm-sync`: (1) `src/background/inbox-sync.ts` polls `reddit.com/message/inbox.json` for legacy PMs **and** comment-replies (`t1` items), splitting them into the `items[]` and `comments[]` arrays of the request body; (2) `src/background/chat-sync.ts` calls `matrix.redditspace.com/_matrix/client/v3/sync` for Reddit Chat. The server matches DMs on `(account_handle, target_user)` and comment-replies on `parent_id == drafts.platform_comment_id`, recording everything in the `messages` table and flipping draft state to `replied`. The matchers (`shared/src/dm-sync.ts` and `shared/src/comment-sync.ts`) are pure and reused across both pollers.

## Cloud runner & repo layout

The cloud runner (`shared/src/agents/sdk/runner.ts`) drives the model loop in the same process as the rest of the app, reaching every model through the Vercel AI Gateway (`AI_GATEWAY_API_KEY`) - there is no separate compute service and nothing to relay: the Pitchbox MCP server runs in-process too, over an in-memory transport. Full design + end-to-end validation: [`docs/cloud-runner.md`](docs/cloud-runner.md).

**Repo layout (umbrella).** This public repo is the umbrella. `cloud/runner` and `cloud/adapter` are tracked as **git submodules** of this umbrella (see `.gitmodules`; their content lives in the private `pitchbox-runner-service` / `pitchbox-cloud-adapter` repos, and `.gitignore` keeps any other `cloud/*` path and `private/` untracked), retired alongside the ACP runner service (#420) - nothing in this repo builds, deploys, or imports from either submodule anymore. To land a change: commit inside the submodule and push its own remote, then bump the umbrella's submodule pointer with `git add cloud/<x>` and commit that here (never `git add` submodule content from the umbrella). Always launch agents from this repo directory: chat history is keyed by the launch path (Claude Code + Emdash), so launching from a parent/other folder loses it. The submodules use pnpm standalone and import the OSS protocol contract by relative path.

**A submodule often sits in detached HEAD at the recorded gitlink.** Before
branching inside `cloud/runner` or `cloud/adapter`, `git -C cloud/<x> checkout
main` and verify it matches `origin/main` and the umbrella's gitlink first -
if it looks stale, `git -C cloud/<x> reset --hard origin/main`. Rest of the
submodule workflow: `.claude/skills/pitchbox-cloud-submodules/SKILL.md`.

## Docker (cloud-edition deployment)

The client stack (web + daemon + Postgres) ships as Docker via `Dockerfile.app`
plus the `docker-compose.app.*` overlays, parameterised by `.env` (copy
`.env.docker.example`). The web is a SvelteKit **adapter-node** build run under
`node --import tsx`: the app is bundled, but `@pitchbox/*` stay **external** and
load from TS source at runtime (see `web/vite.config.ts`), which keeps their CJS
deps - ajv via the MCP SDK, the reddit stealth stack - out of the ESM bundle where
`require()` would be undefined. Both `web` and `daemon` declare `@pitchbox/cli` as a
dependency for exactly this reason: the SDK runner's tool set reaches it through a bare
package-specifier import (`shared/src/agents/sdk/tools.ts`), which nothing else in either
workspace's `package.json` pulls into `node_modules` for a bundled build to resolve - the
deployed cloud edition could not complete a single run without it (#491/#492). The daemon
runs from TS source via tsx. The web
image bundles Google Chrome (the Reddit MCP tool scrapes with Playwright
`channel: 'chrome'`, client-side). `pnpm -F web dev` (Vite) is the dev overlay.

```bash
# The main dev command runs everything on the HOST + postgres in Docker (see the
# Dev section above): `pnpm run dev`. The Docker variant below runs the whole stack
# IN Docker instead (postgres + migrations + web + daemon); it does NOT include
# the extension/docs.
pnpm run docker:dev

# prod: restart, resource limits, optional cloudflared tunnel (--profile tunnel)
docker compose -f docker-compose.yml -f docker-compose.app.yml -f docker-compose.app.prod.yml up -d
```

The Docker stack is **cloud edition only**: it sets `PITCHBOX_EDITION=cloud` and
dispatches every run to the in-process SDK runner, which needs `AI_GATEWAY_API_KEY`
in `.env` to reach any model - there is no separate runner image.

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
- **A switch is enforced where the effect happens, not where it is read.** The
  org-level LinkedIn assist switch, the collector switch and the kill switch
  (`shared/src/linkedin-assist.ts`, settings at `/settings/linkedin-assist`) are
  checked inside `POST /api/extension/suggest` and `POST /api/extension/observations`,
  not only served to the extension by `GET /api/extension/linkedin-assist`. They
  shipped enforced only client-side, and both routes happily streamed
  suggestions and wrote observations for an org whose assistant was off (#358).
  Any new route on that plane loads `loadLinkedInAssistDeviceState` and refuses:
  a stolen device token, an extension build that never polls, and a tab left
  open across the flip all arrive as an ordinary authenticated request. The
  refusal shapes differ on purpose: `suggest` answers a renderable `200
{refused}` like its quota refusal, the collector gets a `403`, and
  `kill_switch` is named distinctly from `assist_disabled` so the panel can say
  who stopped it. A test for one of these routes that passes with the assistant
  switched off is not testing the gate.
- **The assist plane and the campaign plane want different models.** A campaign
  run is unattended; a suggestion has a human watching an empty panel, and the
  wait is the model deliberating before its first text token, not the spawn
  (measured: 2.2s spawn plus session, 10 to 14s of thinking, #360). So
  `resolveAssistRunnerConfig` in `web/src/lib/server/suggest.ts` asks for a fast
  model unless an operator pinned one in `runner_configs`, which still wins.
  Before optimising this path again, measure it on an idle box: a six-agent
  wave running here inflated the same measurement by nearly 4x.
- **`PITCHBOX_ROOT`** in `.env` must be an absolute path; the daemon and CLI use it to locate the repo when spawned by an agent from a different cwd.
- **Secrets.** Account credentials are encrypted with `ENCRYPTION_KEY` via `shared/src/crypto.ts`. Never log decrypted secrets or commit `.env`.
- **Do not run tests against the dev DB.** Vitest pins `DATABASE_URL` to `pitchbox_test` in `vitest.config.ts`; if you override it, match that pattern.
- **Migrations.** Edit `shared/src/db/schema.ts`, run `pnpm run migrate:generate`, then `pnpm run migrate`. Never hand-edit generated SQL unless you also regenerate. The baseline (`migrations/0000_baseline.sql`) preserves the live DB's historical constraint names (`_fkey`/`_key`), not drizzle-canonical ones - a generated migration that drops or renames an existing constraint may emit a name that doesn't exist in the DB; use the real historical name instead.
- **A generated migration can be silently skipped by drizzle's `when`-ordering rule, but `migrate` no longer trusts its own "migrations applied" message for it.** `0013_assist_run_kind.sql`'s hand-authored future `when` (`1788960000000`) still makes anything generated after it with a real timestamp skip in silence - `0016_operator_voice_profile` did exactly that on preview and the first read of its table 500'd hours later (#493, `shared/src/db/migration-audit.ts`). `migrate` now re-derives the applied set from the database itself afterward and exits 1, naming every missing migration, instead of trusting drizzle's own success message. A skip already applied on some real database gets repaired forward, not edited in place: re-issue it as a new migration with a higher `when`, written idempotently (`IF NOT EXISTS`), and record the tag mapping in `shared/src/db/migrations/meta/_superseded.json`.
- **Security disclosure.** This repo is public with a live prod deploy (`app.pitchbox.app`). Never put unpatched-vulnerability repro detail (steps, `file:line`) in a public issue, PR, or committed doc - file a private GitHub security advisory instead and leave a neutral `[security]` stub issue pointing to it.
- **English everywhere.** All in-code comments and user-facing UI strings are in English (even when the conversation is in another language). No em dashes in any text - use regular hyphens or colons.

## Design and UI

- **Dev target for `uishot`.** `pnpm run dev:web` puts the SvelteKit app on `127.0.0.1:5180` (or run the full `pnpm run dev`, which brings it up alongside everything else). Either way it needs Postgres up and migrated first (`pnpm run db:up && pnpm run migrate`) plus an `ENCRYPTION_KEY` in `.env` - screenshotting before that just hits a connection error. Shoot `/` first: `PITCHBOX_AUTH` is off by default, so the dashboard renders with no login.
- **Token layer.** `web/src/app.css`: OKLCH `:root`/`.dark` custom properties (color, `--radius`) fed into an `@theme inline` block for Tailwind. It's the enforced rule in practice, not just declared: grepping the whole repo finds zero arbitrary-color Tailwind classes, and the only two raw hex literals outside the token layer are both non-CSS (a `<meta name="theme-color">` and a Chrome extension badge-color call) - see `docs/design/DECISIONS.md` D1.
- **No `/design` gallery route.** The shadcn-svelte primitives under `web/src/lib/components/ui/` have no single page that renders every one in every state; adding one is how that set gets reviewed in one `uishot` pass instead of hunting across real pages.
- **Dark mode is real.** `.dark` class + `mode-watcher` (`ThemeToggle.svelte`, system/light/dark), so a light/dark `uishot` pair should genuinely differ, not come back identical.
- **Design system project.** `Pitchbox Design System` - <https://claude.ai/design/p/e8a9f196-d422-4bb5-93c3-d020f5276a10>. Built from this repo, so it read `web/src/app.css`, the shadcn-svelte primitives under `web/src/lib/components/ui/`, and the extension's own `extension/src/sidepanel/app.css`; it carries all three UI kits (web dashboard, extension side panel, docs site).
- **The design system had no font to copy, and that is about this repo.** Inter arrives from npm (`@fontsource-variable/inter`, imported at the top of `web/src/app.css`), so the `woff2` files live in `node_modules` and not in the tree. Claude Design copies a repo's real font files when they are committed, and here it found none, so the project first came back flagging "Missing brand font" and rendering every specimen in a substitute face, which makes any typography judgement on it worthless. I uploaded `inter-latin-wght-normal.woff2` and its italic to the project by hand on 2026-08-24 and the flag cleared. If the project is ever regenerated, upload them again, or commit the two faces under `web/static/` and stop paying for this.
- **Decisions file.** `docs/design/DECISIONS.md` - one row per UI/design question that reached an answer, `Rule it creates` filled only where a component can violate it.

See the `ui-brief-first` / `ui-design-tokens` / `ui-visual-review` skills for the pipeline itself, and `uishot`/`uislop` for the tools. Short version, repo-specific: a new surface or a redesign gets drawn on the design system project above; the answer lives in `docs/design/DECISIONS.md`, never on the canvas. Implement from the exported project archive's `github.md` screen map plus the decision row, never from the export's CSS - exports carry real repo colors but also raw hex with zero `var(--token)`, so the values transfer and the token layer doesn't. A small edit that leaves a surface's structure alone, or a rule rather than a picture (a token, a naming convention, a guardrail), skips the canvas entirely and goes straight into `docs/design/DECISIONS.md`. The canvas itself is never the source of truth - it's Beta, has no version history (its menu is Rename/Duplicate/Delete, nothing more), and sits behind one personal claude.ai account this repo's agents can't read; regenerate it from the repo with "Start from code" when it goes stale instead of hand-maintaining it.

Two things worth stating here so nobody re-derives them mid-task. First, the extension side panel is a second surface with its own stylesheet, `extension/src/sidepanel/app.css`, kept a verbatim copy of `web/src/app.css`'s `:root`/`.dark` blocks by convention (`docs/design/DECISIONS.md` D2) - a token decision has two homes, and changing one without the other is the actual, recorded failure mode. Second, **the side panel can be rendered and screenshotted, and the tool for it is not `uishot`.** `uishot` genuinely cannot reach it: it only takes a URL/file/stdin target with no extension-loading flag, and the panel's boot (`extension/src/lib/settings.ts`'s `getSettings()`) calls `chrome.storage.local.get` unconditionally before mounting anything, so pointing it at the built `extension/dist/src/sidepanel/index.html` gives a blank page and `TypeError: Cannot read properties of undefined (reading 'local')`. What works is a real Chrome profile over raw CDP: `omp-chrome up personal`, `Extensions.loadUnpacked` with the absolute path of `extension/dist` (plain `--load-extension` command-line flags are silently ignored on this box's Chrome and the extension never appears under `chrome://extensions`), then navigate a tab to `chrome-extension://<id>/src/sidepanel/index.html`. Measured 2026-09-04: it loads, `chrome.runtime` is live in that page (so `chrome.runtime.sendMessage({ type: 'pitchbox:dm-sync:run' })` drives the background worker from there), and `Page.captureScreenshot` returns the real panel. This paragraph used to say the opposite, on the strength of the omp `browser` device answering `ERR_BLOCKED_BY_CLIENT` for that origin - that is a property of that device's own browser, not of Chrome, and it does not apply to an `omp-chrome` profile. Shoot it at a side-panel width (~400px) rather than a desktop viewport, since a full-width render tells you nothing about the layout it actually ships in.

**The panel can also be driven, not just screenshotted, and that is the only way the packaged build gets exercised at all.** In that same CDP-loaded profile, `Input.dispatchMouseEvent` against the panel page counts as a real user gesture, so pairing, `Test connection`, `Disconnect` and the LinkedIn permission grant all run end to end. `chrome.permissions.request` opens a **native** Chrome bubble that CDP cannot reach: find it in an `ffmpeg -f x11grab` frame of the profile's display and click it with `DISPLAY=:9<slot> xdotool mousemove <x> <y> click 1`. Two traps cost real time on 2026-09-07. A coordinate below the viewport makes `document.elementFromPoint` return null and the CDP click silently lands on nothing, so measure and click in one call, or call `.click()` on the element inside the shadow root. And a heavy LinkedIn tab can hang its renderer until every `Runtime.evaluate` times out; close that target from the browser-level session and open a fresh tab instead of waiting it out.

**This is not optional polish. Six defects shipped because nothing had ever loaded the built extension** (#379, fixed by #380 and #381): a `.ts` script path that only resolves while Vite serves the source, an inline `<script>` the MV3 CSP refuses outright, LinkedIn missing from the server's extension CORS allowlist, the in-page assistant not registered for `/posts/<slug>-<id>/`, Svelte's runtime dying on LinkedIn's Trusted Types allowlist, and a post reader that returned a screen-reader-only line instead of the post. `tests/extension-packaged-build.test.ts` now builds the extension and asserts on the artifact, which covers the first two classes; the rest only show up on a real page. So drive the built extension in a real profile against preview before calling an extension change done.

**Three traps in the side panel's own code, all paid for on 2026-09-08 while building home (#457).** A Svelte file must never declare a variable called `state`: `let state = $derived(...)` turns every `$state` rune in that file into a store subscription (`$` + `state`), and the file stops compiling with errors that name the rune rather than your variable. Second, a component that reads `chrome.storage` for itself is a second reader of the same key and will drift from the first: home said "Not paired" while `PairingList` still rendered the old rows with their Test connection and Disconnect buttons, because that copy refreshed only on mount. One owner reads, the children take props, and a child that mutates calls back up. Third, the panel applies the theme at mount only, so a `extensionSettings.theme` write from another context (a worker, a test, another tab) does not repaint an open panel: reload the page to see dark mode, and do not read that as a bug in what you just changed.

**Mounting a side-panel component in a test needs the root `vitest.config.ts`, not the extension's.** CI runs the root config, and until #457 it had no `$ext`/`$ui` aliases, so a component test that passes under `pnpm -F @pitchbox/extension exec vitest run` fails in CI on an unresolved import - the same split that cost a bisect in #339. Both configs resolve them now. `$lib` is deliberately NOT remapped in the root config: the extension's `ui` primitives resolve `$lib/utils.js` to the web app's own `cn`, which is the same helper, and remapping it would break every web route test.

**An in-page LinkedIn panel cannot be verified against a local backend, and the reason is Chrome, not the code.** Point the built extension at `http://127.0.0.1:<port>` and the panel mounts, reads the post and then sits in "Reading the post..." forever, with no error anywhere: the content script's own `fetch` to the loopback backend fails with a bare `Failed to fetch`, while the same call from the background worker returns 200. That asymmetry is Chrome's Private Network Access rule. A public HTTPS document (`https://www.linkedin.com`) reaching a loopback address needs a preflight carrying `Access-Control-Request-Private-Network: true`, answered with `Access-Control-Allow-Private-Network: true`; `web/src/lib/server/extension-cors.ts` answers the ordinary CORS preflight and not that header, so the request never leaves the page. Measured 2026-09-08 on Chrome 149 while verifying #409. Do not add the header to make a test pass: it would tell every public site on the internet that this deployment's loopback API exists. Verify the panel against `preview.pitchbox.app` after the change deploys, and use a local backend only for the pieces that run in the worker or in a test.

## Linear is the source of truth

Current state and future roadmap live in Linear (`linear.app/fiorelorenzo`), not in this file and not in a chat transcript. Keeping it current is part of doing the work, not paperwork at the end: it is how Lorenzo sees where the project stands without reading session logs.

**Structure.** The `pitchbox` initiative is the standing view of this repo; it does not close. Work ships through one of four projects, each a release or a body of work with an end: `pitchbox v1.4 - Maintenance and dependency hygiene`, `pitchbox v1.8 - Landing and project knowledge sources`, `pitchbox v2.0 - Monetization: plans, billing and limits`, `pitchbox v2.1 - The assistant as an agent`. A project closes when it ships, which is what lets its issues archive.

**A project milestone is what used to be an epic issue.** Epics are not issues in Linear: a milestone costs no issue slot and shows progress natively. Keep a parent issue only for a deliverable that genuinely splits into sub-deliverables within a single agent run's reach. Every issue belongs to a project milestone unless it genuinely belongs to no body of work, in which case it carries no project at all.

**One issue is one agent run is one PR is one worktree.** That equivalence is load-bearing: it is what makes the worktree removable at the end of a run and the PR reviewable.

**Status is a claim about reality, keep it true.**

- Before you write code for an issue, move it to `In Progress`. If what you are about to do has no issue, create one first, then start.
- Move it to `Done` only when the change is merged and verified, not when the code is written. Merged but something is still open? Say so in a comment and leave it `In Progress`.
- The team's statuses are `Backlog`, `Todo`, `In Progress`, `In Review`, `Done`, `Canceled`. `In Review` is where an issue sits while its PR is open.

**Comment when a reader would want to know.** A decision taken, an approach tried and abandoned, a blocker hit, a surprise in the code, a scope change, a finding that invalidates the issue as written. One comment per meaningful turn in the work, not one per commit, and no routine progress narration.

**File the work you discover.** When something real surfaces mid-task or in a conversation with Lorenzo (a bug you noticed on the way, a follow-up the fix implies, an idea worth doing later), open an issue for it instead of silently widening the current change or letting it evaporate. Then say in the current issue that you split it out, with a link.

**Conventions for a new issue.** Match what the workspace already shows, do not invent a parallel style:

- Title in conventional-commit form with the affected workspaces as scope, lowercase after the colon: `fix(web,shared): new projects snapshot a runner the deployment cannot launch`. A plain descriptive sentence is acceptable when no single scope fits. This convention still applies to the Linear issue title as well as the eventual PR title.
- Labels come from two mutually exclusive groups plus flat labels, set on every issue you file. Group `repo` (`pitchbox`, `sazio`, `canonry`) - use `pitchbox` here, exactly one. Group `type` (`feature`, `fix`, `refactor`, `test`, `chore`, `ci`, `docs`, `design`, `security`, `spike`) - exactly one, since Linear allows only one label per group on an issue. Flat `area:*` labels, one or more, naming the surfaces the change touches: `cli-mcp`, `cloud`, `daemon`, `deploy`, `docs`, `extension`, `playbooks`, `shared`, `tests`, `web`. Add a new `area:*` value only when the surface really is new. Flat `flagship` marks headline work; flat `parallel` marks an issue a parallel agent can take without colliding with other work.
- Priority is Linear's native field, not a label: 1 Urgent, 2 High, 3 Medium, 4 Low. Effort is Linear's native estimate field. Set both alongside the project, the milestone and the labels in the same `save_issue` call - an issue missing one of these is a mistake, not an accident of a second call being skipped.
- Project and milestone: assign the project this work belongs to and, inside it, the milestone (the former epic) it serves. An issue with neither is only correct when it genuinely belongs to no body of work.

**PRs stay on GitHub.** Linear's in-app PR review is a Business-plan feature this workspace is not on, so review happens on GitHub as before, and Linear links the PR through the branch name.

**The old GitHub Project board and every closed GitHub issue are a read-only archive.** Only the open non-epic issues were migrated to Linear; nothing syncs between the two systems in either direction, and a two-way sync must never be added.
