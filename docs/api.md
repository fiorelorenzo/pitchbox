# HTTP API

The dashboard's `/api/*` routes power the UI and the extension. Authentication depends on the route prefix.

## Auth

- **Cookie session** (`pitchbox_session`) when `PITCHBOX_AUTH=on` — covers everything **except** the two prefixes below.
- **Extension token** (`Authorization: Bearer <token>`) — required for every `/api/extension/*` call.
- **Public** — `/api/auth/login` and `/api/auth/logout` (the very routes that establish a session).

## Selected endpoints

```http
# Dispatch
POST /api/run                                # { campaignId, trigger? } → { runId, alreadyRunning? }
POST /api/run/[id]/cancel

# Drafts & inbox
PATCH /api/inbox/[id]                        # state transitions (approved | rejected | sent)
GET   /api/inbox/[id]/events
POST  /api/inbox/[id]/reply

# Runners
GET  /api/runners                            # detection results (cached)
POST /api/runners                            # clears cache, re-detects
GET  /api/settings/runner-config
PUT  /api/settings/runner-config             # { slug, config }

# Notifications
GET  /api/notifications                      # { notifications, unread }
POST /api/notifications                      # mark all read
PUT  /api/settings/webhooks                  # { url } | { url: null }

# Playbooks
GET    /api/playbooks
POST   /api/playbooks
GET    /api/playbooks/[id]
PATCH  /api/playbooks/[id]
DELETE /api/playbooks/[id]

# Auth
POST /api/auth/login                         # { username, password }
POST /api/auth/logout

# Extension (Bearer-token only)
POST /api/extension/dm-sync                  # inbox + chat poll → match drafts
POST /api/extension/draft/[id]/sent          # auto-flip a draft to sent

# Export
GET /api/export/[resource]?format=csv        # resource ∈ { drafts, contacts, conversations }
```

### `GET /api/export/[resource]`

Streams a UTF-8 CSV download (RFC 4180 quoting) for the given resource. The
endpoint mirrors the filters used on the matching dashboard page so the export
reflects exactly what the user sees.

| Resource        | Honored query params                                                      | Columns                                                                                                     |
| --------------- | ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `drafts`        | `state`, `kind`, `run`, `campaign`, `project`, `platform`                 | `id, created_at, state, platform, account_handle, target_user, target_subreddit, campaign_id, run_id, body` |
| `contacts`      | `platform`, `q`                                                           | `id, platform, account_handle, target_user, first_contacted_at, last_contacted_at, outcome`                 |
| `conversations` | `filter` (`all`/`replied`/`awaiting`), `kind` (`all`/`dm`/`post_comment`) | `thread_id, account_handle, target_user, kind, last_message_at, message_count`                              |

The only supported `format` today is `csv`. Response headers set
`Content-Type: text/csv; charset=utf-8` and a dated `Content-Disposition`
attachment filename (e.g. `drafts-2026-05-12.csv`).

See [`web/src/routes/api/`](https://github.com/fiorelorenzo/pitchbox/tree/development/web/src/routes/api) for the full surface — every route file is the source of truth.

## Live updates: `/api/stream`

`GET /api/stream` is a Server-Sent Events endpoint the dashboard uses to refresh in real time after runs and draft changes.

- The server sends a `:ping` SSE comment every 15 s so reverse proxies keep the connection alive.
- The client wrapper at [`web/src/lib/realtime/sse.ts`](https://github.com/fiorelorenzo/pitchbox/tree/development/web/src/lib/realtime/sse.ts) tracks the last event timestamp. If no named event lands for **30 s** it closes the underlying `EventSource` and reconnects with capped exponential backoff (1 s → 30 s max). The wrapper exposes a `live` / `reconnecting` / `closed` status the sidebar indicator renders.
- Event kinds currently published: `hello`, `run:started`, `run:log`, `drafts:changed`, plus future ones registered via `lib/server/events.ts`.
