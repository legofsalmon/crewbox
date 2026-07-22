# Inter

Offline-first crew chat for music festivals. Slack-style channels, DMs, file
sharing and push-to-talk voice — all served from one box on your own Wi-Fi,
with **zero internet dependency** on site.

## Why it's built the way it is

Festival Wi-Fi drops constantly, so the whole design assumes disconnection
is the normal state:

- Every message gets a client-side id and lives in a persistent **outbox**
  (IndexedDB) until the server acknowledges it — phones can reload, die, or
  roam between APs without losing a message. The server dedupes retries, so
  delivery is exactly-once.
- The server assigns per-channel **sequence numbers**; reconnecting clients
  say "I have up to #42" and receive exactly the gap.
- State lives in a single **SQLite** file (WAL mode) — trivially backed up,
  survives hard power cuts, no database server to babysit.
- The web app is an installable **PWA** with an offline shell and local
  message cache: it opens and shows history even while the server reboots.
- Voice is a self-hosted **LiveKit** SFU on the same box (~LAN latency),
  with a hold-to-talk intercom UI; mic-less users degrade to listen-only.

## Repo layout

```
shared/   protocol types + zod schemas (used by both sides)
server/   Fastify + WebSocket + node:sqlite (no native deps)
web/      React + Vite PWA
deploy/   Caddyfile, livekit.yaml, systemd units, dnsmasq config,
          cert-renew.sh, backup.sh, make-poster.mjs, soak.mjs, RUNBOOK.md
```

## Development

```bash
npm install
npm run dev        # server on :8787, web on :5173 (proxied)
npm test           # server integration tests (reliability protocol)
```

Dev event PIN is `1234`. For voice in dev: `brew install livekit` then
`livekit-server --dev`.

Two-user testing: open `http://localhost:5173` and `http://127.0.0.1:5173`
— different origins get separate logins.

## Production (the festival box)

Ubuntu Server + Node 22+, `livekit-server`, `caddy`. Then:

```bash
npm install && npm run build
node deploy/make-poster.mjs https://chat.yourdomain.com <EVENT_PIN>
```

Install the files in `deploy/` (systemd units, Caddyfile, livekit.yaml,
dnsmasq.conf), run `deploy/cert-renew.sh` while you still have internet,
and walk through `deploy/RUNBOOK.md` — it is the day-of checklist.

Environment (see `deploy/systemd/inter.service`): `INTER_PORT`, `DATA_DIR`,
`WEB_DIST`, `EVENT_PIN`, `LIVEKIT_URL`, `LIVEKIT_KEY`, `LIVEKIT_SECRET`.

## Load

`node deploy/soak.mjs http://localhost:8787 50 60` runs 50 simulated crew
members for a minute and asserts exactly-once delivery for every client.

## Known platform limits

- **iOS cannot receive lock-screen notifications offline** (Apple's push
  servers are unreachable). In-app sounds/vibration work while open. A
  Capacitor Android app with a foreground service (planned Phase 5) is the
  path to reliable background alerts.
- Mic, install prompt and service worker require HTTPS — provided on site
  by the pre-fetched certificate + local DNS trick (see RUNBOOK).
