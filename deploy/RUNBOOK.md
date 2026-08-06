# Crewbox — Festival Runbook

The one document to print and keep in the production office.

## Kit list

- Server box (mini-PC, e.g. Intel N100 — fanless is nice in dust) + spare
- UPS (even a small one rides out generator switchovers)
- Router **running dnsmasq** — OpenWRT, or a GL.iNet unit, which ships it.
  This is not a preference: the box generates its local DNS entry in dnsmasq
  form (Admin → This network), and that entry is what lets crew reach the box
  by the name on its certificate. A router without a DNS override means no
  HTTPS by name, and so no microphone in the browser.
  With no uplink to use, a two-port travel router's WAN port can be
  reassigned as a second LAN port — but plan a small switch in anyway.
- Enough Wi-Fi APs to cover stages/gates (wired backhaul if possible). A
  travel router covers a production office, not a site.
- USB stick for backups, gaffer-taped to the server
- Printed QR join posters (`node deploy/make-poster.mjs https://chat.<yourdomain> <EVENT_PIN>`)
- This runbook

## A laptop box — trials, small rooms, and the spare in the car

Everything below this section describes the full festival rig: a dedicated
server box, a router you control, a certificate, systemd. That is the right
answer for a site. It is far too much for twenty people in a rehearsal room,
and it is not what you reach for when the real box has died.

For that, a Mac running `Crewbox.dmg` is a complete crew server. Same
software, same data, same everything — it just has no certificate and no
router of its own, and that costs exactly two things (below).

1. **Install.** Download `Crewbox.dmg`, drag Crewbox to Applications, launch
   it. An icon appears **beside the clock**. There is deliberately no Dock
   icon: it is a server, and the menu is where you check on it and stop it.
2. **First launch opens `/setup`** — event name, the Wi-Fi crew join, the
   event PIN, and the admin password. **Write the admin password down now.**
   It is not the event PIN and it is not shown again.
3. **Menu bar → Open the QR poster page.** That is `/connect`: the QR, the
   PIN in print, and the Android app. Leave it on a spare screen, or print it.
4. **Give the Mac a fixed address** — a DHCP reservation on whatever router
   you are on, or a manual IP. On a lease it will move, and when it does every
   QR already scanned points at nothing.
5. **macOS will ask to allow incoming connections** the first time. Say
   Allow. If you clicked past it: System Settings → Network → Firewall →
   Options.
6. **Sleep is already handled** — the box holds a `caffeinate` assertion for
   as long as it runs, lid included. One exception it cannot beat: a MacBook
   on **battery** with the lid shut still sleeps. Keep it on mains.

### The two things a laptop box costs you

Both come from having no HTTPS, and both are visible in **Admin → This box**,
which reports them as `limited` rather than pretending:

- **No push-to-talk from a phone browser.** The voice server really is
  running — but browsers refuse the microphone outside a secure context, and
  `http://192.168.x.x` is not one. Chat, files, patch sheets and lighting are
  all completely unaffected.
- **No install-to-home-screen**, for the same reason.

Crew on **Android with the APK do get voice**, because a native app is not
subject to that rule. If you need push-to-talk in browsers, you need a real
certificate and a DNS name — which is the festival rig, from here down.

Know this before the crew do. "Voice doesn't work" discovered by a stage
manager mid-trial reads as a broken product; said in advance it is a
deployment choice.

### Running it

|                          |                                                                                                                               |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| Stop it                  | Menu bar → **Stop Crewbox and quit**                                                                                          |
| Stop it from a terminal  | `/Applications/Crewbox.app/Contents/Resources/crewbox-server --stop`                                                          |
| Is it running, and where | same path, `--status`                                                                                                         |
| Last resort              | `pkill -f Crewbox`                                                                                                            |
| Where the data lives     | `~/.crewbox/data` — the whole event is in there                                                                               |
| Update it                | Quit first (macOS will not replace a running app), swap in the new `Crewbox.dmg`, launch. Data survives; crew stay signed in. |

## Before the event (needs internet — do at home/office)

