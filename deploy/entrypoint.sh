#!/usr/bin/env bash
# Supervise userspace tailscaled + yakjev in one container.
# Fail closed: missing auth on fresh Tailscale state, origin mismatch, or child death.
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
TS_STATE_DIR="${TS_STATE_DIR:-/data/tailscale}"
TS_SOCKET="${TS_SOCKET:-/var/run/tailscale/tailscaled.sock}"
TS_HOSTNAME="${TS_HOSTNAME:-yakjev}"
TS_ADVERTISE_TAGS="${TS_ADVERTISE_TAGS:-}"
TS_AUTHKEY="${TS_AUTHKEY:-}"
YAKJEV_APP_DIR="${YAKJEV_APP_DIR:-/app}"
YAKJEV_LISTEN_HOST="${YAKJEV_LISTEN_HOST:-127.0.0.1}"
YAKJEV_LISTEN_PORT="${YAKJEV_LISTEN_PORT:-3210}"
YAKJEV_ORIGIN="${YAKJEV_ORIGIN:-}"
TAILSCALED_BIN="${TAILSCALED_BIN:-tailscaled}"
TAILSCALE_BIN="${TAILSCALE_BIN:-tailscale}"
BUN_BIN="${BUN_BIN:-bun}"
STARTUP_TIMEOUT_SECS="${STARTUP_TIMEOUT_SECS:-90}"

ts_pid=""
app_pid=""
auth_file=""
cleaning=0

ts() {
  "$TAILSCALE_BIN" --socket="$TS_SOCKET" "$@"
}

json_field() {
  field="$1"
  JSON_FIELD="$field" "$BUN_BIN" -e '
    const field = process.env.JSON_FIELD;
    const s = JSON.parse(await Bun.stdin.text());
    let cur = s;
    for (const p of field.split(".")) {
      if (cur == null) { process.stdout.write(""); process.exit(0); }
      cur = cur[p];
    }
    if (cur == null) process.stdout.write("");
    else if (typeof cur === "string" || typeof cur === "number" || typeof cur === "boolean") {
      process.stdout.write(String(cur));
    } else {
      process.stdout.write(JSON.stringify(cur));
    }
  '
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
  stop_pid "$ts_pid"
  [ -z "$auth_file" ] || rm -f "$auth_file"
  app_pid=""
  ts_pid=""
}

trap cleanup EXIT
trap 'exit 0' INT TERM

alive() {
  pid="${1:-}"
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null
}

require_origin() {
  [ -n "$YAKJEV_ORIGIN" ] || die "YAKJEV_ORIGIN is required (https://<hostname>.<tailnet>.ts.net)"
  case "$YAKJEV_ORIGIN" in
    https://*) ;;
    *) die "YAKJEV_ORIGIN must be https://<hostname>.<tailnet>.ts.net (got: $YAKJEV_ORIGIN)" ;;
  esac
  hostpart="${YAKJEV_ORIGIN#https://}"
  case "$hostpart" in
    *"/"*|*"?"*|*"#"*|*"@"*|*:*)
      die "YAKJEV_ORIGIN must be a bare https origin with no userinfo, port, path, query, or fragment"
      ;;
  esac
  # bash 3.2: require at least hostname.tailnet.ts.net (no trailing slash).
  origin_re='^https://[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+\.ts\.net$'
  if ! [[ "$YAKJEV_ORIGIN" =~ $origin_re ]]; then
    die "YAKJEV_ORIGIN must match https://<hostname>.<tailnet>.ts.net with no trailing slash"
  fi
  hostpart="${YAKJEV_ORIGIN#https://}"
  rest="${hostpart%.ts.net}"
  case "$rest" in
    *.*) ;;
    *) die "YAKJEV_ORIGIN must include a tailnet label (https://<hostname>.<tailnet>.ts.net)" ;;
  esac
}

fresh_state() {
  if [ -s "$TS_STATE_DIR/tailscaled.state" ]; then
    return 1
  fi
  return 0
}

wait_for_tailscaled() {
  deadline=$((SECONDS + STARTUP_TIMEOUT_SECS))
  while [ "$SECONDS" -lt "$deadline" ]; do
    alive "$ts_pid" || die "tailscaled exited during startup"
    if [ -S "$TS_SOCKET" ]; then
      return 0
    fi
    sleep 0.25
  done
  die "timed out waiting for tailscaled socket $TS_SOCKET"
}

wait_for_running() {
  deadline=$((SECONDS + STARTUP_TIMEOUT_SECS))
  while [ "$SECONDS" -lt "$deadline" ]; do
    alive "$ts_pid" || die "tailscaled exited before becoming Running"
    if status_json="$(ts status --json 2>/dev/null)"; then
      state="$(printf '%s' "$status_json" | json_field BackendState || true)"
      case "$state" in
        Running)
          printf '%s' "$status_json"
          return 0
          ;;
        NeedsLogin)
          die "tailscaled is NeedsLogin; TS_AUTHKEY is required to register this node"
          ;;
        NeedsMachineAuth)
          die "tailscaled is NeedsMachineAuth; use a pre-approved tagged auth key"
          ;;
      esac
    fi
    sleep 0.5
  done
  die "timed out waiting for Tailscale BackendState=Running"
}

