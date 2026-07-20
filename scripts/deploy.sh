#!/usr/bin/env bash
# Blue-green deploy with auto-rollback for one pitchbox environment.
#
# Usage:
#   deploy.sh <prod|preview> [ref]              normal deploy: builds a fresh
#                                                image, tags it immutably, cuts over
#   deploy.sh <prod|preview> [ref] --rollback    reuse an already-built image
#                                                (no rebuild); requires APP_IMAGE=
#                                                <repo>:<tag> exported to a
#                                                previously tagged image, e.g.:
#                                                  APP_IMAGE=pitchbox-app:prod-v0.9.0-20260715120000 \
#                                                    scripts/deploy.sh prod rollback-to-v0.9.0 --rollback
#
# Env knobs:
#   DEPLOY_KEEP_N   how many immutable image tags / restore points to retain per
#                    env after a successful deploy (default 5)
#   ALLOW_NO_AUTH   set to 1 to override the PITCHBOX_AUTH guard below (not
#                    recommended - see step 0b)
set -euo pipefail

ENV="${1:?usage: deploy.sh <prod|preview> [ref] [--rollback]}"
REF="${2:-manual}"
ROLLBACK=0
[ "${3:-}" = "--rollback" ] && ROLLBACK=1

case "$ENV" in
  prod)
    DIR=/opt/apps/pitchbox; PROJECT=pitchbox; DOMAIN=pitchbox.app
    BLUE_PORT=5180; GREEN_PORT=5181
    UPSTREAM=/etc/caddy/upstreams/pitchbox-prod.conf; EXTRA=()
    ;;
  preview)
    DIR=/opt/apps/pitchbox-preview; PROJECT=pitchbox-preview; DOMAIN=preview.pitchbox.app
    BLUE_PORT=5190; GREEN_PORT=5191
    UPSTREAM=/etc/caddy/upstreams/pitchbox-preview.conf; EXTRA=(-f docker-compose.preview.yml)
    ;;
  *) echo "unknown env: $ENV" >&2; exit 2 ;;
esac

cd "$DIR"
log(){ echo "[deploy $ENV $REF] $*"; }
ENV_FILE="$DIR/.env"

# 0a. PITCHBOX_AUTH guard: this script only ever deploys to a real public
#     domain (pitchbox.app / preview.pitchbox.app), or to whatever the operator
#     points PUBLIC_WEB_ORIGIN at in .env. Deploying a dashboard with no login
#     onto the public internet is the unsafe default we must not silently
#     allow, so fail closed unless PITCHBOX_AUTH=on (or explicitly overridden).
public_origin="${PUBLIC_WEB_ORIGIN:-$(grep -E '^PUBLIC_WEB_ORIGIN=' "$ENV_FILE" 2>/dev/null | tail -1 | cut -d= -f2- || true)}"
public_origin="${public_origin:-https://$DOMAIN}"
pitchbox_auth="${PITCHBOX_AUTH:-$(grep -E '^PITCHBOX_AUTH=' "$ENV_FILE" 2>/dev/null | tail -1 | cut -d= -f2- || true)}"
is_public=1
case "$public_origin" in
  *://localhost*|*://127.0.0.1*) is_public=0 ;;
esac
if [ "$is_public" = 1 ] && [ "${pitchbox_auth:-off}" != on ]; then
  if [ "${ALLOW_NO_AUTH:-0}" = 1 ]; then
    log "WARNING: PITCHBOX_AUTH is not 'on' for public ORIGIN $public_origin."
    log "WARNING: proceeding only because ALLOW_NO_AUTH=1 - the dashboard will be reachable with NO login."
  else
    log "ERROR: refusing to deploy to public ORIGIN $public_origin with PITCHBOX_AUTH!=on."
    log "ERROR: set PITCHBOX_AUTH=on in $ENV_FILE, or re-run with ALLOW_NO_AUTH=1 to override (not recommended)."
    exit 3
  fi
fi

# 0b. resolve the image repo/tag. Normal deploys mint a new immutable per-ref
#     tag (never reuse a moving tag, or a rollback would have nothing to point
#     at); --rollback reuses an already-built tag the caller supplies via
#     APP_IMAGE and skips the build step entirely.
if [ "$ROLLBACK" = 1 ]; then
  : "${APP_IMAGE:?--rollback requires APP_IMAGE=<repo>:<tag> set to a previously built image}"
  IMAGE_REPO="${APP_IMAGE%%:*}"
  log "ROLLBACK MODE: reusing existing image $APP_IMAGE (no build)"
else
  base_image="${APP_IMAGE:-$(grep -E '^APP_IMAGE=' "$ENV_FILE" 2>/dev/null | tail -1 | cut -d= -f2- || true)}"
  base_image="${base_image:-pitchbox-app:latest}"
  IMAGE_REPO="${base_image%%:*}"
  safe_ref="$(printf '%s' "$REF" | tr -c 'A-Za-z0-9._-' '-')"
  IMG_TAG="${ENV}-${safe_ref}-$(date -u +%Y%m%d%H%M%S)"
  APP_IMAGE="${IMAGE_REPO}:${IMG_TAG}"
  log "building immutable tag $APP_IMAGE"
