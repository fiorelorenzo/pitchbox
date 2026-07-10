#!/usr/bin/env bash
# Blue-green deploy with auto-rollback for one pitchbox environment.
# Usage: deploy.sh <prod|preview> [ref]
set -euo pipefail

ENV="${1:?usage: deploy.sh <prod|preview> [ref]}"
REF="${2:-manual}"

case "$ENV" in
  prod)
    DIR=/opt/apps/pitchbox; PROJECT=pitchbox; DOMAIN=pitchbox.app
    BLUE_PORT=5180; GREEN_PORT=5181
    UPSTREAM=/etc/caddy/upstreams/prod.conf; EXTRA=()
    ;;
  preview)
    DIR=/opt/apps/pitchbox-preview; PROJECT=pitchbox-preview; DOMAIN=preview.pitchbox.app
    BLUE_PORT=5190; GREEN_PORT=5191
    UPSTREAM=/etc/caddy/upstreams/preview.conf; EXTRA=(-f docker-compose.preview.yml)
    ;;
  *) echo "unknown env: $ENV" >&2; exit 2 ;;
esac

cd "$DIR"
export BLUE_PORT GREEN_PORT
COMPOSE=(docker compose -p "$PROJECT"
  -f docker-compose.yml -f docker-compose.app.yml -f docker-compose.app.prod.yml
  -f docker-compose.app.runner.yml -f docker-compose.bluegreen.yml "${EXTRA[@]}")
log(){ echo "[deploy $ENV $REF] $*"; }

# 0. ensure shared services are up (postgres + runner); builds runner if its image is missing
log "ensuring postgres + runner up..."
"${COMPOSE[@]}" up -d postgres runner

# 1. active/idle from the caddy upstream file
active_port="$(grep -oE '127\.0\.0\.1:[0-9]+' "$UPSTREAM" 2>/dev/null | head -1 | cut -d: -f2 || true)"
if [ "$active_port" = "$GREEN_PORT" ]; then
  active=green; idle=blue; idle_port=$BLUE_PORT
else
  active=blue; idle=green; idle_port=$GREEN_PORT   # default / first run
fi
log "active=$active(:${active_port:-none}) -> deploying idle=$idle(:$idle_port)"

# 2. build the new image
log "building..."; "${COMPOSE[@]}" build "web-$idle"

# 3. start the idle color (image already built -> --no-build to skip slow re-export)
log "starting web-$idle..."; "${COMPOSE[@]}" up -d --no-deps --no-build --force-recreate "web-$idle"

# 4. health-check the idle color directly
cid="$("${COMPOSE[@]}" ps -q "web-$idle")"
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

# 5. migrate + seed against the new color
log "migrating..."
"${COMPOSE[@]}" exec -T "web-$idle" pnpm -F @pitchbox/shared migrate
"${COMPOSE[@]}" exec -T "web-$idle" pnpm -F @pitchbox/shared seed:core

# 6. flip caddy to idle (graceful reload = zero downtime)
log "switching Caddy -> :$idle_port"
printf 'reverse_proxy 127.0.0.1:%s\n' "$idle_port" | sudo tee "$UPSTREAM" >/dev/null
sudo systemctl reload caddy

# 7. smoke check the public URL
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

# 8. cut over daemon (singleton) to the new color; recreate runner
log "cutting over daemon + runner..."
ACTIVE_WEB="web-$idle" "${COMPOSE[@]}" up -d --no-deps --no-build --force-recreate daemon
"${COMPOSE[@]}" up -d --no-deps --no-build runner

# 9. retire the old color
log "stopping old web-$active..."; "${COMPOSE[@]}" stop "web-$active" || true
log "DONE: $ENV now on web-$idle (:$idle_port) ref=$REF"
