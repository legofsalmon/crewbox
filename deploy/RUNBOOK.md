# Crewbox — Festival Runbook

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
   `deploy/cert-renew.sh` on the server box, then copy the pair into the
   box's data directory as `cert.pem` and `key.pem` — the box serves HTTPS
   itself, so there is no reverse proxy to restart. Verify:
   `openssl x509 -enddate -noout -in /etc/crewbox/certs/fullchain.pem`
2. **Software up to date**: `git pull && npm install && npm run build` in `/opt/crewbox`,
   then restart the service. The server serves whatever `web/dist` holds at request
   time — an old dist next to a new server binary quietly ships stale UI (clients
   will nag "New version available" forever), so treat build + restart as one step.
3. **Set secrets** in `/etc/systemd/system/crewbox.service`: `EVENT_PIN` (changeable
   later from the admin panel — no restart), `LIVEKIT_KEY`/`LIVEKIT_SECRET`
   (generate with `livekit-server generate-keys`; mirror in `/etc/crewbox/livekit.yaml`), then
   `sudo systemctl daemon-reload`.
4. **Print posters** with the final PIN and domain.
5. **Full rehearsal**: power everything off, power on cold, phone joins via QR
   with the internet unplugged. If this works at home it works in a field.

## Setup on site

1. Power order: router → APs → server box (all on the UPS).
2. Router: static IP for the server; `deploy/dnsmasq.conf` installed so
   `chat.<yourdomain>` → server IP; DHCP hands out the router as DNS.
3. `systemctl status crewbox livekit the box itself` — all green.
4. Phone test: scan poster → green padlock → join → send message → PTT to a
   second phone. **Do this before the crew arrives.**

## Health checks

- App: `curl -k https://chat.<yourdomain>/api/health` → `{"ok":true,...}`
  (shows live connection and online-user counts, plus `docs` room/connection
  counts for patch-sheet sync)
- Voice: `systemctl status livekit`
- Disk: `df -h /var/lib/crewbox`

## When things go wrong

| Symptom                    | Fix                                                                                                                                                                                                                           |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phones can't reach the app | Check phone got router DNS (forget/rejoin Wi-Fi). `dig chat.<yourdomain> @router-ip` should return the server IP.                                                                                                             |
| Certificate warning        | Cert expired — you missed the renewal. Fall back: crew taps through the warning (app still works); renew when back online.                                                                                                    |
| App down                   | `systemctl restart crewbox` — it restores all state from disk; clients reconnect and resend queued messages themselves.                                                                                                       |
| Voice drops but chat works | `systemctl restart livekit`. Check UDP ports 50000–50200 aren't firewalled.                                                                                                                                                   |
| Server box dies            | Swap in the spare, restore newest USB backup into `/var/lib/crewbox`, same static IP. Crew phones reconnect on their own. Patch sheets are unaffected — every device holds its own copy and they re-sync through the new box. |
| Full reset mid-event       | Power-cycle everything in the power order above. The system needs no human input to come back.                                                                                                                                |

## Teardown

1. `deploy/backup.sh` once more; pocket the USB stick.
2. Export anything needed for incident reports before wiping user data.

## Platform truths (so nobody promises otherwise)

- **iOS phones cannot get lock-screen alerts offline** — Apple push needs
  internet, even for native apps. Crew on iPhones should keep the app open
  (guide: Settings → Display → Auto-Lock → Never during shifts). Alert-critical
  roles carry Android with the Crewbox app (below) or a real radio as backup.
- Browsers only allow mic/notifications/install on HTTPS — hence the whole
  certificate dance. Don't skip it. (The native apps are exempt: plain HTTP.)

## The Android app (background alerts)

The Phase 5 APK gives Android crew real lock-screen buzz with no internet:
a foreground service holds a WebSocket to the crew server; mentions and DMs
vibrate on a high-priority channel.

1. Build it once per release:
   `npm run build:native && cd native/android && JAVA_HOME=/opt/homebrew/opt/openjdk@21 ./gradlew assembleDebug`
   → `native/android/app/build/outputs/apk/debug/app-debug.apk`.
2. Copy it onto the crew box as `/var/lib/crewbox/crewbox.apk` — the app
   serves it at `/crewbox.apk` automatically (and links it from `/connect` — or just
   drop it in the web dist folder before starting the server).
3. Add a line to the QR poster: "Android? Scan to install the app — it buzzes
   even when locked." QR → `http://chat.<your-domain>/crewbox.apk`. Crew must
   allow install-from-browser once (Android prompts).
4. On first app launch: enter the crew server address from the poster, join,
   tap **Allow** on notifications, and **Allow** on battery exemption. Done —
   test it by locking the phone and having someone @mention them.
5. iPhones: TestFlight (Apple account required) — open `native/ios/App` in
   Xcode, set your team, Product → Archive → Distribute. The PWA remains the
   zero-setup iOS path.

## Remote support access (optional — needs internet at the site)

Lets office/warehouse staff join over the internet to answer questions and
source assets. The server stays on the site box: if the uplink dies, the
festival keeps chatting and only remote folks drop off. Voice stays
site-only (LiveKit doesn't traverse the tunnel); remote users are text+files.

1. **Expose the server with a Cloudflare Tunnel** (free, no inbound ports):
   - One-time, at home: `cloudflared tunnel login`, then
     `cloudflared tunnel create crewbox` and add a DNS route:
     `cloudflared tunnel route dns crewbox support.<your-domain>`.
   - Config `/etc/cloudflared/config.yml`:
     ```yaml
     tunnel: crewbox
     credentials-file: /etc/cloudflared/<tunnel-id>.json
     ingress:
       - hostname: support.<your-domain>
         service: http://localhost:8787
       - service: http_status:404
     ```
   - `sudo cloudflared service install` (or use `deploy/systemd/crewbox-tunnel.service`).
   - Ad-hoc alternative (no account, random URL, great for testing):
     `cloudflared tunnel --url http://localhost:8787`.

2. **Harden before exposing** — these matter once the join page is public:
   - `EVENT_PIN`: treat it as a real secret now, not poster decoration —
     long and rotated per event. Remote staff get it by phone/text, not email
     blasts. **Required with the tunnel**: the server refuses to start when
     `CREWBOX_TRUST_PROXY=1` and `EVENT_PIN` is unset, so it can never sit on
     the internet on the public default PIN.
   - `CREWBOX_TRUST_PROXY=1` in the service env, so rate limits see real
     client IPs through the tunnel instead of one shared localhost bucket.
   - `SESSION_TTL_DAYS` (default 60) — idle sessions expire; prunes at boot.
   - **Personal PINs**: for an internet-exposed event tell crew to use 6–8
     digits, not 4. A wrong-PIN lockout (10 tries per name, then a few-minute
     cooldown, regardless of source IP) already blunts brute force, but a
     longer PIN is the real defence.

3. **Tell remote staff**: browser → `https://support.<your-domain>`, join
   with the event PIN like anyone else. They show an **office** badge in the
   sidebar so site crew know who's not physically around. A `#support`
   channel keeps asset-sourcing chatter out of `#general`.

4. **Kill switch**: stop the tunnel service. Site chat is untouched.