fi
export APP_IMAGE BLUE_PORT GREEN_PORT
COMPOSE=(docker compose -p "$PROJECT"
  -f docker-compose.yml -f docker-compose.app.yml -f docker-compose.app.prod.yml
  -f docker-compose.app.runner.yml -f docker-compose.bluegreen.yml "${EXTRA[@]}")

DEPLOY_KEEP_N="${DEPLOY_KEEP_N:-5}"

prune_images() {
  local keep="$DEPLOY_KEEP_N" tag created pairs=()
  log "pruning ${IMAGE_REPO}:${ENV}-* images beyond the last $keep..."
  for tag in $(docker images "$IMAGE_REPO" --format '{{.Tag}}' 2>/dev/null | grep -E "^${ENV}-.+-[0-9]{14}$" || true); do
    created="$(docker inspect -f '{{.Created}}' "${IMAGE_REPO}:${tag}" 2>/dev/null || true)"
    [ -n "$created" ] && pairs+=("${created}"$'\t'"${tag}")
  done
  [ "${#pairs[@]}" -eq 0 ] && return 0
  # never prune the tag we just (re)deployed - matters for --rollback, where
  # the active tag's build time can be older than the kept window
  printf '%s\n' "${pairs[@]}" | sort -r | tail -n "+$((keep + 1))" | cut -f2 | while IFS= read -r old_tag; do
    [ -n "$old_tag" ] || continue
    [ "${IMAGE_REPO}:${old_tag}" = "$APP_IMAGE" ] && continue
    log "removing old image ${IMAGE_REPO}:${old_tag}"
    docker rmi "${IMAGE_REPO}:${old_tag}" >/dev/null 2>&1 || true
  done
}

BACKUP_ROOT="$DIR/backups"

prune_backups() {
  local keep="$DEPLOY_KEEP_N" dirs=() d i=0
  log "pruning restore points beyond the last $keep..."
  while IFS= read -r d; do dirs+=("$d"); done < <(find "$BACKUP_ROOT" -mindepth 1 -maxdepth 1 -type d -name '[0-9]*' 2>/dev/null | sort -r)
  for d in "${dirs[@]}"; do
    i=$((i + 1))
    [ "$i" -gt "$keep" ] && { log "removing old restore point $d"; rm -rf "$d"; }
  done
}

# 1. ensure shared services are up (postgres + runner); builds runner if its image is missing
log "ensuring postgres + runner up..."
"${COMPOSE[@]}" up -d postgres runner

# 2. active/idle from the caddy upstream file
active_port="$(grep -oE '127\.0\.0\.1:[0-9]+' "$UPSTREAM" 2>/dev/null | head -1 | cut -d: -f2 || true)"
if [ "$active_port" = "$GREEN_PORT" ]; then
  active=green; idle=blue; idle_port=$BLUE_PORT
else
  active=blue; idle=green; idle_port=$GREEN_PORT   # default / first run
fi
log "active=$active(:${active_port:-none}) -> deploying idle=$idle(:$idle_port)"

# 3. build the new images (skipped in --rollback: APP_IMAGE already points at a
#    previously built, still-local image). Build the RUNNER too: it is a separate
#    image (built from ./cloud/runner, not bundled into the web image) and it
#    carries the runner side of every cloud change. It MUST be rebuilt in lockstep
#    with the web, or a new web/adapter (protocol v2, per-frame seq) would talk to
#    a stale runner (protocol v1, no seq) and every cloud run would fail the
#    version handshake. It is recreated at cutover (step 11).
if [ "$ROLLBACK" = 1 ]; then
  log "skipping build (rollback mode)"
else
  log "building web + runner..."; "${COMPOSE[@]}" build "web-$idle" runner
fi

# 4. start the idle color (image already built -> --no-build to skip slow re-export)
log "starting web-$idle..."; "${COMPOSE[@]}" up -d --no-deps --no-build --force-recreate "web-$idle"
cid="$("${COMPOSE[@]}" ps -q "web-$idle")"

# 5. pre-migrate restore point: pg_dump the DB + snapshot ENCRYPTION_KEY BEFORE
#    migrating, so a bad migration can always be restored from. A failed dump
#    aborts the deploy outright - we never migrate without a fresh backup.
backup_dir="$BACKUP_ROOT/$(date -u +%Y%m%d%H%M%S)"
log "taking pre-migrate restore point in $backup_dir..."
mkdir -p "$backup_dir"
chmod 700 "$backup_dir"
if ! "${COMPOSE[@]}" exec -T postgres pg_dump -U pitchbox -d pitchbox | gzip > "$backup_dir/db.sql.gz" \
  || [ ! -s "$backup_dir/db.sql.gz" ]; then
  log "ERROR: pre-migrate pg_dump failed or produced an empty dump; aborting before migrate"
  log "ERROR: web-$active is untouched and still serving (no downtime); web-$idle left stopped"
  rm -rf "$backup_dir"
  "${COMPOSE[@]}" stop "web-$idle" || true; exit 1
