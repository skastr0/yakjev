#!/usr/bin/env bash
# Resume must not enroll a tailnet. It may probe the public origin.
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
RESUME="$root/.agents/resume"
if grep -q 'tailscale' "$RESUME"; then
  echo "FAIL resume still mentions tailscale" >&2
  exit 1
fi
if ! grep -q 'YAKJEV_REMOTE_URL' "$RESUME"; then
  echo "FAIL resume does not probe the public origin" >&2
  exit 1
fi
echo "ok resume-has-no-tailscale"
