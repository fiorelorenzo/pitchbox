<p align="left"><img src="assets/brand/wordmark-dark.svg#gh-dark-mode-only" alt="Pitchbox" height="64"><img src="assets/brand/wordmark-light.svg#gh-light-mode-only" alt="Pitchbox" height="64"></p>

Self-hosted, human-in-the-loop outreach agent. The agent does the research and drafting; you approve before anything is sent.

> ⚠️ Alpha - currently at **v0.4.0**. Breaking changes possible until v1.0.0.

**📖 Full documentation:** **<https://fiorelorenzo.github.io/pitchbox/>**

## Quick start

```bash
git clone https://github.com/fiorelorenzo/pitchbox.git
cd pitchbox
cp .env.example .env
# edit .env - set DATABASE_URL, PITCHBOX_ROOT (absolute path), ENCRYPTION_KEY (openssl rand -hex 32)
docker compose up -d postgres
pnpm install
pnpm run migrate
pnpm -F @pitchbox/shared seed:core
pnpm run dev            # dashboard at http://127.0.0.1:5180
```

Embedded daemon mode runs the scheduler + reply poller + retention loops inside the web process - set `PITCHBOX_EMBED_DAEMON=1` in `.env` and skip `pnpm -F daemon dev`. See [the daemon docs](https://fiorelorenzo.github.io/pitchbox/daemon) for when to run it as a separate process instead.

Prerequisites: Node >= 22, pnpm 9.15 (via corepack), Docker, and one of the supported ACP-compatible agent CLIs on PATH (Claude Code, Codex, Gemini CLI, GitHub Copilot CLI, opencode, or Qwen Code - details in [docs/runners.md](./docs/runners.md)).

## Browser extension

The companion Chrome extension auto-marks drafts as sent when you submit on Reddit, syncs replies back into the dashboard, and surfaces what it's doing in a persistent **side panel** with three tabs (Dashboard, Activity log, Settings).

```bash
pnpm run build:extension   # then load extension/dist/ unpacked in chrome://extensions
```

Click the toolbar icon to open the side panel. Pair with your dashboard in one click, kick off a manual sync, follow every operation in real time (pairings, DM/chat sync runs, Matrix token captures, Reddit actions), and tune theme (light/dark/system), language (en/it), density and poller interval from Settings. You can pair multiple backends (cloud + self-hosted) at the same time. Details: <https://fiorelorenzo.github.io/pitchbox/extension>

## License

**AGPL-3.0-or-later** for the open-source (self-hosted) edition - see [LICENSE](./LICENSE). A future Pitchbox Cloud edition will ship under a separate commercial licence; see [NOTICE.md](./NOTICE.md) for the dual-licensing framework.
