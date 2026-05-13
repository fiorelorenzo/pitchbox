# Getting started

Pitchbox is a Node monorepo. You need:

- Node ≥ 22
- Docker (for the Postgres dev DB)
- The `claude` CLI logged into a Claude subscription (the default agent runner; `codex` and `opencode` are also supported)

## Install

```bash
git clone https://github.com/fiorelorenzo/pitchbox.git
cd pitchbox
npm install
cp .env.example .env  # then set ENCRYPTION_KEY (32-byte hex) and PITCHBOX_ROOT
```

`ENCRYPTION_KEY` protects account secrets at rest - generate one with `openssl rand -hex 32`. `PITCHBOX_ROOT` must be the absolute path to the repo root.

## Database

```bash
npm run db:up                                 # boots Postgres on port 5434
npm run migrate                               # applies the latest Drizzle migrations
npm run -w @pitchbox/shared seed:core         # seeds platforms, default playbooks, quota defaults
```

## Run

```bash
npm run dev                # web dashboard on http://127.0.0.1:5180
```

By default the dashboard runs on its own and you start the background daemon as a second process:

```bash
npm run -w daemon dev      # scheduler + reply poller + retention + webhook DLQ
```

For single-host installs you can skip the second process and run everything in one - set `PITCHBOX_EMBED_DAEMON=1` in your `.env` and the same loops boot inside the web server. See [Daemon](/daemon) for when each mode makes sense.

## Optional: turn on authentication

Pitchbox ships unauthenticated by default for single-user self-host. To gate the dashboard:

```bash
echo 'PITCHBOX_AUTH=on' >> .env
npm run dev
```

The first user you create via `/login` becomes the admin.

## Command palette

Press `Cmd+K` (macOS) or `Ctrl+K` (Windows/Linux) anywhere in the dashboard to open a global search palette. It matches drafts, contacts, campaigns and projects, and also exposes quick actions like "Create campaign" or "Open Settings".

## Appearance

Theme (System/Light/Dark) and interface language (EN/IT) live under **Settings → Appearance**. Your choice persists locally per browser; `System` follows the OS preference.

The dashboard is responsive down to roughly 375 px wide: on tablet and phone widths the sidebar collapses behind a hamburger button at top-left, the Inbox stacks the draft list and detail panel vertically with a back button, and filters fold into a popover.

## Chrome extension

Build and load `extension/dist/` unpacked, then open your dashboard in any tab and click **Pair with this tab** in the extension popup. Cloud users on `app.pitchbox.io` are paired automatically the first time they visit while signed in. Details: [the extension page](/extension).
