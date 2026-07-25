# Deploying Live Patch

Live Patch is built for venues where internet is spotty or absent. The recommended
deployment is a **festival box**: one machine on the production network that serves the
app, relays sync, and stores attachments. Crew devices need nothing but a browser.

## The festival box

Any always-on machine on the venue LAN works — a mini PC/NUC, a spare laptop, or a
Raspberry Pi. One process provides everything:

- serves the app itself
- relays real-time sync between devices
- stores lineup attachments (stage plots, riders) on disk

Because the box serves the app, devices that open it get **sync configured
automatically** (same origin) — nobody types a server address on site. Once a device
has loaded the app once, the PWA is cached: it opens and works even if the box is
down, and re-syncs when the box returns. The box holds no critical state — every
device keeps a full local copy of every sheet it has opened.

### Option A — download the app (easiest, no install)

1. On the machine that will be the box, download the file for its OS from
   **[Releases](https://github.com/legofsalmon/livepatch/releases)**:
   `livepatch-windows-x64.exe`, `livepatch-macos-arm64` / `-x64`, or
   `livepatch-linux-x64`. (Do this at home — on site needs no internet.)
2. Double-click it (Linux/macOS terminal: `./livepatch-linux-x64`).
3. It prints the address crew devices should open, **shows a QR code to scan**,
   and opens a big-screen version of the same thing at `/connect` — leave that
   on the box's display for crew to scan.

That's the entire install: no Node, no Docker, no git. Data (attachments) lives in
`~/.livepatch/data`. Set an access token by launching with `LIVEPATCH_TOKEN=…` in the
environment. First-launch warnings for the unsigned binaries: Windows SmartScreen —
"More info → Run anyway"; macOS — right-click the file → Open.

To relaunch automatically after reboots, add it to the OS's startup items
(Task Scheduler / Login Items / a systemd unit as in Option C).

### Option B — Docker (good for homelabs and the cloud)

```bash
git clone https://github.com/legofsalmon/livepatch.git
cd livepatch
docker compose up -d --build
```

`restart: unless-stopped` brings it back after power cuts and reboots; attachments
persist in the `livepatch-data` volume. Token: `LIVEPATCH_TOKEN=your-token docker compose up -d`.

### Option C — Node + systemd (permanently installed box)

On a box with Node ≥ 20.19:

```bash
git clone https://github.com/legofsalmon/livepatch.git /opt/livepatch
cd /opt/livepatch && npm ci && npm run build
cd server && npm ci
sudo cp ../deploy/livepatch.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now livepatch
```

(For a quick foreground run from a clone: `npm run box`.)

## On-site runbook

1. Give the box a **fixed IP** (static or DHCP reservation) on the production
   network / crew Wi-Fi. Label the box with it.
2. Each crew device: scan the QR (or browse to the printed address), then
   **Add to Home Screen / Install** so it launches full-screen and stays cached.
3. Open a sheet — the header chip should read **Synced**. Set your name in
   ⚙ Sync settings so others see who's editing.
4. If you set `LIVEPATCH_TOKEN`, each device enters it once in ⚙ Sync settings.
   On a trusted, isolated production LAN, running without a token is reasonable.

**Power cut / box failure:** devices keep working from their local copies (the PWA
and all opened sheets live on-device). When the box comes back, everything merges
automatically — including edits made while it was down.

**Pre-show check:** open the same sheet on two devices, type in one, see it appear
on the other, pull the box's network cable, type on both, reconnect, confirm both
edits survived.

## Cloud deployment (when internet is reliable)

The same pieces run in the cloud for cross-site use:

- Run the container (or the binary / `server/`) on any host; put it behind TLS so
  devices use `wss://`. Set `LIVEPATCH_TOKEN` — the internet is not a trusted LAN.
- The box serves the app over plain HTTP, which is fine on a LAN; public
  deployments should sit behind an HTTPS reverse proxy (Caddy, nginx, Traefik).
- Alternatively host `dist/` on any static host and run only the relay, entering
  its `wss://` URL in each device's ⚙ Sync settings.

Devices can switch between relays at any time in ⚙ Sync settings — e.g. a cloud
relay for advance work, then the festival box on site. Sheets merge wherever they
meet.

## Environment variables (server)

| Variable            | Default                                      | Purpose                                     |
| ------------------- | -------------------------------------------- | ------------------------------------------- |
| `PORT`              | `1234`                                       | HTTP + websocket port                       |
| `HOST`              | `0.0.0.0`                                    | Bind address                                |
| `LIVEPATCH_TOKEN`   | _(empty = open)_                             | Shared token required from every client     |
| `DATA_DIR`          | `server/data` (`~/.livepatch/data` packaged) | Attachment storage location                 |
| `STATIC_DIR`        | auto (`../dist`)                             | Built app to serve; empty disables box mode |
| `MAX_FILE_BYTES`    | `26214400`                                   | Attachment size cap (25 MB)                 |
| `LIVEPATCH_NO_OPEN` | _(unset)_                                    | Set to suppress the banner's browser open   |

## Building release binaries

`npm run build && npm run build:sea` produces the current platform's single-file
executable in `build/sea/`. The `Release` workflow builds all four (Windows, macOS
arm64/x64, Linux) and attaches them to a GitHub Release whenever a `v*` tag is pushed:

```bash
git tag v2.1.0 && git push origin v2.1.0
```
