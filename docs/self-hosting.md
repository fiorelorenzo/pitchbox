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

## Logs

Stream logs land in `daemon/logs/run-*.log` (one per run). The `runs.stdout_log_path` column points at the matching file.
