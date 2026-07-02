#!/usr/bin/env bash
# One command to run the whole cloud-edition stack in dev (Docker): postgres +
# migrations/seed + web (Vite hot-reload) + daemon (tsx watch) + the cloud runner
# (tsx watch). The runner uses YOUR local Claude auth.
#
#   pnpm run docker:dev            # or: bash scripts/dev.sh
#
# Override any of these by exporting them before running.
set -euo pipefail
cd "$(dirname "$0")/.."

# Dev defaults for the values the base compose requires. Throwaway - dev only.
export ENCRYPTION_KEY="${ENCRYPTION_KEY:-0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef}"
export RUNNER_TOKEN="${RUNNER_TOKEN:-devtoken}"
export PITCHBOX_RUNNER_URL="ws://runner:8787"
export PITCHBOX_RUNNER_TOKEN="$RUNNER_TOKEN"

# The runner needs YOUR Claude credentials, inherited from this shell. On the
# devbox CLAUDE_CODE_OAUTH_TOKEN is already exported; elsewhere run
# `claude setup-token` and export it, or set ANTHROPIC_API_KEY.
if [ -z "${CLAUDE_CODE_OAUTH_TOKEN:-}" ] && [ -z "${ANTHROPIC_API_KEY:-}" ]; then
  echo "WARNING: neither CLAUDE_CODE_OAUTH_TOKEN nor ANTHROPIC_API_KEY is set." >&2
  echo "         The runner won't be able to authenticate. Run 'claude setup-token'" >&2
  echo "         and export CLAUDE_CODE_OAUTH_TOKEN (or set ANTHROPIC_API_KEY)." >&2
fi

# Ignore the repo root .env (it holds the LOCAL, non-Docker dev config, e.g. a
# 127.0.0.1 DATABASE_URL unreachable from inside containers). The internal DB is the
# compose `postgres` service, applied via the compose defaults.
exec docker compose \
  --env-file /dev/null \
  -f docker-compose.yml \
  -f docker-compose.app.yml \
  -f docker-compose.app.dev.yml \
  up "$@"
