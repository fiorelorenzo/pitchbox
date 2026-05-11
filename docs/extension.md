# Chrome extension

The companion extension lives in `extension/` (MV3, Vite + `@crxjs/vite-plugin`). It does two jobs:

1. **Auto mark-as-sent** — when you submit a draft on Reddit, the extension picks up the `pitchbox_draft=<id>` query parameter the dashboard appended to the compose URL and flips the draft to `sent` via the local backend.
2. **Reply ingestion** — a background service worker polls Reddit's inbox (legacy PMs + comment-replies) and Reddit Chat (Matrix) every 10 min via `chrome.alarms`, posting matches to `POST /api/extension/dm-sync`. The server attributes incoming messages to the right drafts and flips them to `replied`.

## Install

```bash
npm run build:extension
# then load extension/dist/ unpacked in chrome://extensions
```

In **Dashboard → Settings → Integrations**, generate (or rotate) the **extension API token**. Paste it into the extension's options page. The token authenticates every call to `/api/extension/*` and is stored in `app_config.extension_api_token`.

## Auth & CORS

The dashboard's `hooks.server.ts` exempts `/api/extension/*` from cookie auth. Requests must carry the API token in the `Authorization: Bearer <token>` header. CORS is restricted to `https://www.reddit.com` and `https://old.reddit.com`.

## What the background workers do

- `src/background/inbox-sync.ts` — polls `reddit.com/message/inbox.json`. Splits items into the `items[]` (PMs) and `comments[]` (`t1` items) arrays of the dm-sync request body.
- `src/background/chat-sync.ts` — polls `matrix.redditspace.com/_matrix/client/v3/sync` for Reddit Chat.

Both call the same `POST /api/extension/dm-sync` endpoint.
