#!/usr/bin/env bash
# Resume delegates tailnet enrollment to the shared runtime and probes the origin after it.
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
RESUME="$root/.agents/resume"
if grep -q 'tailscale' "$RESUME"; then
  echo "FAIL resume still mentions tailscale" >&2
  exit 1
fi
if ! grep -q 'YAKJEV_REMOTE_URL' "$RESUME"; then
  echo "FAIL resume does not probe the deployed origin" >&2
  exit 1
fi
echo "ok resume-has-no-tailscale"
