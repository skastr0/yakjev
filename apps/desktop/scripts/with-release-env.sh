#!/usr/bin/env bash
# Load the maintainer's private release settings, as the iOS release does, then
# run the command. The file holds shell assignments (team, signing identity,
# server URL) and is never committed. Without it, public builds run unchanged.
set -euo pipefail
root="$(cd "$(dirname "$0")/../../.." && pwd)"
file="${YAKJEV_RELEASE_ENV_FILE:-$root/.local/desktop-release.env}"
if [[ -f "$file" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$file"
  set +a
elif [[ -n "${YAKJEV_RELEASE_ENV_FILE:-}" ]]; then
  printf 'Release environment file does not exist: %s\n' "$file" >&2
  exit 1
fi
exec "$@"