1. **Certificate** (calendar this — expires every 90 days):
   `deploy/cert-renew.sh` on the server box. It fetches the cert and installs
   it as `cert.pem` / `key.pem` in the box's data directory, then restarts the
   service — the box serves HTTPS itself, so there is no reverse proxy in the
   picture. It prints the expiry; **Admin → This box** confirms it took.
   The name here is the box's own (`chat.<yourdomain>`, resolving to its LAN
   IP), not the public download site.

   **On a Mac box** (the laptop-that-travels setup): `deploy/cert-renew-mac.sh`
   instead — lego with Vercel DNS, no sudo, everything under `$HOME`. It only
   acts inside 30 days of expiry, so schedule it weekly and forget it. Use
   launchd, not cron: a laptop asleep at the scheduled minute gets the run on
   wake instead of a silent skip. `~/Library/LaunchAgents/com.crewbox.cert-renew.plist`:

   ```xml
   <?xml version="1.0" encoding="UTF-8"?>
   <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
   <plist version="1.0">
   <dict>
     <key>Label</key><string>com.crewbox.cert-renew</string>
     <key>ProgramArguments</key>
     <array><string>/Users/YOU/certs/cert-renew.sh</string></array>
     <key>StartCalendarInterval</key>
     <dict><key>Weekday</key><integer>1</integer><key>Hour</key><integer>10</integer><key>Minute</key><integer>0</integer></dict>
     <key>StandardOutPath</key><string>/Users/YOU/certs/renew.log</string>
     <key>StandardErrorPath</key><string>/Users/YOU/certs/renew.log</string>
   </dict>
   </plist>
   ```

   then `launchctl load` that file once. Or skip the schedule and run the
   script by hand as part of the pre-gig ritual — it is safe any time, and
   does nothing unless the certificate actually needs renewing. Manual mode
   just means the renewal belongs on the same checklist as charging the
   radios. A renewal lands at the box's next start — per-gig, that's the
   next gig; a running event is never touched.

2. **Software up to date.** Which of these you do depends on how the box was
   installed:
   - **A release binary or `Crewbox.dmg`** (the normal case): download the new
     one, stop the old box, put the new one in place, start it. The web app
     ships _inside_ the binary, so there is no separate build and nothing can
     fall out of step. Stop it first — macOS and Windows both refuse to
     replace a running program.
   - **A git checkout** (`/opt/crewbox`): `git pull && npm install && npm run build`,
     then restart the service. Here the server serves whatever `web/dist` holds
     at request time, so an old dist beside a new server quietly ships stale UI
     — clients will nag "New version available" forever. Treat build + restart
     as one step.

   Either way the crew do not have to do anything: an open tab notices the new
   version and offers **Reload**.

3. **Write down the admin password.** The box mints one on first start and
   prints it to its own console; it opens the cog in the sidebar and is not
   the event PIN. Change it in **Admin → This box**. If it is ever lost, set
   `ADMIN_PASSWORD` in the service file and restart — that overrides the
   stored one and is the way back in.
4. **Set `EVENT_PIN`** in `/etc/systemd/system/crewbox.service` (changeable
   later from the admin panel — no restart), then `sudo systemctl daemon-reload`.
   Voice needs no keys: the box generates its own and keeps them, so tokens
   minted before a restart still work after one. `LIVEKIT_*` are only for
   pointing at an SFU you run yourself instead.
   Then open `/setup` once from any browser to name the event and set the
   Wi-Fi hint. It only answers until the first person joins, so do it before
   the rehearsal join in step 5 — after that it's **Admin → This box**.
5. **Print posters** with the final PIN and domain. The event PIN goes on
   them; the admin password never does.
6. **Full rehearsal**: power everything off, power on cold, phone joins via QR
   with the internet unplugged. If this works at home it works in a field.
7. **Rehearse the swap too** — an untested backup is not a backup:
   `deploy/backup.sh`, then on the spare `deploy/restore.sh`, start it, and
   check **Admin → This box**. You should get the event name, the PIN, the
   crew list and HTTPS back, and anyone already signed in stays signed in.
   Ten minutes at home; an hour of guesswork in a field.

## Setup on site

1. Power order: router → APs → server box (all on the UPS).
2. Router: static IP for the server; `deploy/dnsmasq.conf` installed so
   `chat.<yourdomain>` → server IP; DHCP hands out the router as DNS.
3. `systemctl status crewbox` — green. There is no separate voice service:
   the SFU runs inside the box and starts and stops with it.
4. Phone test: scan poster → green padlock → join → send message → PTT to a
   second phone. **Do this before the crew arrives.**

## A box on two networks (crew + lighting)

The usual site shape: one adapter on the crew Wi-Fi, one on the lighting
VLAN. Tell the box which is which, or the join QR is a coin flip between a
network crew phones can reach and one they cannot.

**Pick them from dropdowns** — the first-run setup page has a Networks
section, and the admin panel has the same under **Networks**. Choices are
saved in the box's own database, so relaunches need nothing typed. Saving
redirects the join links immediately; the socket binding and the lighting
listener apply when the box next starts, and the panel's **Crew network**
line says so until you do.

The environment variables still exist and always win — which makes the
terminal the recovery path if a saved setting is ever wrong:

```
CREWBOX_IFACE=192.168.1.50      # the crew network — everything crew-facing
CREWBOX_DMX=both
CREWBOX_DMX_IFACE=2.0.0.50      # the lighting network — receive-only
```

`CREWBOX_IFACE` does two things: every advertised address (QR, banner,
`/connect`, DNS suggestions) points at it, and the web server and the voice
server's signalling **bind** to it (plus localhost), so neither answers on
the lighting VLAN at all. The admin panel's **Crew network** line confirms
which address is in play, and flags the coin flip if you forgot to set this
on a two-network machine.

