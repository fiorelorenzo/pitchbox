# HTTP API

The dashboard's `/api/*` routes power the UI and the extension. Authentication depends on the route prefix.

## Auth

- **Cookie session** (`pitchbox_session`) when `PITCHBOX_AUTH=on` - covers everything **except** the cases below.
- **Internal dispatch token** (`Authorization: Bearer <token>`) - the one exception to cookie auth on a non-exempt route: `POST /api/run` accepts `PITCHBOX_INTERNAL_TOKEN` in place of a session, but only when there is no session on the request and the token is configured. This is how the daemon (which has no browser session) authenticates its own scheduled/keyword-triggered dispatch - see [`auth.md`](./auth.md) (#378).
- **Extension per-device token** (`Authorization: Bearer <token>`) - required for every `/api/extension/*` call. Each paired device gets its own token in `extension_devices`; the side panel mints one via `POST /api/extension/auto-pair` using the dashboard session cookie. There is no shared singleton token.
- **Public** - `/api/auth/login`, `/api/auth/logout`, `/api/auth/register`, `/api/auth/password/forgot`, `/api/auth/password/reset`, and `/api/extension/auto-pair` (which authenticates with the dashboard session cookie, not a bearer token). `/api/auth/password` (self-service change), `/api/auth/unlock` and `/api/auth/failures` are **not** public despite the `/api/auth/*` prefix - they need a session like every other `/api/*` route (see [`auth.md`](./auth.md)).

## Selected endpoints

```http
# Dispatch
POST   /api/run                              # { campaignId, trigger? } → { runId, alreadyRunning? }
DELETE /api/run/[id]                         # cancel a running run
GET    /api/runs/[id]/events                 # a run's event log

# Drafts
PATCH  /api/drafts/[id]                      # edit body or transition state (optimistic-locked)
POST   /api/drafts/[id]/regenerate           # re-run the drafter for this draft
POST   /api/drafts/bulk-approve              # approve many drafts at once
POST   /api/drafts/bulk-reschedule           # reschedule many drafts

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
POST /api/auth/register                      # { username, password, email, token? } - policy-gated, see auth.md
POST /api/auth/password                      # { currentPassword, newPassword } - session required
POST /api/auth/password/forgot               # { email } - always 200, mints a reset token when the address exists
POST /api/auth/password/reset                # { token, newPassword }

# Extension - pairing
POST /api/extension/pair                     # public → redeem a short-lived pairing code for a token
POST /api/extension/auto-pair                # cookie-auth → mints a per-device token
POST /api/extension/handshake                # bearer-auth → liveness ping

# Extension - drafts (bearer-auth, per-device)
GET  /api/extension/draft/[id]               # fetch draft for the compose UI
POST /api/extension/draft/[id]/armed         # flip to 'armed' (compose page opened)
POST /api/extension/draft/[id]/sent          # flip to 'sent' (user submitted on Reddit)

# Extension - reply sync (bearer-auth, per-device)
POST /api/extension/dm-sync                  # inbox + chat poll → match drafts + status heartbeat

# Extension - voice import (bearer-auth, per-device)
POST /api/extension/voice-import              # raw archive body → import counts + corpus status

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

### `POST /api/extension/voice-import`

Imports a LinkedIn "Get a copy of your data" export into the operator's voice
corpus - the same import `pitchbox voice:import` and the companion's
`/companion/voice` upload button run, now reachable without a terminal or a
browser. Device bearer-token auth, same as every other `/api/extension/*`
route (see "Auth" above) - mint one with `POST /api/extension/pair` from a
pairing code generated in Settings, no extension install required.

The body is the archive's raw bytes, not a multipart form. `Content-Type`
says which shape it is:

| Content-Type                   | Body                                                   |
| ------------------------------ | ------------------------------------------------------ |
| `application/zip`              | The export zip LinkedIn hands back directly            |
| `application/x-zip-compressed` | Same as above (some clients report this instead)       |
| `text/csv`                     | A single already-extracted `Shares.csv`/`Comments.csv` |

The body is capped at 20MB, checked against `Content-Length` before anything
is read and again while streaming, so an oversized upload is refused (`413`)
without ever being buffered into memory.

```bash
curl -X POST https://your-pitchbox-host/api/extension/voice-import \
  -H "Authorization: Bearer $PITCHBOX_DEVICE_TOKEN" \
  -H "Content-Type: application/zip" \
  --data-binary @linkedin-export.zip
```

A successful response is a full accounting, not `{"ok":true}`:

```json
{
  "ok": true,
  "imported": { "post": 2, "comment": 1 },
  "duplicates": { "post": 0, "comment": 0 },
  "skippedNoText": { "post": 1, "comment": 1 },
  "totalRows": { "post": 3, "comment": 2 },
  "noop": false,
  "message": "Imported 3 new item(s) (2 post(s), 1 comment(s)).",
  "profile": {
    "post": { "itemCount": 2, "measurable": false },
    "comment": { "itemCount": 1, "measurable": false },
    "reply": { "itemCount": 0, "measurable": false }
  }
}
```

- `imported` - new rows actually written, per genre.
- `duplicates` - parsed rows already on file (same `(organizationId, externalId)`), dropped by the insert's own dedup.
- `skippedNoText` - rows dropped before ever reaching the corpus: a bare repost in `Shares.csv`, or a reaction with no written comment in `Comments.csv`.
- `totalRows` - every row the file had, per genre (`imported + duplicates + skippedNoText`).
- `noop` - `true` when nothing new landed. Re-posting the same archive is the normal case, not an error: the response still says so explicitly rather than looking like an ambiguous success.
- `profile` - each genre's `itemCount` and whether it has cleared `MIN_ITEMS_TO_DERIVE` (`measurable`) after this import.

Refusals are a `4xx`/`5xx` with a readable `{ "message": "..." }` body, never a
stack trace: `400` for an unrecognised `Content-Type`, an empty body, a file
that isn't a valid archive, or a zip with neither `Shares.csv` nor
`Comments.csv`; `401` for a missing/invalid/revoked device token; `413` for a
body over the 20MB cap; `429` for more than 10 imports/minute from one
device; `500` if the `linkedin` platform row is missing (a self-host seed
problem, not a bad request).

See [`web/src/routes/api/`](https://github.com/fiorelorenzo/pitchbox/tree/development/web/src/routes/api) for the full surface - every route file is the source of truth.

## Optimistic locking on draft state transitions

Every state-changing draft endpoint (`PATCH /api/drafts/[id]`, `POST /api/extension/draft/[id]/sent`) reads the `drafts.version` column, bumps it inside the same `UPDATE … WHERE id = $1 AND version = $2`, and returns one of two outcomes:

- **`200 OK`** - the update committed; the new row's `version` is the previous one plus one.
- **`409 Conflict`** with body `{ "error": "version_conflict", "current_version": <int> }` - another writer beat us to it. Callers should re-fetch the draft (the `current_version` hint is purely advisory) and retry once with the fresh version.

Clients MAY include `"version": <int>` in their request body to opt in to strict checking. When omitted, the server falls back to the row's current version - the contract is still safe under cross-tab races where at least one writer supplies an explicit version, and the extension auto-retries once after re-fetching `GET /api/extension/draft/[id]`.

## Live updates: `/api/stream`

`GET /api/stream` is a Server-Sent Events endpoint the dashboard uses to refresh in real time after runs and draft changes.

- The server sends a `:ping` SSE comment every 15 s so reverse proxies keep the connection alive.
- The client wrapper at [`web/src/lib/realtime/sse.ts`](https://github.com/fiorelorenzo/pitchbox/tree/development/web/src/lib/realtime/sse.ts) tracks the last event timestamp. If no named event lands for **30 s** it closes the underlying `EventSource` and reconnects with capped exponential backoff (1 s → 30 s max). The wrapper exposes a `live` / `reconnecting` / `closed` status the sidebar indicator renders.
- Event kinds currently published: `hello`, `run:started`, `run:log`, `run:finished`, `drafts:changed`, `project:description:updated`, plus future ones registered via `lib/server/events.ts`.
- `run:started` and `run:finished` carry `{ runId, campaignId?, projectId?, exitCode?, error? }`. The campaign detail page subscribes to both and calls `invalidateAll()` when the event's `campaignId` matches its own, so the "Setup required" / "In progress" banner and the "Run now" button reflect the new state without a manual reload. Other surfaces (Projects overview, Inbox) wire the same events in the same way.
