@AGENTS.md

## Claude Code specific

Everything about _this repo_ (stack, commands, architecture, conventions, gotchas)
lives in `AGENTS.md`, imported above. This section is only for how **Claude Code**
should operate here.

### Skills

Process skills decide _how_ to approach a task - reach for them before writing code:

- **brainstorming** - before any new feature surface (a new route, CLI command,
  table, playbook, or a behaviour change). Don't unilaterally design.
- **test-driven-development** - this codebase is test-first and the suite hits a
  real Postgres (`pitchbox_test`). Write/extend the test before the implementation.
- **systematic-debugging** - for any failing test or unexpected behaviour (a flaky
  run-event parse, a DM-sync mismatch, a quota edge case) before proposing a fix.
- **verification-before-completion** - before claiming done, actually run the
  relevant `pnpm run lint` / `typecheck` / `test` (and `pnpm -F web check` for
  Svelte) and read the output. Never assert "tests pass" from inference.

### Context discipline

Some files swamp the context window for nothing - never `Read` them whole:

- `pnpm-lock.yaml` and the generated SQL under `shared/src/db/migrations/`.
- For lookups, use `grep` / `find` via Bash or dispatch the **Explore** agent;
  only `Read` a source file in full when you're about to edit it.

### Parallel subagents

For anything that spans the monorepo (tracing a type through
shared → cli → web → daemon, finding every call site, auditing how DB access is
wired across workspaces), dispatch parallel **Explore** agents rather than serially
reading. See the `superpowers:dispatching-parallel-agents` skill.

### Memory vs. AGENTS.md

Auto-memory **is** active for this project - keep using it. The split:

- **Durable, cross-conversation facts** (user preferences, recurring workflow
  lessons) → auto-memory.
- **Repo orientation** (structure, commands, conventions) → `AGENTS.md`.
- If a memory and `AGENTS.md` disagree, trust the repo and update the stale one.
  Don't duplicate `AGENTS.md` content into memory or vice-versa.

### PRs

Work on short-lived feature branches and open a PR into `main` (the default base
for `gh pr create`). The nested private repos (below) are separate git repos with
their own branching.

### Nested private repos (cloud/)

`cloud/runner` (`@pitchbox/runner-service`) and `cloud/adapter`
(`@pitchbox/cloud-adapter`) are **git submodules** of this umbrella (`.gitmodules`
points at their private remotes); any other `cloud/*` path and `private/` stay
gitignored. Each submodule is its own repo: its own `git`, its own
`main`/`development`, its own `pnpm`. Commit and push in the submodule, then bump
the umbrella pointer here with `git add cloud/<x>`; never `git add` submodule
content from the umbrella. Always launch Claude from this `pitchbox` directory - chat history is keyed
by the launch path (Claude Code + Emdash), so do not relocate the launch dir to a
parent umbrella. See AGENTS.md "Cloud runner & repo layout".
