# syntax=docker/dockerfile:1
#
# Pitchbox client stack (cloud edition): the SvelteKit web app + the daemon, in
# one image with two entrypoints. The web dispatches every run to the in-process
# SDK runner (shared/src/agents/sdk/runner.ts), which reaches models straight
# through the AI Gateway - no separate compute image. This stack holds the data,
# runs the local Pitchbox MCP server, and does the Reddit scraping - so it needs
# Google Chrome.
#
# Like the rest of the repo, it runs from TS source (Vite for the web, tsx for the
# daemon) - no bundling step. That keeps the MCP server + reddit stealth deps
# loading from node_modules as intended. Local-runner users run the app without
# Docker (see docs).

FROM node:22-bookworm-slim AS app
# Global pnpm (no corepack: it writes to HOME at runtime, which the non-root user
# can't always do).
RUN npm install -g pnpm@9.15.9 && npm cache clean --force

# git, which `node:22-bookworm-slim` does not carry. A `git` project source
# is read by cloning it (cli/src/lib/git-clone.ts) and proved reachable with
# `git ls-remote` (shared/src/project-extraction/git-remote.ts), so without
# this every description run over a repository source fails on a missing
# binary - on the deployed cloud edition only, which is exactly where nobody
# was looking.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app

# 1) Install deps from manifests first (better layer caching). Hoisted node-linker
#    gives a flat node_modules so every dep resolves from any workspace package.
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY shared/package.json shared/
COPY cli/package.json cli/
COPY web/package.json web/
COPY daemon/package.json daemon/
COPY extension/package.json extension/
RUN pnpm install --frozen-lockfile --node-linker=hoisted

# 2) Google Chrome for the Reddit MCP tool (Playwright `channel: 'chrome'`) plus
#    its system libraries. Installed system-wide, so the non-root user can use it.
RUN npx playwright install --with-deps chrome \
 && rm -rf /var/lib/apt/lists/*

# 3) Bring the source.
COPY . .

# 3b) Build the SvelteKit web server (adapter-node). @pitchbox/* stay external
#     (see web/vite.config.ts) and load at runtime under tsx, which keeps their CJS
#     deps (ajv via the MCP SDK, the reddit stealth stack) out of the ESM bundle.
RUN pnpm -F web build

# 4) Run as a non-root user. The app is owned by it so Vite's dep cache, the run
#    scratch dirs (daemon/tmp, daemon/logs) and Playwright are all writable.
RUN useradd --create-home --uid 10001 --shell /usr/sbin/nologin pitchbox \
 && mkdir -p daemon/tmp daemon/logs \
 && chown -R pitchbox:pitchbox /app /home/pitchbox
USER pitchbox
ENV HOME=/home/pitchbox \
    PITCHBOX_ROOT=/app \
    PORT=5180 \
    WEB_PORT=5180
EXPOSE 5180
# Default entrypoint is the built web server, run under tsx so the external
# @pitchbox/* TS source resolves at runtime. The daemon service overrides it.
CMD ["node", "--import", "tsx", "web/build/index.js"]
