# HTTP API

The dashboard's `/api/*` routes power the UI and the extension. Authentication depends on the route prefix.

## Auth

- **Cookie session** (`pitchbox_session`) when `PITCHBOX_AUTH=on` - covers everything **except** the two prefixes below.
- **Extension per-device token** (`Authorization: Bearer <token>`) - required for every `/api/extension/*` call. Each paired device gets its own token in `extension_devices`; the side panel mints one via `POST /api/extension/auto-pair` using the dashboard session cookie. There is no shared singleton token.
- **Public** - `/api/auth/login`, `/api/auth/logout`, and `/api/extension/auto-pair` (which authenticates with the dashboard session cookie, not a bearer token).

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

# Extension - pairing
POST /api/extension/auto-pair                # cookie-auth → mints a per-device token
POST /api/extension/handshake                # bearer-auth → liveness ping

# Extension - drafts (bearer-auth, per-device)
GET  /api/extension/draft/[id]               # fetch draft for the compose UI
POST /api/extension/draft/[id]/armed         # flip to 'armed' (compose page opened)
POST /api/extension/draft/[id]/sent          # flip to 'sent' (user submitted on Reddit)

# Extension - reply sync (bearer-auth, per-device)
POST /api/extension/dm-sync                  # inbox + chat poll → match drafts + status heartbeat
GET  /api/extension/dm-sync/status           # last sync stamp + per-channel liveness

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

See [`web/src/routes/api/`](https://github.com/fiorelorenzo/pitchbox/tree/development/web/src/routes/api) for the full surface - every route file is the source of truth.

## Optimistic locking on draft state transitions

Every state-changing draft endpoint (`PATCH /inbox/[id]`, `POST /api/extension/draft/[id]/sent`) reads the `drafts.version` column, bumps it inside the same `UPDATE … WHERE id = $1 AND version = $2`, and returns one of two outcomes:

- **`200 OK`** - the update committed; the new row's `version` is the previous one plus one.
- **`409 Conflict`** with body `{ "error": "version_conflict", "current_version": <int> }` - another writer beat us to it. Callers should re-fetch the draft (the `current_version` hint is purely advisory) and retry once with the fresh version.

Clients MAY include `"version": <int>` in their request body to opt in to strict checking. When omitted, the server falls back to the row's current version - the contract is still safe under cross-tab races where at least one writer supplies an explicit version, and the extension auto-retries once after re-fetching `GET /api/extension/draft/[id]`.

## Live updates: `/api/stream`

`GET /api/stream` is a Server-Sent Events endpoint the dashboard uses to refresh in real time after runs and draft changes.

- The server sends a `:ping` SSE comment every 15 s so reverse proxies keep the connection alive.
- The client wrapper at [`web/src/lib/realtime/sse.ts`](https://github.com/fiorelorenzo/pitchbox/tree/development/web/src/lib/realtime/sse.ts) tracks the last event timestamp. If no named event lands for **30 s** it closes the underlying `EventSource` and reconnects with capped exponential backoff (1 s → 30 s max). The wrapper exposes a `live` / `reconnecting` / `closed` status the sidebar indicator renders.
- Event kinds currently published: `hello`, `run:started`, `run:log`, `drafts:changed`, plus future ones registered via `lib/server/events.ts`.
