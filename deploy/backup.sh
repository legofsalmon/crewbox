#!/usr/bin/env bash
# Back up everything a replacement box needs in order to become this box.
# Install as a nightly cron/systemd-timer AND run manually before teardown.
#
# In practice: the database, the uploaded files, the TLS certificate and the
# Android APK. Leaving the certificate out is the trap — a spare restored
# without it comes up on plain http and quietly loses the browser microphone
# and the installable app, at the exact moment someone is under pressure.
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

# Where the backups land. The rack box has a USB stick at /media/usb; a
# laptop box has no such path, and `mkdir -p /media/usb/...` on a Mac fails
# with a permission error that says nothing at all about backups. So fall
# back to the home directory — and say what that means further down, because
# a copy on the same disk as the box is not a backup, it is a second file.
if [ -z "${BACKUP_DIR:-}" ]; then
  if [ -d /media/usb ]; then
    BACKUP_DIR=/media/usb/crewbox-backups
  else
    BACKUP_DIR="$HOME/crewbox-backups"
  fi
fi

KEEP="${BACKUP_KEEP:-14}"
STAMP="$(date +%Y%m%d-%H%M%S)"
DEST="$BACKUP_DIR/$STAMP"

[ -f "$DATA_DIR/crewbox.db" ] || {
  echo "no crewbox.db in $DATA_DIR — set DATA_DIR to the box's data directory" >&2
  exit 1
}

# Written to one side and moved into place at the very end.
#
# restore.sh takes the newest directory by default, and a run that was
# interrupted — the stick pulled, the box shut down, the disk filled — used to
# leave the newest directory holding half a database. That is the one backup
# nobody would question at 3am, and the one that cannot be restored. A
# half-written backup is now called `<stamp>.partial` and is never the newest
# anything; it is swept on the next run.
WORK="$DEST.partial"
rm -rf "$WORK"
mkdir -p "$WORK"
# Interrupted, failed, or killed: take the partial with us rather than
# leaving it to accumulate. The finished backup has already been moved into
# place by then, so this only ever removes work that did not complete.
trap 'rm -rf "$WORK"' EXIT

# A consistent snapshot of a *running* box, and a single file on the other
# side — no .wal or .shm to forget. Two ways to get one, because a backup
# script that needs software installed first is no use on the night it
# matters: sqlite3 if the machine has it, otherwise Node, which every box
# running from source already has. `.backup` and `VACUUM INTO` are both
# WAL-safe; a plain cp of a live database is not.
if command -v sqlite3 >/dev/null 2>&1; then
  sqlite3 "$DATA_DIR/crewbox.db" ".backup '$WORK/crewbox.db'"
elif command -v node >/dev/null 2>&1; then
  node --experimental-sqlite --no-warnings \
    "$(dirname "$0")/snapshot-db.mjs" "$DATA_DIR/crewbox.db" "$WORK/crewbox.db"
else
  echo "need either sqlite3 or node to snapshot the database safely." >&2
  echo "  Debian/Ubuntu: sudo apt install sqlite3      macOS: already present" >&2
  exit 1
fi
# cp rather than rsync: every backup lands in a fresh timestamped directory,
# so there is nothing to sync against, and rsync is not on every minimal box.
[ -d "$DATA_DIR/files" ] && cp -R "$DATA_DIR/files" "$WORK/files"

# The certificate, when this box serves HTTPS. chain.pem is optional.
for f in cert.pem key.pem chain.pem; do
  [ -f "$DATA_DIR/$f" ] && cp -p "$DATA_DIR/$f" "$WORK/$f"
done

# The Android app. The runbook tells you to drop the APK into the data
# directory, the box serves it at /crewbox.apk, and the printed poster's QR
# points at that URL — so a spare restored without it answers the poster on
# the wall with a 404, on the morning a crew has just switched boxes. It is
# not rebuildable on site: there is no internet and no Android SDK.
shopt -s nullglob
apks=("$DATA_DIR"/crewbox*.apk)
# Guarded rather than looped bare: `"${empty[@]}"` under `set -u` is an
# unbound variable on the bash 3.2 that ships with macOS.
if [ "${#apks[@]}" -gt 0 ]; then
  for apk in "${apks[@]}"; do cp -p "$apk" "$WORK/"; done
fi
shopt -u nullglob

# So a stack of dated directories on a USB stick can be told apart at 3am.
{
  echo "taken:    $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "host:     $(hostname)"
  echo "data_dir: $DATA_DIR"
  echo "tls:      $([ -f "$WORK/cert.pem" ] && echo included || echo 'NOT PRESENT — restore comes up on http')"
  echo "apk:      $([ "${#apks[@]}" -gt 0 ] && echo "${#apks[@]} file(s)" || echo 'NOT PRESENT — the poster QR 404s after a restore')"
  echo "uploads:  $(find "$WORK/files" -type f 2>/dev/null | wc -l | tr -d ' ')"
} >"$WORK/MANIFEST.txt"

# The manifest is written last and the move is the last thing of all, so the
# existence of `$DEST` is itself the receipt: restore.sh trusts a directory
# only once both are true.
mv "$WORK" "$DEST"
trap - EXIT

# Keep the last $KEEP finished backups, and clear out any half-written one an
# earlier run left behind — nothing is ever going to finish those.
#
# Sorted by name rather than by mtime: the directories are stamped
# YYYYmmdd-HHMMSS, so lexical order is chronological and the shell has
# already sorted the glob. `ls -t` piped into `xargs -r` needed GNU xargs and
# broke on any path with a space in it, and the laptop box is a Mac.
shopt -s nullglob
stamped=("$BACKUP_DIR"/[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]-[0-9][0-9][0-9][0-9][0-9][0-9])
if [ "${#stamped[@]}" -gt "$KEEP" ]; then
  for old in "${stamped[@]:0:${#stamped[@]}-KEEP}"; do rm -rf "$old"; done
fi
for stale in "$BACKUP_DIR"/*.partial; do rm -rf "$stale"; done
shopt -u nullglob

# Tell the box it was backed up, so the admin panel can say when. It cannot
# work this out for itself: backups land on a USB stick that is usually not
# plugged in, and a regime that quietly stopped three events ago looks
# identical from the production desk to one that ran last night. Written last,
# so the marker only ever claims a backup that actually finished. Failing to
# write it must not fail the backup — the data is already safely on the stick.
printf '{"at":%s,"dest":"%s"}\n' "$(date +%s)000" "$DEST" \
  >"$DATA_DIR/last-backup.json" 2>/dev/null ||
  echo "note: could not record the backup time in $DATA_DIR (backup itself is fine)" >&2

echo "Backup written to $DEST"
cat "$DEST/MANIFEST.txt"

# Said after the receipt rather than instead of it: the backup did happen, it
# is just sitting on the disk that is about to fail. df -P is the portable
# spelling; if it cannot answer, say nothing rather than guess.
here="$(df -P "$DEST" 2>/dev/null | awk 'NR==2 {print $1}')"
there="$(df -P "$DATA_DIR" 2>/dev/null | awk 'NR==2 {print $1}')"
if [ -n "$here" ] && [ "$here" = "$there" ]; then
  echo ""
  echo "NOTE: that is the same filesystem the box's data is on, so it does not"
  echo "      survive the box. Set BACKUP_DIR to a USB stick before teardown."
fi
