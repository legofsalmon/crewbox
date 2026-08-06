#!/usr/bin/env bash
# Renew the festival certificate on a Mac box and install it in the box's
# data directory. The laptop twin of cert-renew.sh: that one assumes a
# Linux server with certbot, Cloudflare DNS and systemd; this one assumes
# a Mac that travels, lego (brew install lego), and DNS hosted on Vercel.
#
# Safe to run any time — it does nothing until the certificate is inside
# 30 days of expiry, so schedule it weekly and forget it. On macOS use
# launchd, not cron: a laptop asleep at the scheduled minute gets the run
# when it wakes instead of silently skipping (see the plist in RUNBOOK.md).
#
# The box reads cert.pem/key.pem at startup, so a renewal takes effect at
# the box's next start — for a per-gig laptop that is simply the next gig,
# and a running event is deliberately never touched.
set -euo pipefail
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

# CHANGE these. The token lives in this file so the schedule can run
# unattended — chmod 700 this script, give the token an expiry when you
# mint it, and know that deleting it from Vercel revokes it instantly.
DOMAIN=chat.example.com
EMAIL=you@example.com
export VERCEL_API_TOKEN=paste-token-here
export VERCEL_TEAM_ID=team_paste-id-here # delete if the domain is personal, not team

# Where `lego ... run` keeps its account and certificates (its working dir).
LEGO_DIR="$HOME/certs"
DATA_DIR="${DATA_DIR:-$HOME/.crewbox/data}"

# Check expiry ourselves rather than trusting lego's threshold flags — the
# lego CLI moved between v4 and v5, and openssl doesn't move. A missing
# cert.pem fails the check and falls through to issuing one, which is right.
if openssl x509 -checkend $((30 * 24 * 3600)) -noout -in "$DATA_DIR/cert.pem" 2>/dev/null; then
  echo "Certificate still has 30+ days left; nothing to do."
  exit 0
fi

cd "$LEGO_DIR"
lego run --email "$EMAIL" --dns vercel --domains "$DOMAIN"

# The box wants exactly these two names. The .crt is the full chain.
install -m 644 ".lego/certificates/$DOMAIN.crt" "$DATA_DIR/cert.pem"
install -m 600 ".lego/certificates/$DOMAIN.key" "$DATA_DIR/key.pem"

echo "Renewed. The box picks it up at its next start. Valid until:"
openssl x509 -enddate -noout -in "$DATA_DIR/cert.pem"
