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

Set the webhook URL on `/notifications`. Every emitted notification fires a `POST` of the row's JSON to that URL (fire-and-forget — webhook failures are logged but don't block the producer). Wire it to Slack, Discord, Telegram, n8n, whatever.

```http
PUT /api/settings/webhooks   # { "url": "https://hooks.example.com/..." }
```

Pass `null` (or empty string) to disable.

## API

```http
GET  /api/notifications      # { notifications: [...], unread: <int> }
POST /api/notifications      # marks all as read, returns { unread: 0 }
```
