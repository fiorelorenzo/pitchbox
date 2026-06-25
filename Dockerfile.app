# syntax=docker/dockerfile:1
#
# Pitchbox client stack (cloud edition): the SvelteKit web app + the daemon, in
# one image with two entrypoints. Compute runs on the cloud runner (separate
# image); this stack holds the data, runs the local Pitchbox MCP server, and does
# the Reddit scraping - so it needs Google Chrome.
#
# Like the rest of the repo, it runs from TS source (Vite for the web, tsx for the
# daemon) - no bundling step. That keeps the cloud adapter + MCP server + reddit
# stealth deps loading from node_modules as intended. Build context is the umbrella
# root (the web's Vite alias resolves the private cloud/adapter source).
# Local-runner users run the app without Docker (see docs).

FROM node:22-bookworm-slim AS app
# Global pnpm (no corepack: it writes to HOME at runtime, which the non-root user
# can't always do).
RUN npm install -g pnpm@9.15.9 && npm cache clean --force
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

# 3b) The cloud adapter is a separate package (not in the workspace); install its
#     runtime deps (ws) so Vite can resolve them when it loads the adapter source.
RUN cd cloud/adapter && pnpm install --node-linker=hoisted

# 4) Run as a non-root user. The app is owned by it so Vite's dep cache, the run
#    scratch dirs (daemon/tmp, daemon/logs) and Playwright are all writable.
RUN useradd --create-home --uid 10001 --shell /usr/sbin/nologin pitchbox \
 && mkdir -p daemon/tmp daemon/logs \
 && chown -R pitchbox:pitchbox /app /home/pitchbox
USER pitchbox
ENV HOME=/home/pitchbox \
    PITCHBOX_ROOT=/app \
    WEB_PORT=5180
EXPOSE 5180
# Default entrypoint is the web (Vite) server; the daemon service overrides it.
CMD ["pnpm", "-F", "web", "dev"]
