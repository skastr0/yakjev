#!/usr/bin/env bash
# Synthetic subprocess tests for deploy/entrypoint.sh (no Docker required).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
ENTRY="$ROOT/deploy/entrypoint.sh"
PASS=0
FAIL=0

if ! command -v bun >/dev/null 2>&1; then
  echo "bun is required for json_field in the entrypoint" >&2
  exit 1
fi
if ! command -v python3 >/dev/null 2>&1; then
  echo "python3 is required for stub sockets and the health server" >&2
  exit 1
fi
if ! command -v curl >/dev/null 2>&1; then
  echo "curl is required for the entrypoint health wait" >&2
  exit 1
fi

bash -n "$ENTRY"

tmpdir="$(mktemp -d "${TMPDIR:-/tmp}/yakjev-deploy-test.XXXXXX")"
trap 'rm -rf "$tmpdir"' EXIT

ok() {
  PASS=$((PASS + 1))
  printf 'ok  %s\n' "$1"
}

bad() {
  FAIL=$((FAIL + 1))
  printf 'FAIL  %s\n' "$1"
  if [ -n "${2:-}" ]; then
    printf '%s\n' "$2" | sed 's/^/    /'
  fi
}

run_reject() {
  name="$1"
  expect="$2"
  shift 2
  out="$tmpdir/out.$name"
  set +e
  "$@" >"$out" 2>&1
  code=$?
  set -e
  if [ "$code" -eq 0 ]; then
    bad "$name" "expected nonzero exit; output: $(cat "$out")"
    return 0
  fi
  if ! grep -q "$expect" "$out"; then
    bad "$name" "expected '$expect' in output: $(cat "$out")"
    return 0
  fi
  ok "$name"
}

run_reject missing-origin "YAKJEV_ORIGIN is required" \
  env -i PATH="$PATH" HOME="$HOME" bash "$ENTRY"

# The image defaults NODE_ENV=production. The app, not the entrypoint, rejects
# the synthetic dev token in that mode. This does not start Tailscale.
run_reject production-rejects-dev-auth "YAKJEV_DEV_AUTH requires a non-production loopback origin" \
  env -i PATH="$PATH" HOME="$HOME" \
    NODE_ENV=production \
    YAKJEV_DEV_AUTH=true \
    YAKJEV_ORIGIN=https://yakjev.example.ts.net \
    YAKJEV_DATA_DIR="$tmpdir/dev-auth-data" \
    bun packages/server/src/main.ts

run_reject http-origin "must be https://" \
  env -i PATH="$PATH" HOME="$HOME" YAKJEV_ORIGIN="http://yakjev.example.ts.net" bash "$ENTRY"

run_reject trailing-slash "bare https origin" \
  env -i PATH="$PATH" HOME="$HOME" YAKJEV_ORIGIN="https://yakjev.example.ts.net/" bash "$ENTRY"

run_reject missing-tailnet-label "must match https://" \
  env -i PATH="$PATH" HOME="$HOME" YAKJEV_ORIGIN="https://yakjev.ts.net" bash "$ENTRY"

run_reject public-domain "public Railway networking" \
  env -i PATH="$PATH" HOME="$HOME" \
    YAKJEV_ORIGIN="https://yakjev.example.ts.net" \
    RAILWAY_PUBLIC_DOMAIN="yakjev.up.railway.app" \
    bash "$ENTRY"

run_reject tcp-proxy "public Railway networking" \
  env -i PATH="$PATH" HOME="$HOME" \
    YAKJEV_ORIGIN="https://yakjev.example.ts.net" \
    RAILWAY_TCP_PROXY_DOMAIN="xxx.proxy.rlwy.net" \
    bash "$ENTRY"

fresh="$tmpdir/fresh"
mkdir -p "$fresh/data/yakjev" "$fresh/data/tailscale" "$fresh/bin"
printf '#!/bin/sh\nexit 0\n' >"$fresh/bin/tailscaled"
printf '#!/bin/sh\nexit 0\n' >"$fresh/bin/tailscale"
chmod +x "$fresh/bin/tailscaled" "$fresh/bin/tailscale"
run_reject fresh-no-authkey "requires TS_AUTHKEY" \
  env -i PATH="$fresh/bin:/usr/bin:/bin" HOME="$HOME" \
    YAKJEV_ORIGIN="https://yakjev.example.ts.net" \
    YAKJEV_DATA_DIR="$fresh/data/yakjev" \
    TS_STATE_DIR="$fresh/data/tailscale" \
    TS_SOCKET="$fresh/tailscaled.sock" \
    TAILSCALED_BIN="$fresh/bin/tailscaled" \
    TAILSCALE_BIN="$fresh/bin/tailscale" \
    BUN_BIN="$(command -v bun)" \
    bash "$ENTRY"

# --- stubs for supervision -------------------------------------------------

stubdir="$tmpdir/stubs"
mkdir -p "$stubdir/bin" "$stubdir/log"
record="$stubdir/log/tailscale.cmds"

