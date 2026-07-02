#!/usr/bin/env bash
# Local dev with the cloud runner (and web + daemon) OUTSIDE Docker - for iterating
# on / debugging the runner. Only postgres runs in Docker; web + daemon + runner run
# on the HOST via pnpm (hot-reload, native `node --inspect` debugging). Everything
# talks over localhost, so it works even where a container can't reach the host
# (e.g. a firewalled VPS - which is why the runner can't sit on the host with the
# web in Docker there).
#
#   pnpm run dev:local
#   RUNNER_PORT=8790 pnpm run dev:local     # if 8787 is taken
#
# Uses your repo .env (DATABASE_URL, ENCRYPTION_KEY, ...) and your local Claude auth
# (CLAUDE_CODE_OAUTH_TOKEN / ANTHROPIC_API_KEY). Run from an interactive shell so
# node/pnpm (mise) and the Claude token are on the environment.
set -euo pipefail
cd "$(dirname "$0")/.."

RUNNER_PORT="${RUNNER_PORT:-8787}"

# Load the repo .env for the host processes (its 127.0.0.1 DATABASE_URL is correct
# here - postgres is published on the host).
set -a
[ -f .env ] && . ./.env
set +a
export ENCRYPTION_KEY="${ENCRYPTION_KEY:-0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef}"

# Cloud edition pointed at the runner running on THIS host.
export PITCHBOX_EDITION=cloud
export RUNNER_TOKEN="${RUNNER_TOKEN:-devtoken}"
export PITCHBOX_RUNNER_TOKEN="$RUNNER_TOKEN"
export PITCHBOX_RUNNER_URL="ws://127.0.0.1:${RUNNER_PORT}"

if [ -z "${CLAUDE_CODE_OAUTH_TOKEN:-}" ] && [ -z "${ANTHROPIC_API_KEY:-}" ]; then
  echo "WARNING: neither CLAUDE_CODE_OAUTH_TOKEN nor ANTHROPIC_API_KEY is set - the" >&2
  echo "         runner won't authenticate. Run 'claude setup-token' and export it." >&2
fi

# The runner is a standalone package; make sure its deps are installed.
[ -d cloud/runner/node_modules ] || (cd cloud/runner && pnpm install)

# 1) Postgres in Docker + migrations/seed.
docker compose up -d postgres
echo "Waiting for postgres..."
until docker compose exec -T postgres pg_isready -U pitchbox >/dev/null 2>&1; do sleep 1; done
pnpm -F @pitchbox/shared migrate
pnpm -F @pitchbox/shared seed:core

# 2) web + daemon + runner on the host, hot-reloaded, one command (Ctrl-C stops all).
exec pnpm exec concurrently -n web,daemon,runner -c blue,magenta,green --kill-others-on-fail \
  "pnpm -F web dev" \
  "pnpm -F daemon dev" \
  "PORT=${RUNNER_PORT} RUNNER_TOKEN=${RUNNER_TOKEN} pnpm -C cloud/runner dev"
