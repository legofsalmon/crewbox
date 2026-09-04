#!/usr/bin/env bash
# Turn a spare machine into the box that died.
#
# Usage: deploy/restore.sh [backup-dir]      (defaults to the newest backup)
#
# The runbook used to say "restore newest USB backup into /var/lib/crewbox",
# which is a sentence rather than a procedure. This is the procedure, because
# the moment you need it is the worst possible moment to be improvising with
# cp and a head torch.
#
# Crew phones reconnect on their own once the new box has the old box's
# address. Patch sheets and lighting plots are unaffected either way — every
# device holds its own copy and they re-sync — but chat history, uploads,
# accounts and the event PIN all live in the database, and the certificate is
# what keeps browsers giving out the microphone.
set -euo pipefail

if [ -z "${DATA_DIR:-}" ]; then
  if [ -d /var/lib/crewbox ]; then
    DATA_DIR=/var/lib/crewbox
  else
    DATA_DIR="$HOME/.crewbox/data"
  fi
fi
# Matches backup.sh, which falls back to the home directory on a machine with
# no /media/usb — a laptop box, and a rack box whose stick is not plugged in.
if [ -z "${BACKUP_DIR:-}" ]; then
  if [ -d /media/usb ]; then
    BACKUP_DIR=/media/usb/crewbox-backups
  else
    BACKUP_DIR="$HOME/crewbox-backups"
  fi
fi

HERE="$(cd "$(dirname "$0")" && pwd)"

# Is this directory a backup that finished?
#
# backup.sh writes to `<stamp>.partial` and moves it into place only after
# the manifest is written, so a directory that has both a database and a
# manifest is one that completed. Older backups, taken before that change,
# were written in place — hence the second test rather than trusting the name
# alone. A directory holding half a database is the one nobody would question
# at 3am and the one that cannot be restored.
finished() {
  [ -f "$1/crewbox.db" ] && [ -f "$1/MANIFEST.txt" ]
}

# And does the database in it actually read?
#
# A stick pulled mid-write leaves a file SQLite opens perfectly happily: it
# only notices the missing pages when something reads them, which on a box is
# ten minutes into the show. Checked here, while there is still a choice.
sound() {
  if command -v sqlite3 >/dev/null 2>&1; then
    [ "$(sqlite3 "$1/crewbox.db" 'PRAGMA integrity_check' 2>/dev/null | head -1)" = ok ]
  elif command -v node >/dev/null 2>&1; then
    node --experimental-sqlite --no-warnings "$HERE/check-db.mjs" "$1/crewbox.db" >/dev/null 2>&1
  else
    # Nothing to check with. Say so rather than quietly calling it sound.
    echo "  (no sqlite3 and no node — cannot check the database, going on anyway)" >&2
    true
  fi
}

