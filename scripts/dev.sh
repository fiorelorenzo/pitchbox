#!/usr/bin/env bash
# The main dev command: launches EVERYTHING, hot-reloaded, in one shot -
# postgres (Docker) + migrations/seed, then web + daemon + the cloud runner +
# the Chrome extension + the docs, all on the HOST via pnpm. Ctrl-C stops all.
#
#   pnpm run dev
#   RUNNER_PORT=8790 pnpm run dev      # if 8787 is taken
#
# Everything talks over localhost (works even on a firewalled host). The runner
# uses YOUR local Claude auth (CLAUDE_CODE_OAUTH_TOKEN / ANTHROPIC_API_KEY). Run
# from an interactive shell so node/pnpm (mise) and the Claude token are present.
set -euo pipefail
cd "$(dirname "$0")/.."

RUNNER_PORT="${RUNNER_PORT:-8787}"

# Pick a free runner port, starting at RUNNER_PORT and advancing if it's taken
# (a leftover process, or something else on 8787). The web is pointed at whatever
# we end up using, so it just works.
_port_taken() { command -v ss >/dev/null 2>&1 && ss -ltn "sport = :$1" 2>/dev/null | grep -q LISTEN; }
_start_port=$RUNNER_PORT
while _port_taken "$RUNNER_PORT"; do
  RUNNER_PORT=$((RUNNER_PORT + 1))
  if [ "$RUNNER_PORT" -gt $((_start_port + 30)) ]; then
    echo "No free runner port near ${_start_port}. Set RUNNER_PORT to a free one." >&2
    exit 1
  fi
done
[ "$RUNNER_PORT" != "$_start_port" ] &&
  echo "Port ${_start_port} is taken; using RUNNER_PORT=${RUNNER_PORT} for the runner."

# Load the repo .env for the host processes (its 127.0.0.1 DATABASE_URL is correct
# here - postgres is published on the host).
set -a
[ -f .env ] && . ./.env
set +a
export ENCRYPTION_KEY="${ENCRYPTION_KEY:-0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef}"

# We run the daemon as its own process below, so the web must NOT also embed it
# (the repo .env often sets PITCHBOX_EMBED_DAEMON=1) - otherwise the loops run twice.
export PITCHBOX_EMBED_DAEMON=0

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

# 2) Everything on the host, hot-reloaded, one command (Ctrl-C stops all).
exec pnpm exec concurrently -n web,daemon,runner,ext,docs -c blue,magenta,green,cyan,yellow --kill-others-on-fail \
  "pnpm -F web dev" \
  "pnpm -F daemon dev" \
  "PORT=${RUNNER_PORT} RUNNER_HOST=127.0.0.1 RUNNER_TOKEN=${RUNNER_TOKEN} pnpm -C cloud/runner dev" \
  "pnpm -F @pitchbox/extension dev" \
  "pnpm run docs:dev"
