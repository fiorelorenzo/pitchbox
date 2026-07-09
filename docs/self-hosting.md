# Self-hosting

Pitchbox is designed to run on a single VPS or a beefy laptop. The architecture is just three processes (web, daemon, Postgres) plus a Chrome extension on your workstation.

## Topology

```
┌────────────┐     ┌─────────────────────────┐     ┌─────────────┐
│ Chrome     │ ──> │ web (SvelteKit, :5180)  │ ──> │ Postgres    │
│ extension  │     │   ├ /api/run (campaigns)│     │ (port 5434) │
└────────────┘     │   ├ /api/extension/*    │     └─────────────┘
                   │   └ AgentRunner (claude)│
                   └────────┬────────────────┘
                            │ POST /api/run
                   ┌────────┴────────┐
                   │ daemon (Node)   │
                   │  scheduler tick │
                   │  reply poller   │
                   └─────────────────┘
```

The **`AgentRunner`** box is pluggable. With a local runner (Claude Code, Codex, …) the web spawns an ACP agent CLI in-process, as drawn. With the default `cloud` runner it instead dispatches the run to a managed runner service and only relays MCP frames, so no agent CLI runs on this host and your data stays local. See [Agent runners](./runners.md) and [Cloud runner](./cloud-runner.md). The daemon loops (scheduler, reply poller, retention, keyword-watcher, webhook-sender, insights) can also run embedded in the web process via `PITCHBOX_EMBED_DAEMON=1` instead of as a separate process.

## Backups

`pg_dump pitchbox` is enough. Everything that matters lives in Postgres:

- Campaigns, runs, drafts, contact history, blocklist, messages.
- Encrypted account credentials (`accounts.cookie_session`).
- App config (`app_config`) - quota defaults, runner configs, default runner, retention policy, notification webhooks. Extension auth uses per-device tokens in `extension_devices`, not a singleton here.
- Built-in and user playbooks.

`ENCRYPTION_KEY` is **not** in Postgres - keep it in `.env` or a secret store, and snapshot it alongside backups or you'll lose access to encrypted columns.

The daemon prunes ageing event logs and terminal drafts on a configurable schedule - see [retention](./retention.md). Contact history is never pruned automatically.

## Upgrades

`git pull && pnpm install && pnpm run migrate && pnpm -F @pitchbox/shared seed:core`. The seed step refreshes built-in playbooks but leaves user-created rows alone.

## Dependency pinning policy

A few dependencies are pinned to **exact** versions (no caret) in `package.json` because semver-range upgrades have historically broken self-hosted installs:

- Any `*-beta*` release (e.g. `@crxjs/vite-plugin` betas) - beta tags do not follow semver guarantees.
- Packages that ship native bindings (e.g. `sharp`) - minor bumps frequently change the prebuilt-binary matrix and break Docker images on uncommon architectures.
- Build tooling whose output is shipped to users (`vite`, `vitest`, `@crxjs/vite-plugin`) - patch releases here can change the bundle layout or extension manifest in subtle ways.

When adding or upgrading any of the above, write the exact version (no `^`, no `~`) and regenerate the lockfile with `pnpm install --lockfile-only`. Other dependencies may continue to use `^` ranges.

## Logs

Stream logs land in `daemon/logs/run-*.log` (one per run). The `runs.stdout_log_path` column points at the matching file.

## Performance: index audit

Migration `0030_index_audit` adds composite indexes covering the hottest read paths: dm-sync `(account_handle, target_user)` lookups on `contact_history`, Inbox filters on `drafts(state, run_id, created_at DESC)`, and audit-feed scans on `draft_events(event, created_at)` / `run_events(kind, created_at)`. To benchmark against a realistic volume, run `tsx scripts/perf-seed.ts` against a throwaway DB - it inserts 100k rows into both `draft_events` and `run_events` and `ANALYZE`s the tables.
