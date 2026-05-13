# Chrome extension

The companion extension lives in `extension/` (MV3, Vite + `@crxjs/vite-plugin`). It does two jobs:

1. **Auto mark-as-sent** — when you submit a draft on Reddit, the extension picks up the `pitchbox_draft=<id>` query parameter the dashboard appended to the compose URL and flips the draft to `sent` on the linked backend.
2. **Reply ingestion** — a background service worker polls Reddit's inbox (legacy PMs + comment-replies) and Reddit Chat (Matrix) every 10 min via `chrome.alarms`, posting matches to `POST /api/extension/dm-sync` on every paired backend.

## Stack

The popup is a Svelte 5 app (runes mode) bundled with `@crxjs/vite-plugin` and styled with Tailwind 4 (theme tokens mirror the dashboard). Content scripts stay as plain TypeScript — they inject directly into Reddit's DOM and don't need a UI framework.

## Install

```bash
npm run build:extension
# then load extension/dist/ unpacked in chrome://extensions
```

## Pairing

One click. Open your Pitchbox dashboard in any tab while signed in, click the extension icon, and hit **Pair with this tab**. The extension:

1. Asks Chrome for host permission scoped to that origin only (one prompt the first time you pair that domain).
2. Injects a tiny script into the tab that calls `GET /api/extension/auto-pair` with your session cookie.
3. The dashboard mints a fresh device token tied to your org and returns it.
4. The extension stores the token in `chrome.storage.local` keyed by backend URL.

For the **cloud edition** (`https://app.pitchbox.io/*`) the same script runs automatically the first time you visit while signed in, so cloud users never see the pairing button.

### Pair multiple backends

You can pair both cloud and self-hosted at once — the popup lists every paired backend with a per-row **Disconnect** button. Reddit DM/comment syncs fan out: every paired backend receives the same traffic, so each Pitchbox instance sees every reply. The "auto mark-as-sent" path uses the backend the dashboard linked into the compose URL when the draft was opened, so drafts always flip on the correct backend.

## Auth & CORS

The dashboard's `hooks.server.ts` exempts `/api/extension/*` from cookie auth. Requests must carry the API token in the `Authorization: Bearer <token>` header. CORS is restricted to `https://www.reddit.com` and `https://old.reddit.com` (the only third-party origins that need to call extension endpoints directly).

The auto-pair endpoint is the one exception: it reads the dashboard session cookie (when `PITCHBOX_AUTH=on`) or falls back to the default org. It runs inside the dashboard origin so cookies travel without CORS.

## What the background workers do

- `src/background/inbox-sync.ts` — polls `reddit.com/message/inbox.json`. Splits items into the `items[]` (PMs) and `comments[]` (`t1` items) arrays of the dm-sync request body.
- `src/background/chat-sync.ts` — polls `matrix.redditspace.com/_matrix/client/v3/sync` for Reddit Chat. Before each tick it sends a cheap `GET /_matrix/client/v3/account/whoami` probe; if the Matrix token has expired (401/403) the heavier `/sync` call is skipped, the action badge turns red with `!`, and the popup displays a "Reddit Chat sync paused — please open reddit.com and refresh" notice with a one-click button to open reddit.com.

Both call `POST /api/extension/dm-sync` once per paired backend. The request body includes a `status` field summarising channel liveness:

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
