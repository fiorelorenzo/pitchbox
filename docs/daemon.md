# Daemon

A long-running Node process under `daemon/`. Start with `npm run -w daemon dev` (or wrap with systemd / PM2 for production).

## Modules

- `scheduler.ts` — parses `cron_expression` on active campaigns via `cron-parser`. Due campaigns are dispatched by POSTing to the web `/api/run` endpoint, so the daemon never touches agent runners directly.
- `reply-poller.ts` — drives the `ReplyReader` interface (`shared/src/platforms/base-reply-reader.ts`). Today the null reader is wired (the Chrome extension covers ingestion in practice).
- `heartbeat.ts` — writes a tick per module to `daemon_heartbeats` every few seconds. Settings shows liveness based on the most recent tick.

## Shutdown

`SIGINT` / `SIGTERM` triggers graceful shutdown: stop the schedule loop, finalise the current poll, exit cleanly.

## Operating notes

- The daemon doesn't need access to the agent runner CLI — it's just a scheduler that POSTs to the dashboard.
- Setting `PITCHBOX_AUTH=on` does **not** affect daemon → web calls today (the daemon hits the local backend without auth). The roadmap for cloud-edition multi-tenancy will introduce service tokens; until then, run both processes on the same host.
