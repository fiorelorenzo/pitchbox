# Notifications

Pitchbox emits structured notifications for the events you actually care about — run terminal states, draft batches, and incoming replies. Every event is persisted in the `notifications` table and surfaced through the sidebar bell + `/notifications` page.

## Emitted events

| Kind             | When                                                                     |
| ---------------- | ------------------------------------------------------------------------ |
| `run.success`    | Dispatcher commits a successful terminal state.                          |
| `run.failed`     | Dispatcher commits a failed terminal state (or catches a runtime error). |
| `drafts.created` | `pitchbox drafts:create` finishes a batch — coalesced as "N drafts".     |
| `reply.received` | The extension's dm-sync route matches one or more incoming replies.      |

## Outgoing webhook

Set the webhook URL on `/notifications`. Every emitted notification enqueues a row in `webhook_deliveries` (status `pending`); the daemon's `webhook-sender` worker drains the queue every 30 s, posting the JSON payload to your URL with a 10 s HTTP timeout. Wire it to Slack, Discord, Telegram, n8n, whatever.

```http
PUT /api/settings/webhooks   # { "url": "https://hooks.example.com/..." }
```

Pass `null` (or empty string) to disable.

### Retry, backoff, and the dead-letter queue

The daemon worker is at-least-once and resilient:

- **On `2xx`** the row flips to `delivered` (terminal).
- **On any non-2xx, timeout, or network error** the row's `attempts` counter increments, the error message lands in `last_error`, and `next_attempt_at` is pushed out by `computeBackoff(attempts)` — the same exponential helper used by the campaign dispatcher (60 s, 2 m, 4 m, …, capped at 1 h).
- **When `attempts >= max_attempts`** (default `8`) the row flips to `dead`. It stops being picked up and surfaces in the "Recent deliveries" panel on `/notifications` with a **Retry** button that re-enqueues it (`attempts = 0`, `status = 'pending'`).

The worker uses `SELECT … FOR UPDATE SKIP LOCKED LIMIT 10`, so running multiple daemon instances is safe — each tick claims its own batch.

```http
POST /api/webhooks/deliveries/:id/retry   # manual DLQ retry; resets attempts
```

The `webhook_id` column on each delivery is a short sha256 of the destination URL — useful if you ever wire up multiple destinations without leaking the URL itself into logs or UI.

## API

```http
GET  /api/notifications      # { notifications: [...], unread: <int> }
POST /api/notifications      # marks all as read, returns { unread: 0 }
```
