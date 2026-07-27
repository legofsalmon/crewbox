#!/usr/bin/env bash
# Back up everything a replacement box needs in order to become this box.
# Install as a nightly cron/systemd-timer AND run manually before teardown.
#
# In practice: the database, the uploaded files, and the TLS certificate.
# Leaving the certificate out is the trap — a spare restored without it comes
# up on plain http and quietly loses the browser microphone and the
# installable app, at the exact moment someone is under pressure.
#
# Not backed up, because the box rebuilds them on first boot: web-dist/ and
# livekit/. The SFU's credentials live in the settings table, so they travel
# inside the database and voice keeps working across the swap.
set -euo pipefail

# The systemd rig and the one-file box keep data in different places. Prefer
# an explicit DATA_DIR, then the service path, then the box default.
if [ -z "${DATA_DIR:-}" ]; then
  if [ -d /var/lib/crewbox ]; then
    DATA_DIR=/var/lib/crewbox
  else
    DATA_DIR="$HOME/.crewbox/data"
  fi
fi

BACKUP_DIR="${BACKUP_DIR:-/media/usb/crewbox-backups}"
STAMP="$(date +%Y%m%d-%H%M%S)"
DEST="$BACKUP_DIR/$STAMP"

[ -f "$DATA_DIR/crewbox.db" ] || {
  echo "no crewbox.db in $DATA_DIR — set DATA_DIR to the box's data directory" >&2
  exit 1
}
mkdir -p "$DEST"

# A consistent snapshot of a *running* box, and a single file on the other
# side — no .wal or .shm to forget. Two ways to get one, because a backup
# script that needs software installed first is no use on the night it
# matters: sqlite3 if the machine has it, otherwise Node, which every box
# running from source already has. `.backup` and `VACUUM INTO` are both
# WAL-safe; a plain cp of a live database is not.
if command -v sqlite3 >/dev/null 2>&1; then
  sqlite3 "$DATA_DIR/crewbox.db" ".backup '$DEST/crewbox.db'"
elif command -v node >/dev/null 2>&1; then
  node --experimental-sqlite --no-warnings \
    "$(dirname "$0")/snapshot-db.mjs" "$DATA_DIR/crewbox.db" "$DEST/crewbox.db"
else
  echo "need either sqlite3 or node to snapshot the database safely." >&2
  echo "  Debian/Ubuntu: sudo apt install sqlite3      macOS: already present" >&2
  rmdir "$DEST" 2>/dev/null || true
  exit 1
fi
# cp rather than rsync: every backup lands in a fresh timestamped directory,
# so there is nothing to sync against, and rsync is not on every minimal box.
[ -d "$DATA_DIR/files" ] && cp -R "$DATA_DIR/files" "$DEST/files"

# The certificate, when this box serves HTTPS. chain.pem is optional.
for f in cert.pem key.pem chain.pem; do
  [ -f "$DATA_DIR/$f" ] && cp -p "$DATA_DIR/$f" "$DEST/$f"
done

# So a stack of dated directories on a USB stick can be told apart at 3am.
{
  echo "taken:    $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "host:     $(hostname)"
  echo "data_dir: $DATA_DIR"
  echo "tls:      $([ -f "$DEST/cert.pem" ] && echo included || echo 'NOT PRESENT — restore comes up on http')"
  echo "uploads:  $(find "$DEST/files" -type f 2>/dev/null | wc -l | tr -d ' ')"
} >"$DEST/MANIFEST.txt"

# Keep the last 14 backups.
ls -1dt "$BACKUP_DIR"/*/ | tail -n +15 | xargs -r rm -rf

echo "Backup written to $DEST"
cat "$DEST/MANIFEST.txt"
