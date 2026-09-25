#!/usr/bin/env bash
# Install or reload the yakjev launchd agent on the Mac mini. Does not touch Tailscale.
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
plist="$HOME/Library/LaunchAgents/$label.plist"
mkdir -p "$logs" "$(dirname "$plist")"
chmod 0700 "$HOME/.yakjev"

cat >"$plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$label</string>
  <key>ProgramArguments</key>
  <array>
    <string>$root/deploy/macmini/run.sh</string>
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
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  <string>$logs/yakjev.out.log</string>
  <key>StandardErrorPath</key>
  <string>$logs/yakjev.err.log</string>
</dict>
</plist>
PLIST
plutil -lint "$plist" >/dev/null

domain="gui/$(id -u)"
launchctl bootout "$domain/$label" 2>/dev/null || true
launchctl bootstrap "$domain" "$plist"
printf 'yakjev: loaded %s; logs in %s\n' "$label" "$logs"
