# Crewbox

Offline-first crew communication for temporary events — outdoor music festivals
first. Slack-style channels, DMs, file sharing and push-to-talk voice as the
core, with specialised department modules (patch sheets first) in one app — all
served from one box on your own Wi-Fi, with **zero internet dependency** on
site.

**New here? [QUICKSTART.md](QUICKSTART.md)** — from a laptop trial to the
one-file box to the full festival rig.

Crewbox unifies [inter](https://github.com/legofsalmon/inter) and
[Live Patch](https://github.com/legofsalmon/livepatch); both full histories are
merged into this repo. See [docs/UNIFICATION_PLAN.md](docs/UNIFICATION_PLAN.md)
for the plan and roadmap.

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
- Collaboratively edited state (patch sheets) uses **Yjs CRDT documents**
  stored on each device: fully functional offline, merging without conflicts
  when devices sync through the box.

## Repo layout

```
shared/   protocol types + zod schemas (used by both sides)
server/   Fastify + WebSocket + node:sqlite (no native deps)
web/      React + Vite PWA — shell + modules
native/   Capacitor wrappers (Android with offline lock-screen alerts, iOS)
deploy/   Caddyfile, livekit.yaml, systemd units, dnsmasq config,
          cert-renew.sh, backup.sh, make-poster.mjs, soak.mjs, RUNBOOK.md
import/   pristine import of the Live Patch codebase (ports into web/ and
          server/ over Phases 2–3, then retires)
```

## Development

```bash
npm install
npm run dev        # server on :8787, web on :5173 (proxied)
npm test           # server integration tests (reliability protocol) + web unit tests
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

Once running, **`/connect`** is the live onboarding page: a QR of the join
URL (event PIN prefilled), the PIN in print, and the Android APK download
when `crewbox.apk` sits in `DATA_DIR`. The event PIN is changeable at
runtime from the admin panel. With `NODE_ENV=production`, voice is off
unless `LIVEKIT_URL` is set — the voice button simply doesn't appear.

Environment (see `deploy/systemd/crewbox.service`): `CREWBOX_PORT`, `DATA_DIR`,
`WEB_DIST`, `EVENT_PIN`, `LIVEKIT_URL`, `LIVEKIT_KEY`, `LIVEKIT_SECRET`,
`CREWBOX_MODULES` (module ids to enable beyond chat, comma-separated;
defaults to `patch`, and chat is always on).

## Load

`node deploy/soak.mjs http://localhost:8787 50 60` runs 50 simulated crew
members for a minute and asserts exactly-once delivery for every client.

## Versioning & updates

The build version (`package.json` version + short git commit, e.g.
`0.1.0+dbed74e`) shows on the join screen and at the foot of the sidebar, and
is returned by `GET /api/health` and in the WebSocket `welcome`. Bump the
`web`/`server` `package.json` version for a user-facing release.

When you deploy a new build, updates reach crew **without forcing anyone to do
anything mid-task** (the service worker registers in `prompt` mode):

- **Used before, app now closed:** on next open the old cached shell loads
  instantly (works offline); the service worker checks for the new build in
  the background and, if found, shows a small "New version available — Reload"
  bar. One tap reloads into the new version.
- **Currently connected:** the running app keeps working on its old code. The
  service worker notices the new build (on its 30-minute re-check or next
  reconnect) and shows the same reload bar. If the server reports a newer
  version in `welcome`, the bar appears immediately on reconnect. Reloading is
  always safe — unsent messages live in the IndexedDB outbox and flush after
  the reload, so nothing is lost.
- **Deploy both together:** the Node server serves the built web assets, so a
  single deploy updates client and server in lockstep. If you ever change the
  WebSocket protocol in `shared/` in a breaking way, treat it as a coordinated
  release and expect connected clients to reload once.

## Known platform limits

- **iOS cannot receive lock-screen notifications offline** (Apple's push
  servers are unreachable) — not even natively. In-app sounds/vibration work
  while open. **The Android app solves this**: its foreground service
  holds a WebSocket to the crew server and buzzes for messages and mentions
  while the phone is locked, entirely on-LAN. Alert-critical roles carry
  Android.
- Mic, install prompt and service worker require HTTPS _in the browser_ —
  provided on site by the pre-fetched certificate + local DNS trick (see
  RUNBOOK). **The native apps are exempt**: they talk plain HTTP to the crew
  server and grant mic permission natively.

## Native apps

`native/` is a Capacitor workspace wrapping the built web bundle:

- **Android** (`native/android`) — the important one. Sideloadable APK; a
  foreground service (`AlertsService`) keeps its own WebSocket to the crew
  server and raises notifications while the app is backgrounded: normal
  traffic on a default-priority "Messages" channel, @mentions and DMs on a
  high-priority vibrating "Mentions & DMs" channel. No notification floods
  on reconnect (it baselines from the welcome payload), no alerts while the
  app is visible, auto-reconnect, battery-optimisation exemption prompt.
- **iOS** (`native/ios`) — same app, native mic permission, plain-HTTP LAN
  transport. No offline push (see above); distribute via TestFlight.

Build: `npm run build:native` (web build + `cap sync`), then
`cd native/android && JAVA_HOME=/opt/homebrew/opt/openjdk@21 ./gradlew assembleDebug`
for the APK, or open `native/ios/App` in Xcode for the iOS archive. The
join screen in native builds asks for the crew server address (also
reachable via a `?server=` deep-link on the QR poster).