cat >"$stubdir/bin/tailscaled" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
socket=""
statedir=""
state=""
while [ $# -gt 0 ]; do
  case "$1" in
    --tun=userspace-networking) ;;
    --socket=*) socket="${1#*=}" ;;
    --statedir=*) statedir="${1#*=}" ;;
    --state=*) state="${1#*=}" ;;
    *) echo "unexpected tailscaled arg: $1" >&2; exit 1 ;;
  esac
  shift
done
[ -n "$socket" ] || exit 1
mkdir -p "$(dirname "$socket")"
if [ -n "$statedir" ]; then mkdir -p "$statedir"; fi
if [ -n "$state" ]; then mkdir -p "$(dirname "$state")"; printf 'stub-state\n' >"$state"; fi
exec python3 - "$socket" <<'PY'
import os, socket, sys, time
path = sys.argv[1]
if os.path.exists(path):
    os.unlink(path)
s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
s.bind(path)
s.listen(8)
s.settimeout(1.0)
while True:
    try:
        conn, _ = s.accept()
        conn.close()
    except socket.timeout:
        pass
    if os.path.exists(path + ".die"):
        sys.exit(1)
PY
EOF
chmod +x "$stubdir/bin/tailscaled"

cat >"$stubdir/bin/tailscale" <<EOF
#!/usr/bin/env bash
set -euo pipefail
record="$record"
socket=""
args=()
while [ \$# -gt 0 ]; do
  case "\$1" in
    --socket=*) socket="\${1#*=}" ;;
    *) args+=("\$1") ;;
  esac
  shift
done
printf '%s\n' "\${args[*]}" >>"\$record"
cmd="\${args[0]:-}"
if [ "\$cmd" = "up" ]; then
  touch "\$socket.authenticated"
  exit 0
fi
if [ "\$cmd" = "status" ]; then
  cat <<'JSON'
{"BackendState":"Running","Self":{"DNSName":"yakjev.example.ts.net."}}
JSON
  exit 0
fi
if [ "\$cmd" = "serve" ]; then
  # Serve reset requires a netmap: catch accidental reset-before-login ordering.
  [ -f "\$socket.authenticated" ] || { echo 'not authenticated' >&2; exit 1; }
  if [ "\${args[1]:-}" = "reset" ]; then touch "\$socket.reset"; fi
  if [ "\${args[1]:-}" = "status" ]; then
    echo '{"TCP":{"443":{"HTTPS":true}},"AllowFunnel":{}}'
    exit 0
  fi
  exit 0
fi
echo "unknown tailscale command: \${args[*]}" >&2
exit 1
EOF
chmod +x "$stubdir/bin/tailscale"

health_py="$stubdir/health.py"
cat >"$health_py" <<'PY'
import os, sys
from http.server import BaseHTTPRequestHandler, HTTPServer

assert os.path.exists(os.environ["TS_SOCKET"] + ".reset"), "app started before Serve reset"
assert "TS_AUTHKEY" not in os.environ, "app inherited server enrollment key"
host = os.environ.get("YAKJEV_LISTEN_HOST", "127.0.0.1")
port = int(os.environ.get("YAKJEV_LISTEN_PORT", "3210"))
die_after = os.environ.get("STUB_APP_DIE_AFTER", "")

class H(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path.split("?", 1)[0] == "/healthz":
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b"ok")
        else:
            self.send_response(404)
            self.end_headers()
    def log_message(self, *_args):
        return

httpd = HTTPServer((host, port), H)
if die_after:
    import threading, time
    def boom():
        time.sleep(float(die_after))
        os._exit(1)
    threading.Thread(target=boom, daemon=True).start()
httpd.serve_forever()
PY

free_port() {
  python3 - <<'PY'
import socket
s = socket.socket()
s.bind(("127.0.0.1", 0))
print(s.getsockname()[1])
s.close()
PY
}

start_entrypoint() {
  work="$1"
  port="$2"
  mkdir -p "$work/data/yakjev" "$work/data/tailscale"
  : >"$record"
  # Persistent-looking state so missing-auth is not the failure mode unless we want it.
  printf 'existing\n' >"$work/data/tailscale/tailscaled.state"
  set +e
  env -i PATH="$stubdir/bin:/usr/bin:/bin:/usr/sbin:/sbin" HOME="$HOME" \
    YAKJEV_ORIGIN="https://yakjev.example.ts.net" \
    YAKJEV_DATA_DIR="$work/data/yakjev" \
    TS_STATE_DIR="$work/data/tailscale" \
    TS_SOCKET="$work/tailscaled.sock" \
    TS_HOSTNAME="yakjev" \
    TS_AUTHKEY="tskey-auth-test" \
    TAILSCALED_BIN="$stubdir/bin/tailscaled" \
    TAILSCALE_BIN="$stubdir/bin/tailscale" \
    BUN_BIN="$(command -v bun)" \
    YAKJEV_LISTEN_HOST="127.0.0.1" \
    YAKJEV_LISTEN_PORT="$port" \
    YAKJEV_ALLOW_NONDEFAULT_PORT=1 \
    YAKJEV_APP_DIR="$stubdir" \
    YAKJEV_APP_COMMAND="python3 $health_py" \
    STARTUP_TIMEOUT_SECS=20 \
    STUB_APP_DIE_AFTER="${STUB_APP_DIE_AFTER:-}" \
    bash "$ENTRY" >"$work/out" 2>&1 &
  ep_pid=$!
  set -e
}

