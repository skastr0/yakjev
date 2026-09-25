#!/usr/bin/env bash
# Mac mini process. Loopback only; Tailscale Serve terminates HTTPS on the tailnet.
# The owner token is the lock. Secrets and the tailnet origin live in an untracked env file.
set -euo pipefail
umask 077

die() {
  printf 'yakjev: error: %s\n' "$*" >&2
  exit 1
}

root="$(cd "$(dirname "$0")/../.." && pwd)"
env_file="${YAKJEV_ENV_FILE:-$HOME/.config/yakjev/env}"
[ -r "$env_file" ] || die "missing $env_file"

set -a
# shellcheck disable=SC1090
. "$env_file"
set +a

[ -z "${YAKJEV_DEV_AUTH:-}" ] || die "YAKJEV_DEV_AUTH must not be set on the mini"
if env | grep -q '^RAILWAY_'; then
  die "RAILWAY_* is set; this is the tailnet process, not the Railway image"
fi
case "${YAKJEV_ORIGIN:-}" in
  https://*.ts.net) ;;
  *) die "YAKJEV_ORIGIN must be https://<service>.<tailnet>.ts.net" ;;
esac
case "${YAKJEV_LISTEN_HOST:-127.0.0.1}" in
  127.0.0.1) ;;
  *) die "YAKJEV_LISTEN_HOST must be 127.0.0.1; Tailscale Serve is the only ingress" ;;
esac

unset PORT
export NODE_ENV=production
export YAKJEV_LISTEN_HOST=127.0.0.1
export YAKJEV_LISTEN_PORT="${YAKJEV_LISTEN_PORT:-3210}"
export YAKJEV_DATA_DIR="${YAKJEV_DATA_DIR:-$HOME/.yakjev/data}"

BUN_BIN="${BUN_BIN:-bun}"
command -v "$BUN_BIN" >/dev/null 2>&1 || die "bun not found"
[ "$("$BUN_BIN" --version)" = 1.4.2 ] || die "expected Bun 1.4.2"
[ -f "$root/apps/web/dist/index.html" ] || die "run bun run build first"

mkdir -p "$YAKJEV_DATA_DIR"
chmod 0700 "$YAKJEV_DATA_DIR"
printf 'yakjev: starting 127.0.0.1:%s origin=%s\n' "$YAKJEV_LISTEN_PORT" "$YAKJEV_ORIGIN" >&2
cd "$root"
exec "$BUN_BIN" packages/server/src/main.ts
