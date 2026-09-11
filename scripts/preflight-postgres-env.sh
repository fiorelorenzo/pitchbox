#!/usr/bin/env bash
# Derives a checkout-local Postgres project name, host port, and database name
# for `preflight`'s "test-postgres" check (see .github/preflight.json and
# docker-compose.preflight.yml). LOR-269: those three were fixed strings, so
# every checkout on the box shared one container and one database - two
# checkouts running the check at once truncated each other's tables, and
# whichever finished first tore the stack down (`down -v`) out from under the
# other. Deriving all three from the checkout's own path gives every worktree
# its own stack, so two runs can never see or destroy each other's.
#
# Meant to be SOURCED, not executed: `.github/preflight.json`'s setup, run, and
# teardown are three independent `bash -c` invocations that never talk to each
# other, so this has to be a pure function of the checkout path rather than a
# value computed once and handed off. Same worktree -> same project/port/db
# every call; a different worktree hashes to different ones, no coordination
# needed. Safe to source more than once (idempotent, no side effects besides
# the exports).
set -euo pipefail

root="$(git rev-parse --show-toplevel)"
hash="$(printf '%s' "$root" | sha256sum | cut -c1-10)"

export PREFLIGHT_SUFFIX="$hash"
export PREFLIGHT_PROJECT="pitchbox-preflight-$hash"
# vitest.config.ts's testDatabaseUrl() and tests/global-setup.ts only accept a
# DATABASE_URL naming `pitchbox_test` or `pitchbox_test_<suffix>` where suffix
# is `[a-z0-9-]+` (no underscore - LOR-230) or it is silently ignored and both
# fall back to the shared dev database. Hyphen, not underscore, before the
# hash, so this passes that filter instead of quietly missing it.
export PREFLIGHT_DB="pitchbox_test_preflight-$hash"
# A 200-slot range keeps two real checkouts' ports apart with a plain path
# hash. A genuine collision (two checkouts landing on the same slot, or a
# stray process already holding it) is not silently absorbed: `docker compose
# up --wait` refuses an already-bound host port and fails loudly, which is
# what preflight then reports as the check's failure.
export PREFLIGHT_PORT=$((5490 + 16#${hash:0:4} % 200))
export DATABASE_URL="postgres://pitchbox:pitchbox@127.0.0.1:${PREFLIGHT_PORT}/${PREFLIGHT_DB}"
