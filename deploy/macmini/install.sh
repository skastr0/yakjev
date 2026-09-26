#!/usr/bin/env bash
# Install or reload the yakjev launchd agents on the Mac mini: the server and its daily
# backup. Does not touch Tailscale.
set -euo pipefail

die() {
  printf 'yakjev: error: %s\n' "$*" >&2
  exit 1
}

label="${YAKJEV_LAUNCHD_LABEL:-com.skastr0.yakjev}"
root="$(cd "$(dirname "$0")/../.." && pwd)"
bun_bin="${BUN_BIN:-$(command -v bun || true)}"
[ -x "$bun_bin" ] || die "set BUN_BIN to an absolute Bun 1.4.2 path"
[ "$("$bun_bin" --version)" = 1.4.2 ] || die "expected Bun 1.4.2 at $bun_bin"
[ -r "$HOME/.config/yakjev/env" ] || die "create $HOME/.config/yakjev/env (0600) first"

logs="$HOME/.yakjev/logs"
agents="$HOME/Library/LaunchAgents"
domain="gui/$(id -u)"
mkdir -p "$logs" "$agents"
chmod 0700 "$HOME/.yakjev"

# load <label> <program> <schedule plist fragment>
load() {
  plist="$agents/$1.plist"
  log="$logs/yakjev${1#"$label"}"
  cat >"$plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$1</string>
  <key>ProgramArguments</key>
  <array>
    <string>$2</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$root</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>$HOME</string>
    <key>BUN_BIN</key>
    <string>$bun_bin</string>
    <key>PATH</key>
    <string>$(dirname "$bun_bin"):/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
$3
  <key>StandardOutPath</key>
  <string>$log.out.log</string>
  <key>StandardErrorPath</key>
  <string>$log.err.log</string>
</dict>
</plist>
PLIST
  plutil -lint "$plist" >/dev/null
  launchctl bootout "$domain/$1" 2>/dev/null || true
  launchctl bootstrap "$domain" "$plist"
  printf 'yakjev: loaded %s\n' "$1"
}

load "$label" "$root/deploy/macmini/run.sh" '  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>'

load "$label.backup" "$root/deploy/macmini/backup.sh" '  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>
    <integer>4</integer>
    <key>Minute</key>
    <integer>15</integer>
  </dict>'

printf 'yakjev: logs in %s\n' "$logs"
