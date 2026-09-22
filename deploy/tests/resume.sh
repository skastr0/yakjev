#!/usr/bin/env bash
# Branch tests for .agents/resume. No daemon, token, or tailnet contact.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
RESUME="$ROOT/.agents/resume"
PASS=0
FAIL=0

bash -n "$RESUME"

tmpdir="$(mktemp -d "${TMPDIR:-/tmp}/yakjev-resume-test.XXXXXX")"
trap 'rm -rf "$tmpdir"' EXIT

ok() {
  PASS=$((PASS + 1))
  printf 'ok  %s\n' "$1"
}

bad() {
  FAIL=$((FAIL + 1))
  printf 'FAIL  %s\n' "$1"
  if [[ -n "${2:-}" ]]; then
    printf '%s\n' "$2" | sed 's/^/    /'
  fi
}

run_resume() {
  local name="$1"
  shift
  local out="$tmpdir/$name.out"
  local code=0
  # Default connect command fails closed. A regression that takes the auth
  # branch must not reach amp or sudo.
  env \
    AMP_ORB=1 \
    TAILSCALE_CLIENT_ID=test-client \
    TAILSCALE_AUDIENCE=test-audience \
    YAKJEV_RESUME_STATUS_TIMEOUT=1 \
    YAKJEV_RESUME_POLL_WAIT=0 \
    YAKJEV_RESUME_ONLINE_WAIT=0 \
    YAKJEV_RESUME_CONNECT_CMD='echo UNEXPECTED_CONNECT; exit 97' \
    QUASAR_SERVER_URL= \
    YAKJEV_REMOTE_URL= \
    RAILWAY_API_TOKEN= \
    RAILWAY_TOKEN= \
    "$@" \
    bash "$RESUME" >"$out" 2>&1 || code=$?
  printf '%s' "$code"
}

status_json() {
  local online="$1"
  local state="${2:-Running}"
  local health="${3:-}"
  bun -e '
    const [online, state, health] = process.argv.slice(1);
    process.stdout.write(JSON.stringify({
      BackendState: state,
      Health: health ? [health] : ["Tailscale cannot connect because the network is down."],
      Self: { Online: online === "true", DNSName: "orb.example.ts.net." },
    }));
  ' "$online" "$state" "$health"
}

# Warm current poll: Running and Online skips reauth even with the E2B warning.
code="$(run_resume warm YAKJEV_RESUME_STATUS_CMD="printf '%s' '$(status_json true)'")"
out="$(cat "$tmpdir/warm.out")"
if [[ "$code" == 0 ]] && grep -q 'skipping reauthentication' <<<"$out" && ! grep -q 'UNEXPECTED_CONNECT' <<<"$out"; then
  ok warm-current-poll
else
  bad warm-current-poll "$out"
fi

# Running but not in the current poll is stale and must exchange a token.
# The status command flips to Online only after connect, matching a real poll.
stale_status="$tmpdir/stale-status.sh"
cat >"$stale_status" <<EOF
#!/usr/bin/env bash
if [[ -f "$tmpdir/connected" ]]; then
  printf '%s' '$(status_json true)'
else
  printf '%s' '$(status_json false Running 'PollNetMap: initial fetch failed 404: node not found')'
fi
EOF
chmod +x "$stale_status"
code="$(run_resume stale \
  YAKJEV_RESUME_STATUS_CMD="$stale_status" \
  YAKJEV_RESUME_CONNECT_CMD="touch '$tmpdir/connected'; echo CONNECT")"
out="$(cat "$tmpdir/stale.out")"
if [[ "$code" == 0 ]] && grep -q 'CONNECT' <<<"$out" && grep -q 'forcing a fresh OIDC exchange' <<<"$out"; then
  ok running-offline-stale
else
  bad running-offline-stale "$out"
fi

# A failed exchange must not be reported as a live registration.
code="$(run_resume authfail \
  YAKJEV_RESUME_STATUS_CMD="printf '%s' '$(status_json false NeedsLogin)'" \
  YAKJEV_RESUME_CONNECT_CMD='echo CONNECT >&2; exit 1')"
out="$(cat "$tmpdir/authfail.out")"
if [[ "$code" != 0 ]] && grep -q 'OIDC exchange failed' <<<"$out"; then
  ok initial-auth-failure
else
  bad initial-auth-failure "$out"
fi

# The first probe must fail and the second must still run. An early return
# after the first failure would also pass if Quasar were the passing probe.
mkdir -p "$tmpdir/bin"
cat >"$tmpdir/bin/curl" <<'EOF'
#!/usr/bin/env bash
url="${*: -1}"
if [[ "$url" == *yakjev* ]]; then
  exit 0
fi
echo "fail $url" >&2
exit 6
EOF
chmod +x "$tmpdir/bin/curl"
code="$(
  code=0
  PATH="$tmpdir/bin:$PATH" \
    AMP_ORB=1 \
    TAILSCALE_CLIENT_ID=test-client \
    TAILSCALE_AUDIENCE=test-audience \
    YAKJEV_RESUME_STATUS_TIMEOUT=1 \
    YAKJEV_RESUME_POLL_WAIT=0 \
    YAKJEV_RESUME_ONLINE_WAIT=0 \
    YAKJEV_RESUME_STATUS_CMD="printf '%s' '$(status_json true)'" \
    QUASAR_SERVER_URL=https://quasar.example \
    YAKJEV_REMOTE_URL=https://yakjev.example \
    RAILWAY_API_TOKEN= \
    RAILWAY_TOKEN= \
    bash "$RESUME" >"$tmpdir/probes.out" 2>&1 || code=$?
  printf '%s' "$code"
)"
out="$(cat "$tmpdir/probes.out")"
if [[ "$code" != 0 ]] && grep -q 'probe failed (/health)' <<<"$out" && grep -q 'probe passed (/healthz)' <<<"$out" && grep -q 'not diagnosing grant' <<<"$out"; then
  ok one-endpoint-failed
else
  bad one-endpoint-failed "$out"
fi

printf '%s passed, %s failed\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]]
