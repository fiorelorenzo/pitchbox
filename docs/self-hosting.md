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

## Backups

`pg_dump pitchbox` is enough. Everything that matters lives in Postgres:

- Campaigns, runs, drafts, contact history, blocklist, messages.
- Encrypted account credentials (`accounts.cookie_session`).
- App config (`app_config`) — extension token, quota defaults, runner configs, notification webhooks.
- Built-in and user playbooks.

`ENCRYPTION_KEY` is **not** in Postgres — keep it in `.env` or a secret store, and snapshot it alongside backups or you'll lose access to encrypted columns.

## Upgrades

`git pull && npm install && npm run migrate && npm run -w @pitchbox/shared seed:core`. The seed step refreshes built-in playbooks but leaves user-created rows alone.

## Dependency pinning policy

A few dependencies are pinned to **exact** versions (no caret) in `package.json` because semver-range upgrades have historically broken self-hosted installs:

- Any `*-beta*` release (e.g. `@crxjs/vite-plugin` betas) — beta tags do not follow semver guarantees.
- Packages that ship native bindings (e.g. `sharp`) — minor bumps frequently change the prebuilt-binary matrix and break Docker images on uncommon architectures.
- Build tooling whose output is shipped to users (`vite`, `vitest`, `@crxjs/vite-plugin`) — patch releases here can change the bundle layout or extension manifest in subtle ways.

When adding or upgrading any of the above, write the exact version (no `^`, no `~`) and regenerate the lockfile with `npm install --package-lock-only`. Other dependencies may continue to use `^` ranges.

## Logs

Stream logs land in `daemon/logs/run-*.log` (one per run). The `runs.stdout_log_path` column points at the matching file.
