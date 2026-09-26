#!/usr/bin/env bash
# Synthetic checks for the Mac mini runner. No launchd, no Tailscale, no real secrets.
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
RUN="$root/deploy/macmini/run.sh"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
fail=0

mkdir -p "$tmp/bin"
cat >"$tmp/bin/bun" <<'BUN'
#!/bin/sh
if [ "${1:-}" = --version ]; then echo 1.4.2; exit 0; fi
printf 'NODE_ENV=%s HOST=%s PORT=%s DATA=%s ORIGIN=%s RAILPORT=%s\n' \
  "$NODE_ENV" "$YAKJEV_LISTEN_HOST" "$YAKJEV_LISTEN_PORT" "$YAKJEV_DATA_DIR" "$YAKJEV_ORIGIN" "${PORT:-}"
BUN
chmod +x "$tmp/bin/bun"

check() {
  name="$1"
  expect="$2"
  shift 2
  printf '%s\n' "$@" >"$tmp/env"
  out="$tmp/$name.out"
  env -i PATH="$tmp/bin:/usr/bin:/bin" HOME="$tmp/home" YAKJEV_ENV_FILE="$tmp/env" \
    bash "$RUN" >"$out" 2>&1 || true
  if grep -q -- "$expect" "$out"; then
    printf 'ok %s\n' "$name"
  else
    printf 'FAIL %s: missing [%s] in %s\n' "$name" "$expect" "$(cat "$out")" >&2
    fail=1
  fi
}

origin='YAKJEV_ORIGIN=https://yakjev.example.ts.net'
check missing-origin "YAKJEV_ORIGIN must be" 'YAKJEV_OWNER_TOKEN=x'
check public-origin "YAKJEV_ORIGIN must be" 'YAKJEV_ORIGIN=https://yakjev.up.railway.app'
check dev-auth "YAKJEV_DEV_AUTH must not" "$origin" 'YAKJEV_DEV_AUTH=true'
check railway "RAILWAY_\* is set" "$origin" 'RAILWAY_PUBLIC_DOMAIN=yakjev.up.railway.app'
check wildcard-host "must be 127.0.0.1" "$origin" 'YAKJEV_LISTEN_HOST=0.0.0.0'

if [ -f "$root/apps/web/dist/index.html" ]; then
  check loopback "NODE_ENV=production HOST=127.0.0.1 PORT=3210 DATA=$tmp/home/.yakjev/data ORIGIN=https://yakjev.example.ts.net RAILPORT=$" \
    "$origin" 'PORT=8080'
else
  check needs-build "run bun run build first" "$origin"
fi

BACKUP="$root/deploy/macmini/backup.sh"
if command -v sqlite3 >/dev/null 2>&1; then
  b="$tmp/backup"
  mkdir -p "$b/data" "$b/out"
  sqlite3 "$b/data/yakjev.sqlite" 'PRAGMA journal_mode=WAL; CREATE TABLE t(x); INSERT INTO t VALUES (1),(2),(3);' >/dev/null
  for old in 20200101T000000Z 20200102T000000Z 20200103T000000Z; do
    : >"$b/out/yakjev-$old.sqlite"
    touch -t "${old:0:8}0000" "$b/out/yakjev-$old.sqlite"
  done
  if env -i PATH="/usr/bin:/bin" HOME="$tmp/home" SQLITE_BIN="$(command -v sqlite3)" \
    YAKJEV_DATA_DIR="$b/data" YAKJEV_BACKUP_DIR="$b/out" YAKJEV_BACKUP_KEEP=2 \
    bash "$BACKUP" >"$b/log" 2>&1; then
    newest="$(ls -1t "$b/out"/yakjev-*.sqlite | head -1)"
    count="$(ls -1 "$b/out"/yakjev-*.sqlite | wc -l | tr -d ' ')"
    rows="$(sqlite3 "$newest" 'SELECT count(*) FROM t')"
    if [ "$count" = 2 ] && [ "$rows" = 3 ] && [ ! -e "$b/out/yakjev-20200101T000000Z.sqlite" ]; then
      printf 'ok backup-rotates\n'
    else
      printf 'FAIL backup-rotates: count=%s rows=%s\n' "$count" "$rows" >&2
      fail=1
    fi
  else
    printf 'FAIL backup-rotates: %s\n' "$(cat "$b/log")" >&2
    fail=1
  fi
else
  printf 'skip backup-rotates (no sqlite3)\n'
fi

exit "$fail"
