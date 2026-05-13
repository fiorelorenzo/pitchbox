# Chrome extension

The companion extension lives in `extension/` (MV3, Vite + `@crxjs/vite-plugin`). It does two jobs:

1. **Auto mark-as-sent** — when you submit a draft on Reddit, the extension picks up the `pitchbox_draft=<id>` query parameter the dashboard appended to the compose URL and flips the draft to `sent` via the local backend.
2. **Reply ingestion** — a background service worker polls Reddit's inbox (legacy PMs + comment-replies) and Reddit Chat (Matrix) every 10 min via `chrome.alarms`, posting matches to `POST /api/extension/dm-sync`. The server attributes incoming messages to the right drafts and flips them to `replied`.

## Stack

The popup is a Svelte 5 app (runes mode) bundled with `@crxjs/vite-plugin` and styled with Tailwind 4 (theme tokens mirror the dashboard). Content scripts stay as plain TypeScript — they inject directly into Reddit's DOM and don't need a UI framework.

## Install

```bash
npm run build:extension
# then load extension/dist/ unpacked in chrome://extensions
```

## Pairing (recommended)

In **Dashboard → Settings → Integrations → Browser extension**, click **Generate code**. Paste the 8-char code into the extension popup ("Pair with code" tab) along with the backend URL. The server (`POST /api/extension/pair`) consumes the code once and returns a per-device token stored in `chrome.storage.local`. Each device row is independently revocable from the dashboard.

The legacy "Token" tab in the popup still works for the shared `app_config.extension_api_token` — useful for headless setups where you can't open Settings, but devices are preferred.

## Auth & CORS

The dashboard's `hooks.server.ts` exempts `/api/extension/*` from cookie auth. Requests must carry the API token in the `Authorization: Bearer <token>` header. CORS is restricted to `https://www.reddit.com` and `https://old.reddit.com`.

## What the background workers do

- `src/background/inbox-sync.ts` — polls `reddit.com/message/inbox.json`. Splits items into the `items[]` (PMs) and `comments[]` (`t1` items) arrays of the dm-sync request body.
- `src/background/chat-sync.ts` — polls `matrix.redditspace.com/_matrix/client/v3/sync` for Reddit Chat. Before each tick it sends a cheap `GET /_matrix/client/v3/account/whoami` probe; if the Matrix token has expired (401/403) the heavier `/sync` call is skipped, the action badge turns red with `!`, and the popup displays a "Reddit Chat sync paused — please open reddit.com and refresh" notice with a one-click button to open reddit.com.

Both call the same `POST /api/extension/dm-sync` endpoint. The request body now also includes a `status` field summarising channel liveness:

```jsonc
{
  "platform": "reddit",
  "items": [...],
  "comments": [...],
  "status": {
    "chat": "ok" | "unauthorized" | "error" | "unknown",
    "legacy": "ok" | "unauthorized" | "error" | "unknown",
    "captured_at": "2026-05-12T10:00:00Z"
  }
}
```

The server persists the payload into `extension_devices.last_sync_status`. When **any** non-revoked device most recently reported `chat=unauthorized`, the dashboard renders a small banner at the top of **Inbox** and **Conversations** prompting the user to open reddit.com and refresh so the extension can capture a fresh Matrix token.

After every alarm tick the background worker also fires a status-only `dm-sync` heartbeat (with empty `items[]`/`comments[]`) so the dashboard banner reflects current liveness even when no replies came in.
