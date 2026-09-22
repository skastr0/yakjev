#!/usr/bin/env bash
# Synthetic checks for the public Railway entrypoint. No private network ingress.
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
ENTRY="$root/deploy/entrypoint.sh"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
pass=0
fail=0

ok() { printf 'ok %s\n' "$1"; pass=$((pass + 1)); }
bad() { printf 'FAIL %s: %s\n' "$1" "$2" >&2; fail=$((fail + 1)); }

run_reject() {
  name="$1"
  expect="$2"
  shift 2
  out="$tmp/$name.out"
  if env -i PATH="$PATH" HOME="$HOME" "$@" bash "$ENTRY" >"$out" 2>&1; then
    bad "$name" "expected failure, got exit 0: $(cat "$out")"
    return
  fi
  if grep -q "$expect" "$out"; then
    ok "$name"
  else
    bad "$name" "missing [$expect] in $(cat "$out")"
  fi
}

run_reject missing-domain "RAILWAY_PUBLIC_DOMAIN is required" \
  NODE_ENV=production
run_reject dirty-domain "bare hostname" \
  NODE_ENV=production RAILWAY_PUBLIC_DOMAIN='yakjev.up.railway.app/extra'
run_reject tcp-proxy "remove the Railway TCP proxy" \
  NODE_ENV=production \
  RAILWAY_PUBLIC_DOMAIN=yakjev.up.railway.app \
  RAILWAY_TCP_PROXY_DOMAIN=yakjev.proxy.rlwy.net

work="$tmp/ready"
mkdir -p "$work/bin" "$work/data"
cat >"$work/bin/bun" <<'EOF'
#!/bin/sh
exit 0
EOF
cat >"$work/bin/curl" <<'EOF'
#!/bin/sh
exit 0
EOF
chmod +x "$work/bin/bun" "$work/bin/curl"
cat >"$work/bin/app" <<'EOF'
#!/bin/sh
sleep 30
EOF
chmod +x "$work/bin/app"

out="$work/out"
set +e
env -i PATH="$work/bin:$PATH" HOME="$HOME" \
  NODE_ENV=production \
  RAILWAY_PUBLIC_DOMAIN=yakjev.up.railway.app \
  PORT=8080 \
  YAKJEV_DATA_DIR="$work/data" \
  YAKJEV_APP_COMMAND="$work/bin/app" \
  bash "$ENTRY" >"$out" 2>&1 &
pid=$!
set -e
ready=0
for _ in 1 2 3 4 5 6 7 8 9 10; do
  if grep -q "ready origin=https://yakjev.up.railway.app" "$out" 2>/dev/null; then
    ready=1
    break
  fi
  sleep 0.2
done
kill "$pid" 2>/dev/null || true
wait "$pid" 2>/dev/null || true
if [ "$ready" -eq 1 ] && grep -q "0.0.0.0:8080" "$out"; then
  ok "public-ready"
else
  bad "public-ready" "$(cat "$out")"
fi

printf '%s passed, %s failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
