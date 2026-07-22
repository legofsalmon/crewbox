#!/usr/bin/env bash
# Back up the Inter database and uploaded files to a USB stick.
# Install as a nightly cron/systemd-timer AND run manually before teardown.
set -euo pipefail

DATA_DIR="${DATA_DIR:-/var/lib/inter}"
BACKUP_DIR="${BACKUP_DIR:-/media/usb/inter-backups}"
STAMP="$(date +%Y%m%d-%H%M%S)"
DEST="$BACKUP_DIR/$STAMP"

mkdir -p "$DEST"

# Consistent SQLite snapshot even while the server is running (WAL-safe).
sqlite3 "$DATA_DIR/inter.db" ".backup '$DEST/inter.db'"
rsync -a "$DATA_DIR/files/" "$DEST/files/"

# Keep the last 14 backups.
ls -1dt "$BACKUP_DIR"/*/ | tail -n +15 | xargs -r rm -rf

echo "Backup written to $DEST"
