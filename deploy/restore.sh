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
BACKUP_DIR="${BACKUP_DIR:-/media/usb/crewbox-backups}"

SRC="${1:-}"
if [ -z "$SRC" ]; then
  SRC="$(ls -1dt "$BACKUP_DIR"/*/ 2>/dev/null | head -1 || true)"
  [ -n "$SRC" ] || {
    echo "no backups found in $BACKUP_DIR — pass one explicitly" >&2
    exit 1
  }
fi
SRC="${SRC%/}"

[ -f "$SRC/crewbox.db" ] || {
  echo "$SRC has no crewbox.db — is that a backup directory?" >&2
  exit 1
}

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
  echo "  sudo systemctl stop crewbox     (or quit Crewbox from the Dock)" >&2
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
echo ""
echo "Next: start the box, give it the old box's address, and check"
echo "      Admin → This box. Crew phones reconnect by themselves."