wait_ready() {
  work="$1"
  deadline=$((SECONDS + 25))
  while [ "$SECONDS" -lt "$deadline" ]; do
    if grep -q "ready origin=" "$work/out" 2>/dev/null; then
      return 0
    fi
    if ! kill -0 "$ep_pid" 2>/dev/null; then
      return 1
    fi
    sleep 0.2
  done
  return 1
}

# Happy path + SIGTERM
work="$tmpdir/run-term"
port="$(free_port)"
start_entrypoint "$work" "$port"
if wait_ready "$work"; then
  if grep -q "serve --bg --yes --https=443 http://127.0.0.1:${port}" "$record" \
    || grep -q "serve --bg --yes --https=443 http://127.0.0.1:$port" "$record"; then
    ok "serve-https-loopback"
  else
    bad "serve-https-loopback" "cmds: $(cat "$record")"
  fi
  kill -TERM "$ep_pid" 2>/dev/null || true
  set +e
  wait "$ep_pid"
  code=$?
  set -e
  if [ "$code" -eq 0 ]; then
    ok "sigterm-exit-0"
  else
    bad "sigterm-exit-0" "exit $code output: $(cat "$work/out")"
  fi
else
  bad "happy-path-ready" "output: $(cat "$work/out")"
  kill -TERM "$ep_pid" 2>/dev/null || true
  wait "$ep_pid" 2>/dev/null || true
fi

# tailscaled death => fail closed
work="$tmpdir/run-tsdie"
port="$(free_port)"
start_entrypoint "$work" "$port"
if wait_ready "$work"; then
  touch "$work/tailscaled.sock.die"
  set +e
  wait "$ep_pid"
  code=$?
  set -e
  if [ "$code" -ne 0 ] && grep -q "tailscaled died" "$work/out"; then
    ok "tailscaled-death-fail-closed"
  else
    bad "tailscaled-death-fail-closed" "exit $code output: $(cat "$work/out")"
  fi
else
  bad "tailscaled-death-fail-closed" "never ready: $(cat "$work/out")"
  kill -TERM "$ep_pid" 2>/dev/null || true
  wait "$ep_pid" 2>/dev/null || true
fi

# app death => fail closed
work="$tmpdir/run-appdie"
port="$(free_port)"
STUB_APP_DIE_AFTER=2 start_entrypoint "$work" "$port"
if wait_ready "$work"; then
  set +e
  wait "$ep_pid"
  code=$?
  set -e
  if [ "$code" -ne 0 ] && grep -q "yakjev app died" "$work/out"; then
    ok "app-death-fail-closed"
  else
    bad "app-death-fail-closed" "exit $code output: $(cat "$work/out")"
  fi
else
  bad "app-death-fail-closed" "never ready: $(cat "$work/out")"
  kill -TERM "$ep_pid" 2>/dev/null || true
  wait "$ep_pid" 2>/dev/null || true
fi

# Funnel refused
funnel_ts="$stubdir/bin/tailscale.funnel"
cp "$stubdir/bin/tailscale" "$funnel_ts"
cat >"$stubdir/bin/tailscale" <<EOF
#!/usr/bin/env bash
set -euo pipefail
record="$record"
args=()
while [ \$# -gt 0 ]; do
  case "\$1" in
    --socket=*) ;;
    *) args+=("\$1") ;;
  esac
  shift
done
printf '%s\n' "\${args[*]}" >>"\$record"
cmd="\${args[0]:-}"
if [ "\$cmd" = "up" ]; then exit 0; fi
if [ "\$cmd" = "status" ]; then
  cat <<'JSON'
{"BackendState":"Running","Self":{"DNSName":"yakjev.example.ts.net."}}
JSON
  exit 0
fi
if [ "\$cmd" = "serve" ]; then
  if [ "\${args[1]:-}" = "status" ]; then
    echo '{"AllowFunnel":{"yakjev.example.ts.net:443":true}}'
    exit 0
  fi
  exit 0
fi
exit 1
EOF
chmod +x "$stubdir/bin/tailscale"

work="$tmpdir/run-funnel"
port="$(free_port)"
start_entrypoint "$work" "$port"
set +e
wait "$ep_pid"
code=$?
set -e
if [ "$code" -ne 0 ] && grep -q "Funnel is enabled" "$work/out"; then
  ok "funnel-refused"
else
  bad "funnel-refused" "exit $code output: $(cat "$work/out")"
fi

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