SRC="${1:-}"
if [ -z "$SRC" ]; then
  # Newest first. The directories are stamped YYYYmmdd-HHMMSS, so the shell's
  # own lexical sort is chronological — no `ls -t`, whose flags and quoting
  # differ on macOS, and no surprises from a path with a space in it.
  shopt -s nullglob
  stamped=("$BACKUP_DIR"/[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]-[0-9][0-9][0-9][0-9][0-9][0-9])
  shopt -u nullglob
  for ((i = ${#stamped[@]} - 1; i >= 0; i--)); do
    candidate="${stamped[$i]}"
    if ! finished "$candidate"; then
      echo "skipping $(basename "$candidate"): unfinished (no manifest or no database)" >&2
      continue
    fi
    if ! sound "$candidate"; then
      echo "skipping $(basename "$candidate"): its database does not read" >&2
      continue
    fi
    SRC="$candidate"
    break
  done
  [ -n "$SRC" ] || {
    echo "no usable backup in $BACKUP_DIR — pass one explicitly" >&2
    exit 1
  }
  CHECKED=yes
fi
SRC="${SRC%/}"

[ -f "$SRC/crewbox.db" ] || {
  echo "$SRC has no crewbox.db — is that a backup directory?" >&2
  exit 1
}
# An explicitly named directory is checked too, and refused rather than
# half-restored. This is the only guard between a truncated file and a box
# that starts, serves, and then falls over during the show.
if [ "${CHECKED:-no}" != yes ]; then
  if [ ! -f "$SRC/MANIFEST.txt" ]; then
    echo "$SRC has no MANIFEST.txt, so it is a backup that did not finish." >&2
    echo "  Pick another, or — if you are certain this one is complete —" >&2
    echo "  touch $SRC/MANIFEST.txt and run this again." >&2
    exit 1
  fi
  sound "$SRC" || {
    echo "$SRC has a database that does not read. Restoring it would give you a box" >&2
    echo "  that starts and then fails during the show. Pick an older backup." >&2
    exit 1
  }
fi

# Restoring underneath a running server corrupts the database it is holding
# open. Checking the port is cruder than asking systemd, but it is true on
# every way of running the box, including a double-clicked one.
#
# Both schemes, because a box with a certificate serves only TLS — probing
# http alone would find nothing and cheerfully move the data directory out
# from under a live, well-configured rig, which is the worst case rather than
# an edge one. -k because the certificate may be self-signed: this is looking
# for a listener, not trusting it.
PORT="${CREWBOX_PORT:-8787}"
box_answering() {
  curl -fsS --max-time 2 "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1 && return 0
  curl -fsSk --max-time 2 "https://127.0.0.1:$PORT/api/health" >/dev/null 2>&1
}
if box_answering; then
  echo "a box is already answering on port $PORT — stop it first:" >&2
  # Not "quit it from the Dock": the box is a Node single-file executable
  # that never links AppKit, so a double-clicked one has no Dock icon and no
  # window. `--stop` is the answer on every platform, and the menu-bar item
  # is the answer on the Mac.
  echo "  sudo systemctl stop crewbox" >&2
  echo "  crewbox --stop                  (any platform, including a .app)" >&2
  echo "  or Crewbox in the menu bar → Stop Crewbox and quit" >&2
  exit 1
fi

echo "Restoring $SRC"
[ -f "$SRC/MANIFEST.txt" ] && sed 's/^/  /' "$SRC/MANIFEST.txt"

# Never destroy what is already there. If this is the wrong backup — easy to
# do when several sit on one stick — the previous state is one move away.
if [ -e "$DATA_DIR/crewbox.db" ]; then
  ASIDE="$DATA_DIR.superseded-$(date +%Y%m%d-%H%M%S)"
  echo "  moving the existing data directory aside → $ASIDE"
  mv "$DATA_DIR" "$ASIDE"
fi

mkdir -p "$DATA_DIR"
cp "$SRC/crewbox.db" "$DATA_DIR/crewbox.db"
[ -d "$SRC/files" ] && cp -R "$SRC/files" "$DATA_DIR/files"

# The Android app, which is what gives crew lock-screen alerts with no
# internet — and what the printed poster's QR points at. Not rebuildable on
# site: no internet, no Android SDK.
shopt -s nullglob
apks=("$SRC"/crewbox*.apk)
apk=no
if [ "${#apks[@]}" -gt 0 ]; then
  for file in "${apks[@]}"; do cp -p "$file" "$DATA_DIR/"; done
  apk=yes
fi
shopt -u nullglob

tls=no
for f in cert.pem key.pem chain.pem; do
  if [ -f "$SRC/$f" ]; then
    cp -p "$SRC/$f" "$DATA_DIR/$f"
    [ "$f" = cert.pem ] && tls=yes
  fi
done
# The service user has to be able to read its own key, and an unreadable key
# is the commonest reason a box silently falls back to plain http.
chmod 600 "$DATA_DIR/key.pem" 2>/dev/null || true
if id crewbox >/dev/null 2>&1; then
  chown -R crewbox:crewbox "$DATA_DIR" 2>/dev/null ||
    sudo chown -R crewbox:crewbox "$DATA_DIR" 2>/dev/null || true
fi

echo ""
echo "Restored into $DATA_DIR"
[ "$tls" = yes ] || echo "  NOTE: no certificate in that backup — this box will serve plain http,"
[ "$tls" = yes ] || echo "        so browsers get no microphone and no install prompt."
[ "$apk" = yes ] || echo "  NOTE: no Android app in that backup — /crewbox.apk will 404, and so will"
[ "$apk" = yes ] || echo "        the APK QR on the printed poster. Copy one in from the release."
echo ""
echo "Next: start the box, give it the old box's address, and check"
echo "      Admin → This box. Crew phones reconnect by themselves."