fi
chmod 600 "$backup_dir/db.sql.gz"
if grep -q '^ENCRYPTION_KEY=' "$ENV_FILE" 2>/dev/null; then
  grep '^ENCRYPTION_KEY=' "$ENV_FILE" > "$backup_dir/encryption_key.env"
  chmod 600 "$backup_dir/encryption_key.env"
else
  log "ERROR: ENCRYPTION_KEY not found in $ENV_FILE; aborting before migrate (backup without the key is useless)"
  rm -rf "$backup_dir"
  "${COMPOSE[@]}" stop "web-$idle" || true; exit 1
fi
log "restore point saved: $backup_dir"

# 6. migrate + seed BEFORE the health check: the healthcheck fetches / which queries
#    the DB, so a fresh (unmigrated) DB would 500 and never go healthy. exec only
#    needs the container running, not healthy.
for _ in $(seq 1 20); do
  rs="$(docker inspect -f '{{.State.Status}}' "$cid" 2>/dev/null || echo none)"
  [ "$rs" = running ] && break; sleep 2
done
log "migrating..."
"${COMPOSE[@]}" exec -T "web-$idle" pnpm -F @pitchbox/shared migrate
"${COMPOSE[@]}" exec -T "web-$idle" pnpm -F @pitchbox/shared seed:core
"${COMPOSE[@]}" exec -T "web-$idle" bin/pitchbox seed:owner

# 7. health-check the idle color (now that the DB is migrated)
ok=0
for _ in $(seq 1 40); do
  h="$(docker inspect -f '{{.State.Health.Status}}' "$cid" 2>/dev/null || echo starting)"
  [ "$h" = healthy ] && { ok=1; break; }; sleep 3
done
if [ "$ok" != 1 ]; then
  log "ERROR: web-$idle never healthy; aborting, web-$active still serving (no downtime)"
  "${COMPOSE[@]}" stop "web-$idle" || true; exit 1
fi
log "web-$idle healthy"

# 8. flip caddy to idle (graceful reload = zero downtime)
log "switching Caddy -> :$idle_port"
printf 'reverse_proxy 127.0.0.1:%s\n' "$idle_port" | sudo tee "$UPSTREAM" >/dev/null
sudo systemctl reload caddy

# 9. smoke check the public URL
log "smoke-checking https://$DOMAIN/login"
smoke=0; code=000
for _ in $(seq 1 10); do
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "https://$DOMAIN/login" || echo 000)"
  [ "$code" = 200 ] && { smoke=1; break; }; sleep 3
done
if [ "$smoke" != 1 ]; then
  log "ERROR: smoke failed (HTTP $code); ROLLING BACK to web-$active(:$active_port)"
  if [ -n "${active_port:-}" ]; then
    printf 'reverse_proxy 127.0.0.1:%s\n' "$active_port" | sudo tee "$UPSTREAM" >/dev/null
    sudo systemctl reload caddy
  fi
  "${COMPOSE[@]}" stop "web-$idle" || true; exit 1
fi
log "smoke ok"

# 10. deploy confirmed good: move the env's moving alias (<env>-latest) onto this
#     image, then prune old immutable tags and old restore points. Both prunes
#     wait until here (not right after the step-5 backup) so a deploy that
#     fails partway through never loses older restore points - only a
#     confirmed-good deploy trims them. Manual rollback later is just:
#       APP_IMAGE=<repo>:<one of the tags kept below> scripts/deploy.sh <env> <ref> --rollback
log "tagging ${IMAGE_REPO}:${ENV}-latest -> $APP_IMAGE"
docker tag "$APP_IMAGE" "${IMAGE_REPO}:${ENV}-latest" || log "WARNING: failed to update the ${ENV}-latest alias"
prune_images
prune_backups

# 11. cut over daemon (singleton) to the new color; recreate runner
log "cutting over daemon + runner..."
ACTIVE_WEB="web-$idle" "${COMPOSE[@]}" up -d --no-deps --no-build --force-recreate daemon
# No --force-recreate/kill/-t0 here on purpose: `up` only recreates the runner
# if compose detects its config (e.g. image ID) actually changed, and when it
# does, it goes through the standard graceful path - SIGTERM, wait up to
# stop_grace_period, SIGKILL only if it didn't exit - which is what lets the
# runner's own CLD-P4 drain (see docs/cloud-runner.md "Drain on cutover")
# finish in-flight sessions instead of being killed mid-run. Step 3 rebuilt the
# runner image on a normal deploy, so its image ID changed and this `up` picks
# that up and recreates it here (a --rollback deploy skips the runner rebuild,
# leaving it as-is). Known gap: unlike web's blue/green colors, there is only ONE
# runner service, so this is a sequential stop-then-start, not a hot swap -
# new session.start calls fail during the (bounded) window between the old
# container stopping and the new one coming up, not just during the old one's
# drain. Documented as a deliberate divergence from Caddy-style connection
# draining in docs/cloud-runner.md.
"${COMPOSE[@]}" up -d --no-deps --no-build runner

# 12. retire the old color
log "stopping old web-$active..."; "${COMPOSE[@]}" stop "web-$active" || true
log "DONE: $ENV now on web-$idle (:$idle_port) image=$APP_IMAGE ref=$REF"