What crewbox puts on the lighting network, in full: the IGMP membership
reports the OS must send to receive sACN multicast — nothing else. The DMX
sockets structurally cannot transmit (their `send` is removed; a test
asserts it throws). One honest residual: the voice server's _media_ ports
(TCP 7881/UDP 7882) still bind every adapter — they only ever speak to
crew phones that have joined a channel, but a probe of those two ports
would get an answer where everything else stays silent.

What crewbox **cannot** silence is the operating system itself. Windows in
particular will ARP, and by default speak NetBIOS/LLMNR/SSDP, on any
connected adapter. If the lighting network must stay pristine, that is
adapter configuration, not crewbox configuration:

- Give the lighting adapter a **static IP** (no DHCP broadcasts; standard on
  lighting networks anyway — Art-Net convention is 2.x.x.x or 10.x.x.x).
- Adapter → IPv4 properties → WINS → **disable NetBIOS over TCP/IP**.
- Leave the adapter's default gateway **empty** so nothing routes out of it.
- Untick file/printer sharing and client-for-microsoft-networks bindings on
  that adapter.

## When you can't touch the venue's DNS

The normal path is the local override on your own router — **Admin → This
network** generates the exact line. Use it whenever you control the router,
which on an isolated site is the only thing that can work at all: with no
uplink, nothing on site can reach public DNS, so a public record is not a
fallback, it is nothing.

There is one shape where a public record does earn its keep: you are plugged
into a **venue network that has internet and runs its own DHCP/DNS**, and
nobody will add an entry for you. Crew phones on that network can resolve
public names, so an A record pointing at the box's address _on that network_
reaches it, and HTTPS works.

```sh
VERCEL_TOKEN=… node deploy/vercel-dns.mjs --dry-run   # says what it would do
VERCEL_TOKEN=… node deploy/vercel-dns.mjs             # does it
```

It defaults to the name on the box's certificate and the box's own address;
`--hostname` and `--ip` override both. `VERCEL_TEAM_ID` if the domain is on a
team rather than a personal account.

- **The token is not a config value.** It can rewrite every record in the
  zone. Keep it out of the box's data directory — `deploy/backup.sh` copies
  that directory to the USB stick gaffer-taped to the server.
- **Re-run it when the address moves.** On someone else's DHCP it will. The
  script is idempotent and does nothing when the record is already right, so
  cron it: `*/5 * * * * VERCEL_TOKEN=… node /opt/crewbox/deploy/vercel-dns.mjs`.
- **It can still be defeated**, and not visibly: consumer routers often drop
  public answers that point into private address space (DNS rebinding
  protection). If the name resolves nowhere from a phone, that is why, and
  the answer is the venue's own DNS or handing out the IP address.
- It publishes an internal address publicly. Usually a shrug, worth knowing.

Untested against the live API as of writing — do the `--dry-run` at the office,
not in a field.

## Health checks

- App: `curl -k https://chat.<yourdomain>/api/health` → `{"ok":true,...}`
  (shows live connection and online-user counts, plus `docs` room/connection
  counts for patch-sheet sync)
- Voice: **Admin → This box**. It reports whether the SFU is actually
  running, which `systemctl` cannot tell you now that it lives inside the
  box process.
- Disk: `df -h /var/lib/crewbox`

## When things go wrong

| Symptom                    | Fix                                                                                                                                                                                                                                                                                    |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phones can't reach the app | Check phone got router DNS (forget/rejoin Wi-Fi). `dig chat.<yourdomain> @router-ip` should return the server IP.                                                                                                                                                                      |
| Certificate warning        | Cert expired — you missed the renewal. Fall back: crew taps through the warning (app still works); renew when back online.                                                                                                                                                             |
| App down                   | `systemctl restart crewbox` — it restores all state from disk; clients reconnect and resend queued messages themselves.                                                                                                                                                                |
| Voice drops but chat works | `systemctl restart crewbox` — the SFU is inside the box, so it restarts with it. Check UDP **7882** and TCP **7881** aren't firewalled: the SFU pins one UDP port rather than a range, so there is exactly one hole to open.                                                           |
| Server box dies            | Swap in the spare, `deploy/restore.sh` (takes the newest backup by default), same static IP. Crew phones reconnect on their own and stay signed in — sessions are in the database. Patch sheets and plots are unaffected either way: every device holds its own copy and they re-sync. |
| Locked out of Admin        | Set `ADMIN_PASSWORD=…` in `/etc/systemd/system/crewbox.service`, `systemctl daemon-reload && systemctl restart crewbox`. It overrides the stored password. Nobody loses their session; only the panel re-locks.                                                                        |
| Full reset mid-event       | Power-cycle everything in the power order above. The system needs no human input to come back.                                                                                                                                                                                         |

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
2. Copy it into `/var/lib/crewbox/` on the crew box — any `crewbox*.apk`
   name works as-is (release assets are versioned, e.g. `crewbox-v0.9.5.apk`;
   newest file wins). The app serves it at `/crewbox.apk` automatically and
   links it from `/connect`.
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
