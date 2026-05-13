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
npm install
npm run migrate
npm run -w @pitchbox/shared seed:core
npm run dev            # dashboard at http://127.0.0.1:5180
```

Embedded daemon mode runs the scheduler + reply poller + retention loops inside the web process - set `PITCHBOX_EMBED_DAEMON=1` in `.env` and skip `npm run -w daemon dev`. See [the daemon docs](https://fiorelorenzo.github.io/pitchbox/daemon) for when to run it as a separate process instead.

Prerequisites: Node ≥ 22, Docker, and the `claude` CLI (or another supported runner) on PATH.

## Browser extension

The companion Chrome extension auto-marks drafts as sent when you submit on Reddit, and syncs replies back into the dashboard.

```bash
npm run build:extension   # then load extension/dist/ unpacked in chrome://extensions
```

Pairing is one click: open your Pitchbox dashboard tab and hit **Pair with this tab** in the extension popup. You can pair multiple backends (cloud + self-hosted) at the same time. Details: <https://fiorelorenzo.github.io/pitchbox/extension>

## License

**AGPL-3.0-or-later** for the open-source (self-hosted) edition - see [LICENSE](./LICENSE). A future Pitchbox Cloud edition will ship under a separate commercial licence; see [NOTICE.md](./NOTICE.md) for the dual-licensing framework.
