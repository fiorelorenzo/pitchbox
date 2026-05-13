# Chrome extension

The companion extension lives in `extension/` (MV3, Vite + `@crxjs/vite-plugin`). It does three jobs:

1. **Auto mark-as-sent** - when you submit a draft on Reddit, the extension picks up the `pitchbox_draft=<id>` query parameter the dashboard appended to the compose URL and flips the draft to `sent` on the linked backend.
2. **Reply ingestion** - a background service worker polls Reddit's inbox (legacy PMs + comment-replies) and Reddit Chat (Matrix) on a configurable interval via `chrome.alarms`, posting matches to `POST /api/extension/dm-sync` on every paired backend.
3. **Side panel UI** - clicking the toolbar icon opens a persistent side panel (Chrome 114+, `chrome.sidePanel` API) with three tabs: Dashboard (pairings + manual sync + Reddit Chat token state), Activity (real-time log of every operation, capped at 500 entries, with level/source filters, search, JSON export and clear), and Settings (theme, language, density, poller interval and per-poller toggles, reset).

## Stack

The side panel is a Svelte 5 app (runes mode) bundled with `@crxjs/vite-plugin` and styled with Tailwind 4. It reuses a copy of the dashboard's shadcn-svelte primitives (button, card, tabs, badge, select, switch, dialog, alert-dialog, scroll-area, tooltip) and the dashboard's CSS token palette, so light/dark theming and visual language match 1:1 with the webapp. The bundled i18n module (`src/lib/i18n/`) mirrors the dashboard pattern with English + Italian dictionaries. Content scripts stay as plain TypeScript - they inject directly into Reddit's DOM and don't need a UI framework.

## Install

```bash
npm run build:extension
# then load extension/dist/ unpacked in chrome://extensions
```

Click the toolbar icon to open the side panel. The panel stays open as you browse, so the activity log and pairing status are always one glance away.

## Pairing

One click. Open your Pitchbox dashboard in any tab while signed in, open the side panel, and hit **Pair with this tab** under the Connection card. The extension:

1. Asks Chrome for host permission scoped to that origin only (one prompt the first time you pair that domain).
2. Injects a tiny script into the tab that calls `GET /api/extension/auto-pair` with your session cookie.
3. The dashboard mints a fresh device token tied to your org and returns it.
4. The extension stores the token in `chrome.storage.local` keyed by backend URL.

For the **cloud edition** (`https://app.pitchbox.io/*`) the same script runs automatically the first time you visit while signed in, so cloud users never see the pairing button.

### Pair multiple backends

You can pair both cloud and self-hosted at once - the Connection card lists every paired backend with a per-row **Disconnect** button and a status dot. Reddit DM/comment syncs fan out: every paired backend receives the same traffic, so each Pitchbox instance sees every reply. The "auto mark-as-sent" path uses the backend the dashboard linked into the compose URL when the draft was opened, so drafts always flip on the correct backend.

## Activity log

Every operation the extension performs writes to a capped ring buffer (500 events) in `chrome.storage.local`, surfaced live in the Activity tab via `chrome.storage.onChanged`. Sources include: `pairing` (added/removed), `dm-sync` and `chat-sync` (per-cycle ok/unauthorized/error with counters), `matrix-token` (capture/refresh), `reddit-action` (DM/comment/submit sent or backend flip failed), `settings` (changes), and `system` (boot, alarms re-applied). The Activity tab supports level + source filters, free-text search across the message and meta, JSON export, and a confirmed clear.

## Settings

- **Appearance** - theme (light / dark / system), density (compact / comfortable). The system option follows `prefers-color-scheme` and reacts live.
- **Language** - English or Italian. Initial value resolves from `chrome.i18n.getUILanguage()` and is persisted.
- **Sync** - poller interval (5/10/15/30 min) and independent toggles for the legacy inbox poller and the Reddit Chat poller. The service worker re-applies `chrome.alarms` whenever the settings change.
- **Data** - clear the activity log, or reset the extension entirely (wipes pairings, settings and the log).

## Auth & CORS

The dashboard's `hooks.server.ts` exempts `/api/extension/*` from cookie auth. Requests must carry the API token in the `Authorization: Bearer <token>` header. CORS is restricted to `https://www.reddit.com` and `https://old.reddit.com` (the only third-party origins that need to call extension endpoints directly).

The auto-pair endpoint is the one exception: it reads the dashboard session cookie (when `PITCHBOX_AUTH=on`) or falls back to the default org. It runs inside the dashboard origin so cookies travel without CORS.

## What the background workers do

- `src/background/inbox-sync.ts` - polls `reddit.com/message/inbox.json`. Splits items into the `items[]` (PMs) and `comments[]` (`t1` items) arrays of the dm-sync request body.
- `src/background/chat-sync.ts` - polls `matrix.redditspace.com/_matrix/client/v3/sync` for Reddit Chat. Before each tick it sends a cheap `GET /_matrix/client/v3/account/whoami` probe; if the Matrix token has expired (401/403) the heavier `/sync` call is skipped, the action badge turns red with `!`, and the Reddit token card in the side panel displays a "Reddit Chat sync paused - please open reddit.com and refresh" notice with a one-click button to open reddit.com.

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
