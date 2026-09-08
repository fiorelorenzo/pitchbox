#!/usr/bin/env bash
# The main dev command: launches EVERYTHING, hot-reloaded, in one shot -
# postgres (Docker) + migrations/seed, then web + daemon + the Chrome extension
# + the docs, all on the HOST via pnpm. Ctrl-C stops all.
#
#   pnpm run dev
#
# Everything talks over localhost (works even on a firewalled host). Run from an
# interactive shell so node/pnpm (mise) is present.
set -euo pipefail
cd "$(dirname "$0")/.."

# Load the repo .env for the host processes (its 127.0.0.1 DATABASE_URL is correct
# here - postgres is published on the host).
set -a
[ -f .env ] && . ./.env
set +a
export ENCRYPTION_KEY="${ENCRYPTION_KEY:-0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef}"

# We run the daemon as its own process below, so the web must NOT also embed it
# (the repo .env often sets PITCHBOX_EMBED_DAEMON=1) - otherwise the loops run twice.
export PITCHBOX_EMBED_DAEMON=0

# Cloud edition: dispatches to the in-process SDK runner, which reaches every
# model through the AI Gateway - no separate runner process to launch here.
export PITCHBOX_EDITION=cloud

if [ -z "${AI_GATEWAY_API_KEY:-}" ]; then
  echo "WARNING: AI_GATEWAY_API_KEY is not set - the cloud runner won't be able to" >&2
  echo "         reach any model. Set it in .env." >&2
fi

# 1) Postgres in Docker + migrations/seed.
docker compose up -d postgres
echo "Waiting for postgres..."
until docker compose exec -T postgres pg_isready -U pitchbox >/dev/null 2>&1; do sleep 1; done
pnpm -F @pitchbox/shared migrate
pnpm -F @pitchbox/shared seed:core

# 2) Everything on the host, hot-reloaded, one command (Ctrl-C stops all).
exec pnpm exec concurrently -n web,daemon,ext,docs -c blue,magenta,cyan,yellow --kill-others-on-fail \
  "pnpm -F web dev" \
  "pnpm -F daemon dev" \
  "pnpm -F @pitchbox/extension dev" \
  "pnpm run docs:dev"
