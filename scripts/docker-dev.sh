#!/usr/bin/env bash
# One command to run the whole cloud-edition stack in dev (Docker): postgres +
# migrations/seed + web (Vite hot-reload) + daemon (tsx watch). The web dispatches
# every run to the in-process SDK runner, which reaches models through the AI
# Gateway - no separate runner container.
#
#   pnpm run docker:dev            # or: bash scripts/dev.sh
#
# Override any of these by exporting them before running.
set -euo pipefail
cd "$(dirname "$0")/.."

# Dev defaults for the values the base compose requires. Throwaway - dev only.
export ENCRYPTION_KEY="${ENCRYPTION_KEY:-0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef}"

if [ -z "${AI_GATEWAY_API_KEY:-}" ]; then
  echo "WARNING: AI_GATEWAY_API_KEY is not set - the cloud runner won't be able to" >&2
  echo "         reach any model. Export it before running." >&2
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
