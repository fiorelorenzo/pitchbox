# Daemon

A long-running Node process under `daemon/`. Start with `npm run -w daemon dev` (or wrap with systemd / PM2 for production).

## Modules

- `scheduler.ts` — parses `cron_expression` on active campaigns via `cron-parser`. Due campaigns are dispatched by POSTing to the web `/api/run` endpoint, so the daemon never touches agent runners directly.
- `reply-poller.ts` — drives the `ReplyReader` interface (`shared/src/platforms/base-reply-reader.ts`). Today the null reader is wired (the Chrome extension covers ingestion in practice).
- `heartbeat.ts` — writes a tick per module to `daemon_heartbeats` every few seconds. Settings shows liveness based on the most recent tick.

## Shutdown

`SIGINT` / `SIGTERM` triggers graceful shutdown: stop the schedule loop, finalise the current poll, exit cleanly.

## Testing

Daemon tests live under `daemon/tests/` and hit the shared Postgres test DB (`pitchbox_test`, port 5434), same setup as the rest of the suite. Run only the daemon tests with:

```bash
npx vitest run daemon/
```

The full `npm test` picks them up automatically — no extra wiring needed.

## Backoff and circuit breaker

When a scheduled dispatch fails (the web `/api/run` call returns non-2xx or throws), the scheduler increments `campaigns.failure_attempts` and stamps `campaigns.next_attempt_after` with `now + computeBackoff(failure_attempts)`. The backoff helper lives in [`shared/src/scheduler/backoff.ts`](https://github.com/fiorelorenzo/pitchbox/tree/development/shared/src/scheduler/backoff.ts) and follows the schedule `60s → 2m → 4m → 8m → … → 1h cap` (factor 2, max 1 hour).

While `next_attempt_after` is in the future the campaign is skipped on every tick — `next_attempt_after` takes precedence over the cron tick. On the first successful dispatch after a failure streak, `failure_attempts` resets to 0 and `next_attempt_after` is cleared, so the campaign returns to its normal cron cadence immediately.

After **10 consecutive failures** the circuit breaker trips: `paused_due_to_failures` is set to `true`, the scheduler stops considering the campaign on subsequent ticks, and a `campaign.paused` notification is emitted (visible in the dashboard's notification panel and forwarded to any configured webhook). Resuming requires an operator to clear `paused_due_to_failures` once the underlying issue is fixed.

## Operating notes

- The daemon doesn't need access to the agent runner CLI — it's just a scheduler that POSTs to the dashboard.
- Setting `PITCHBOX_AUTH=on` does **not** affect daemon → web calls today (the daemon hits the local backend without auth). The roadmap for cloud-edition multi-tenancy will introduce service tokens; until then, run both processes on the same host.
- Every loop's cadence is sprinkled with symmetric multiplicative jitter so concurrent loops (and multi-instance deployments) don't lock-step on the same tick. The jitter fraction is configurable via `DAEMON_JITTER_PCT` (default `0.1`, i.e. ±10%; clamped to `[0, 1]`, set to `0` to disable).