wait_for_app_health() {
  url="http://${YAKJEV_LISTEN_HOST}:${YAKJEV_LISTEN_PORT}/healthz"
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

assert_origin_matches_node() {
  status_json="$1"
  dnsname="$(printf '%s' "$status_json" | json_field Self.DNSName || true)"
  dnsname="${dnsname%.}"
  expected="${YAKJEV_ORIGIN#https://}"
  [ -n "$dnsname" ] || die "tailscale status did not include Self.DNSName"
  if [ "$dnsname" != "$expected" ]; then
    die "YAKJEV_ORIGIN host ${expected} does not match this node's MagicDNS name ${dnsname}"
  fi
}

assert_funnel_off() {
  serve_json="$(ts serve status --json)" || die "cannot verify Serve configuration"
  funnel="$(printf '%s' "$serve_json" | json_field AllowFunnel)" || die "invalid Serve configuration"
  case "$funnel" in
    *true*)
      die "Tailscale Funnel is enabled; yakjev refuses to start with public Funnel exposure"
      ;;
  esac
}

start_app() {
  if [ -n "${YAKJEV_APP_COMMAND:-}" ]; then
    # shellcheck disable=SC2086
    (cd "$YAKJEV_APP_DIR" && exec env -u TS_AUTHKEY sh -c "$YAKJEV_APP_COMMAND") &
    app_pid=$!
    return 0
  fi
  (cd "$YAKJEV_APP_DIR" && exec env -u TS_AUTHKEY "$BUN_BIN" packages/server/src/main.ts) &
  app_pid=$!
}

require_origin

[ "$YAKJEV_LISTEN_HOST" = "127.0.0.1" ] || die "YAKJEV_LISTEN_HOST must be 127.0.0.1 (got $YAKJEV_LISTEN_HOST)"
if [ "$YAKJEV_LISTEN_PORT" != "3210" ] && [ -z "${YAKJEV_ALLOW_NONDEFAULT_PORT:-}" ]; then
  die "YAKJEV_LISTEN_PORT must be 3210"
fi
if [ -n "${RAILWAY_PUBLIC_DOMAIN:-}" ] || [ -n "${RAILWAY_TCP_PROXY_DOMAIN:-}" ]; then
  die "public Railway networking is configured; remove the public domain and TCP proxy (Tailscale Serve only)"
fi

command -v "$TAILSCALED_BIN" >/dev/null 2>&1 || die "tailscaled not found"
command -v "$TAILSCALE_BIN" >/dev/null 2>&1 || die "tailscale not found"
command -v "$BUN_BIN" >/dev/null 2>&1 || die "bun not found"

if fresh_state; then
  [ -n "$TS_AUTHKEY" ] || die "fresh Tailscale state at $TS_STATE_DIR requires TS_AUTHKEY"
  log "fresh Tailscale state; will authenticate with TS_AUTHKEY"
else
  log "reusing Tailscale state in $TS_STATE_DIR"
fi

mkdir -p "$YAKJEV_DATA_DIR" "$TS_STATE_DIR" "$(dirname "$TS_SOCKET")"
chmod 0700 "$YAKJEV_DATA_DIR" "$TS_STATE_DIR" "$(dirname "$TS_SOCKET")"

export YAKJEV_DATA_DIR YAKJEV_ORIGIN YAKJEV_LISTEN_HOST YAKJEV_LISTEN_PORT
export NODE_ENV="${NODE_ENV:-production}"

log "starting tailscaled (userspace, statedir=$TS_STATE_DIR)"
"$TAILSCALED_BIN" \
  --tun=userspace-networking \
  --statedir="$TS_STATE_DIR" \
  --state="$TS_STATE_DIR/tailscaled.state" \
  --socket="$TS_SOCKET" &
ts_pid=$!
alive "$ts_pid" || die "tailscaled failed to start"

wait_for_tailscaled

up_args=(--reset --accept-dns=false --accept-routes=false --ssh=false --hostname="$TS_HOSTNAME" --timeout="${STARTUP_TIMEOUT_SECS}s")
if [ -n "$TS_ADVERTISE_TAGS" ]; then
  up_args+=(--advertise-tags="$TS_ADVERTISE_TAGS")
fi

backend_state=""
if status_json="$(ts status --json 2>/dev/null)"; then
  backend_state="$(printf '%s' "$status_json" | json_field BackendState || true)"
fi
if [ "$backend_state" != "Running" ] && [ -n "$TS_AUTHKEY" ]; then
  auth_file="$(mktemp "$(dirname "$TS_SOCKET")/auth.XXXXXX")"
  printf '%s' "$TS_AUTHKEY" > "$auth_file"
  up_args+=(--auth-key="file:$auth_file")
fi

log "bringing Tailscale up (hostname=$TS_HOSTNAME)"
ts up "${up_args[@]}"
[ -z "$auth_file" ] || rm -f "$auth_file"
auth_file=""
unset TS_AUTHKEY

status_json="$(wait_for_running)"
assert_origin_matches_node "$status_json"

# Reset requires an authenticated netmap. Keep the application stopped until
# old Serve/Funnel forwarding has been cleared and checked successfully.
ts serve reset || die "cannot clear persisted Serve/Funnel configuration"
assert_funnel_off

log "starting yakjev (loopback ${YAKJEV_LISTEN_HOST}:${YAKJEV_LISTEN_PORT})"
start_app
alive "$app_pid" || die "yakjev app failed to start"
wait_for_app_health

log "configuring Tailscale Serve HTTPS -> http://${YAKJEV_LISTEN_HOST}:${YAKJEV_LISTEN_PORT}"
ts serve --bg --yes --https=443 "http://${YAKJEV_LISTEN_HOST}:${YAKJEV_LISTEN_PORT}"
assert_funnel_off

log "ready origin=$YAKJEV_ORIGIN"

while true; do
  if ! alive "$ts_pid"; then
    log "tailscaled died; shutting down"
    exit 1
  fi
  if ! alive "$app_pid"; then
    log "yakjev app died; shutting down"
    exit 1
  fi
  sleep 1
done
