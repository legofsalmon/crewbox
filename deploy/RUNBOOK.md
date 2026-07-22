# Inter — Festival Runbook

The one document to print and keep in the production office.

## Kit list

- Server box (mini-PC, e.g. Intel N100 — fanless is nice in dust) + spare
- UPS (even a small one rides out generator switchovers)
- Router + enough Wi-Fi APs to cover stages/gates (wired backhaul if possible)
- USB stick for backups, gaffer-taped to the server
- Printed QR join posters (`node deploy/make-poster.mjs https://chat.<yourdomain> <EVENT_PIN>`)
- This runbook

## Before the event (needs internet — do at home/office)

1. **Certificate** (calendar this — expires every 90 days):
   `deploy/cert-renew.sh` on the server box. Verify: `openssl x509 -enddate -noout -in /etc/inter/certs/fullchain.pem`
2. **Software up to date**: `git pull && npm install && npm run build` in `/opt/inter`.
3. **Set secrets** in `/etc/systemd/system/inter.service`: `EVENT_PIN`, `LIVEKIT_KEY`/`LIVEKIT_SECRET`
   (generate with `livekit-server generate-keys`; mirror in `/etc/inter/livekit.yaml`), then
   `sudo systemctl daemon-reload`.
4. **Print posters** with the final PIN and domain.
5. **Full rehearsal**: power everything off, power on cold, phone joins via QR
   with the internet unplugged. If this works at home it works in a field.

## Setup on site

1. Power order: router → APs → server box (all on the UPS).
2. Router: static IP for the server; `deploy/dnsmasq.conf` installed so
   `chat.<yourdomain>` → server IP; DHCP hands out the router as DNS.
3. `systemctl status inter livekit caddy` — all green.
4. Phone test: scan poster → green padlock → join → send message → PTT to a
   second phone. **Do this before the crew arrives.**

## Health checks

- App: `curl -k https://chat.<yourdomain>/api/health` → `{"ok":true,...}`
  (shows live connection and online-user counts)
- Voice: `systemctl status livekit`
- Disk: `df -h /var/lib/inter`

## When things go wrong

| Symptom | Fix |
|---|---|
| Phones can't reach the app | Check phone got router DNS (forget/rejoin Wi-Fi). `dig chat.<yourdomain> @router-ip` should return the server IP. |
| Certificate warning | Cert expired — you missed the renewal. Fall back: crew taps through the warning (app still works); renew when back online. |
| App down | `systemctl restart inter` — it restores all state from disk; clients reconnect and resend queued messages themselves. |
| Voice drops but chat works | `systemctl restart livekit`. Check UDP ports 50000–50200 aren't firewalled. |
| Server box dies | Swap in the spare, restore newest USB backup into `/var/lib/inter`, same static IP. Crew phones reconnect on their own. |
| Full reset mid-event | Power-cycle everything in the power order above. The system needs no human input to come back. |

## Teardown

1. `deploy/backup.sh` once more; pocket the USB stick.
2. Export anything needed for incident reports before wiping user data.

## Platform truths (so nobody promises otherwise)

- **iOS phones cannot get lock-screen alerts offline** — Apple push needs
  internet. Crew on iPhones should keep the app open (guide: Settings →
  Display → Auto-Lock → Never during shifts). Alert-critical roles carry
  Android (a native wrapper with a foreground service can buzz reliably —
  Phase 5) or a real radio as backup.
- Browsers only allow mic/notifications/install on HTTPS — hence the whole
  certificate dance. Don't skip it.
