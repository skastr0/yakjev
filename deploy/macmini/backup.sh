#!/usr/bin/env bash
# Consistent SQLite backup of the Mac mini graph. VACUUM INTO is safe beside the live writer.
set -euo pipefail
umask 077

die() {
  printf 'yakjev-backup: error: %s\n' "$*" >&2
  exit 1
}

data_dir="${YAKJEV_DATA_DIR:-$HOME/.yakjev/data}"
backup_dir="${YAKJEV_BACKUP_DIR:-$HOME/.yakjev/backups}"
keep="${YAKJEV_BACKUP_KEEP:-14}"
sqlite="${SQLITE_BIN:-/usr/bin/sqlite3}"
db="$data_dir/yakjev.sqlite"

[ -r "$db" ] || die "missing $db"
case "$keep" in '' | *[!0-9]* | 0) die "YAKJEV_BACKUP_KEEP must be a positive integer" ;; esac
mkdir -p "$backup_dir"
chmod 0700 "$backup_dir"

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
out="$backup_dir/yakjev-$stamp.sqlite"
tmp="$out.partial"
rm -f "$tmp"
"$sqlite" "$db" "VACUUM INTO '$tmp'"
check="$("$sqlite" "$tmp" 'PRAGMA integrity_check')"
[ "$check" = ok ] || {
  rm -f "$tmp"
  die "integrity_check failed: $check"
}
mv "$tmp" "$out"

# Newest first; drop everything past the newest $keep.
ls -1t "$backup_dir"/yakjev-*.sqlite | tail -n +"$((keep + 1))" | while IFS= read -r old; do
  rm -f "$old"
done
printf 'yakjev-backup: wrote %s (%s bytes)\n' "$out" "$(wc -c <"$out" | tr -d ' ')"
