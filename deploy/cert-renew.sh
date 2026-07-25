#!/usr/bin/env bash
# Fetch/renew the wildcard certificate for the festival domain.
#
# Run this on the server box WITH internet, at least a week before the
# event (Let's Encrypt certs last 90 days — put the renewal date in your
# calendar). On site the cert validates offline; no internet is needed.
#
# Uses the DNS-01 challenge, which works without exposing the box to the
# internet. The example uses Cloudflare DNS; certbot has plugins for most
# providers (or use --manual and add the TXT record by hand).
set -euo pipefail

DOMAIN="chat.example.com"
CERT_DIR="/etc/crewbox/certs"

sudo certbot certonly \
  --dns-cloudflare \
  --dns-cloudflare-credentials /etc/crewbox/cloudflare.ini \
  -d "$DOMAIN" \
  --non-interactive --agree-tos -m you@example.com

sudo mkdir -p "$CERT_DIR"
sudo cp "/etc/letsencrypt/live/$DOMAIN/fullchain.pem" "$CERT_DIR/"
sudo cp "/etc/letsencrypt/live/$DOMAIN/privkey.pem" "$CERT_DIR/"
sudo systemctl reload caddy

echo "Certificate valid until:"
openssl x509 -enddate -noout -in "$CERT_DIR/fullchain.pem"
