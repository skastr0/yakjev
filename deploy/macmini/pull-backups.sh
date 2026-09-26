#!/usr/bin/env bash
# Run on another machine to keep an off-mini copy of the graph backups.
# Pulls over SSH; never writes to the mini. `--install` loads it as a daily launchd agent.
set -euo pipefail
umask 077

host="${YAKJEV_BACKUP_HOST:-mac-mini}"
dest="${YAKJEV_BACKUP_DEST:-$HOME/Backups/yakjev}"
keep="${YAKJEV_BACKUP_KEEP:-60}"
label="com.skastr0.yakjev.pull-backups"

if [ "${1:-}" = --install ]; then
  plist="$HOME/Library/LaunchAgents/$label.plist"
  mkdir -p "$(dirname "$plist")" "$dest"
  cat >"$plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$label</string>
  <key>ProgramArguments</key>
  <array>
    <string>$(cd "$(dirname "$0")" && pwd)/pull-backups.sh</string>
  </array>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>
    <integer>9</integer>
    <key>Minute</key>
    <integer>30</integer>
  </dict>
  <key>StandardOutPath</key>
  <string>$dest/pull.log</string>
  <key>StandardErrorPath</key>
  <string>$dest/pull.log</string>
</dict>
</plist>
PLIST
  plutil -lint "$plist" >/dev/null
  launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$plist"
  printf 'yakjev: loaded %s into %s\n' "$label" "$dest"
  exit 0
fi

mkdir -p "$dest"
chmod 0700 "$dest"
rsync -a --ignore-existing -e 'ssh -o BatchMode=yes -o ConnectTimeout=15' \
  "$host:.yakjev/backups/" "$dest/" --include='yakjev-*.sqlite' --exclude='*'
ls -1t "$dest"/yakjev-*.sqlite 2>/dev/null | tail -n +"$((keep + 1))" | while IFS= read -r old; do
  rm -f "$old"
done
printf '%s pulled; newest %s\n' "$(date -u +%FT%TZ)" "$(ls -1t "$dest"/yakjev-*.sqlite 2>/dev/null | head -1)"
