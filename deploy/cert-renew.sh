#!/usr/bin/env bash
# Fetch/renew the certificate for the festival domain and install it in the
# box's data directory.
#
# Run this on the server box WITH internet, at least a week before the
# event (Let's Encrypt certs last 90 days — put the renewal date in your
# calendar). On site the cert validates offline; no internet is needed.
#
# Uses the DNS-01 challenge, which works without exposing the box to the
# internet — which matters here, because the name resolves to a private
# address on the event LAN (see dnsmasq.conf) and HTTP-01 could never reach
# it.
#
# The box serves TLS itself, so there is no reverse proxy to reload: it
# reads cert.pem and key.pem from DATA_DIR at startup, and a restart is what
# picks up a renewal.
set -euo pipefail

# CHANGE these three. DOMAIN is the name for the box on site, which is NOT
# the name of the download site — that one points at Vercel, this one at a
# private LAN address.
DOMAIN="chat.example.com"
EMAIL="you@example.com"
DATA_DIR="${DATA_DIR:-/var/lib/crewbox}"

sudo certbot certonly \
  --dns-cloudflare \
  --dns-cloudflare-credentials /etc/crewbox/cloudflare.ini \
  -d "$DOMAIN" \
  --non-interactive --agree-tos -m "$EMAIL"

live="/etc/letsencrypt/live/$DOMAIN"

# The box wants exactly these two names. Copying rather than symlinking:
# the service runs as an unprivileged user that can't traverse
# /etc/letsencrypt/archive, and a key it can't read is the single most
# common reason a box silently falls back to plain HTTP.
sudo install -o crewbox -g crewbox -m 644 "$live/fullchain.pem" "$DATA_DIR/cert.pem"
sudo install -o crewbox -g crewbox -m 600 "$live/privkey.pem" "$DATA_DIR/key.pem"

sudo systemctl restart crewbox

echo "Certificate valid until:"
openssl x509 -enddate -noout -in "$DATA_DIR/cert.pem"
echo
echo "Check it took: Admin → This box should show HTTPS-gated features as working."
