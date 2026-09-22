#!/usr/bin/env bash
# Public Railway process. The owner token is the lock. Private network ingress is not in this path.
set -euo pipefail
umask 077

log() {
  printf 'yakjev: %s\n' "$*" >&2
}

die() {
  log "error: $*"
  exit 1
}

YAKJEV_DATA_DIR="${YAKJEV_DATA_DIR:-/data/yakjev}"
YAKJEV_APP_DIR="${YAKJEV_APP_DIR:-/app}"
YAKJEV_LISTEN_HOST="${YAKJEV_LISTEN_HOST:-0.0.0.0}"
YAKJEV_LISTEN_PORT="${PORT:-${YAKJEV_LISTEN_PORT:-3210}}"
BUN_BIN="${BUN_BIN:-bun}"
STARTUP_TIMEOUT_SECS="${STARTUP_TIMEOUT_SECS:-90}"

app_pid=""
cleaning=0

die_public_proxy() {
  if [ -n "${RAILWAY_TCP_PROXY_DOMAIN:-}" ]; then
    die "remove the Railway TCP proxy; yakjev is HTTPS on the service domain only"
  fi
}

origin_from_domain() {
  domain="${RAILWAY_PUBLIC_DOMAIN:-}"
  [ -n "$domain" ] || die "RAILWAY_PUBLIC_DOMAIN is required in production"
  case "$domain" in
    *":"*|*"/"*|*"?"*|*"#"*|*"@"*)
      die "RAILWAY_PUBLIC_DOMAIN must be a bare hostname"
      ;;
  esac
  printf 'https://%s' "$domain"
}

stop_pid() {
  pid="${1:-}"
  [ -n "$pid" ] || return 0
  kill "$pid" 2>/dev/null || return 0
  n=0
  while [ "$n" -lt 20 ]; do
    kill -0 "$pid" 2>/dev/null || return 0
    sleep 0.25
    n=$((n + 1))
  done
  kill -9 "$pid" 2>/dev/null || true
}

cleanup() {
  if [ "$cleaning" -eq 1 ]; then
    return 0
  fi
  cleaning=1
  stop_pid "$app_pid"
  app_pid=""
}

trap cleanup EXIT
trap 'exit 0' INT TERM

alive() {
  pid="${1:-}"
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null
}

wait_for_app_health() {
  url="http://127.0.0.1:${YAKJEV_LISTEN_PORT}/healthz"
  command -v curl >/dev/null 2>&1 || die "curl is required to wait for $url"
  deadline=$((SECONDS + STARTUP_TIMEOUT_SECS))
  while [ "$SECONDS" -lt "$deadline" ]; do
    alive "$app_pid" || die "yakjev app exited before /healthz became ready"
    if curl -fsS --max-time 1 "$url" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.5
  done
  die "timed out waiting for $url"
}

start_app() {
  if [ -n "${YAKJEV_APP_COMMAND:-}" ]; then
    # shellcheck disable=SC2086
    sh -c "$YAKJEV_APP_COMMAND" &
    app_pid=$!
    return 0
  fi
  (cd "$YAKJEV_APP_DIR" && exec "$BUN_BIN" packages/server/src/main.ts) &
  app_pid=$!
}

die_public_proxy
if [ -z "${YAKJEV_ORIGIN:-}" ]; then
  YAKJEV_ORIGIN="$(origin_from_domain)"
fi
export YAKJEV_ORIGIN
export YAKJEV_DATA_DIR YAKJEV_LISTEN_HOST YAKJEV_LISTEN_PORT
export NODE_ENV="${NODE_ENV:-production}"

command -v "$BUN_BIN" >/dev/null 2>&1 || die "bun not found"
mkdir -p "$YAKJEV_DATA_DIR"
chmod 0700 "$YAKJEV_DATA_DIR"

log "starting yakjev (${YAKJEV_LISTEN_HOST}:${YAKJEV_LISTEN_PORT} origin=$YAKJEV_ORIGIN)"
start_app
alive "$app_pid" || die "yakjev app failed to start"
wait_for_app_health
log "ready origin=$YAKJEV_ORIGIN"

while true; do
  if ! alive "$app_pid"; then
    log "yakjev app died; shutting down"
    exit 1
  fi
  sleep 1
done
