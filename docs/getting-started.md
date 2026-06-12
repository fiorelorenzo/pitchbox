# Getting started

Pitchbox is a Node + pnpm monorepo. You need:

- Node ≥ 22
- pnpm 9.15 (enable via `corepack enable`)
- Docker (for the Postgres dev DB)
- One ACP-compatible agent CLI on PATH (see below)

## Agent CLI

Pitchbox talks to every backend through the open [Agent Client Protocol](https://agentclientprotocol.com), so any ACP-compatible CLI will do. Install at least one of the supported runners and authenticate it:

- **Claude Code**: `pnpm add -g @anthropic-ai/claude-code`, then `claude login` (or set `ANTHROPIC_API_KEY`).
- **Codex**: `pnpm add -g @openai/codex`, then `codex login` (or set `OPENAI_API_KEY`).
- **Gemini CLI**: `pnpm add -g @google/gemini-cli`, then `gemini auth login` (or set `GEMINI_API_KEY`).
- **GitHub Copilot CLI**: see GitHub docs, then `copilot auth login`.
- **opencode**: `pnpm add -g opencode-ai`, then configure a provider (see opencode docs).
- **Qwen Code**: install the Qwen Code CLI per Alibaba docs and configure DashScope credentials.

The dashboard probes each registered runner on boot and the campaign-creation form only lets you pick installed ones. See [Agent runners](/runners) for details.

## Install

```bash
git clone https://github.com/fiorelorenzo/pitchbox.git
cd pitchbox
pnpm install
cp .env.example .env  # then set ENCRYPTION_KEY (32-byte hex) and PITCHBOX_ROOT
```

`ENCRYPTION_KEY` protects account secrets at rest - generate one with `openssl rand -hex 32`. `PITCHBOX_ROOT` must be the absolute path to the repo root.

## Database

```bash
pnpm run db:up                                # boots Postgres on port 5434
pnpm run migrate                              # applies the latest Drizzle migrations
pnpm -F @pitchbox/shared seed:core            # seeds platforms, default playbooks, quota defaults
```

## Run

```bash
pnpm run dev               # web dashboard on http://127.0.0.1:5180
```

By default the dashboard runs on its own and you start the background daemon as a second process:

```bash
pnpm -F daemon dev         # scheduler + reply poller + retention + webhook DLQ
```

For single-host installs you can skip the second process and run everything in one - set `PITCHBOX_EMBED_DAEMON=1` in your `.env` and the same loops boot inside the web server. See [Daemon](/daemon) for when each mode makes sense.

## Optional: turn on authentication

Pitchbox ships unauthenticated by default for single-user self-host. To gate the dashboard:

```bash
echo 'PITCHBOX_AUTH=on' >> .env
pnpm run dev
```

The first user you create via `/login` becomes the admin.

## Command palette

Press `Cmd+K` (macOS) or `Ctrl+K` (Windows/Linux) anywhere in the dashboard to open a global search palette. It matches drafts, contacts, campaigns and projects, and also exposes quick actions like "Create campaign" or "Open Settings".

## Appearance

Theme (System/Light/Dark) and interface language (EN/IT) live under **Settings → Appearance**. Your choice persists locally per browser; `System` follows the OS preference.

The dashboard is responsive down to roughly 375 px wide: on tablet and phone widths the sidebar collapses behind a hamburger button at top-left, the Inbox stacks the draft list and detail panel vertically with a back button, and filters fold into a popover.

## Chrome extension

Build and load `extension/dist/` unpacked, then open your dashboard in any tab and click the Pitchbox toolbar icon to open the side panel. Hit **Pair with this tab** under the Dashboard tab. Cloud users on `app.pitchbox.io` are paired automatically the first time they visit while signed in. Details: [the extension page](/extension).
