# Crewbox

Offline-first crew communication for temporary events — outdoor music festivals
first. Slack-style channels, DMs, file sharing and push-to-talk voice as the
core, with specialised department modules (patch sheets, lighting) in one app — all
served from one box on your own Wi-Fi, with **zero internet dependency** on
site.

**New here? [QUICKSTART.md](QUICKSTART.md)** — download it, run it, crew scan
a QR. One box with everything on; there are no tiers or editions.

Crewbox unifies [inter](https://github.com/legofsalmon/inter) and
[Live Patch](https://github.com/legofsalmon/livepatch); both full histories are
merged into this repo. See [docs/UNIFICATION_PLAN.md](docs/UNIFICATION_PLAN.md)
for the plan and roadmap, and [docs/MODULES.md](docs/MODULES.md) for how to add
a module for another department.

## Modules

Crewbox is a shell (identity, chat, offline storage, routing) plus department
modules. A box chooses which to run with `CREWBOX_MODULES`; chat is always on.

| Module           | What it does                                                                                                                                                                                    |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Chat**         | Channels, DMs, mentions, files, push-to-talk voice. Always enabled.                                                                                                                             |
| **Patch Sheets** | Input patch per artist — channels × artists, sub-boxes, lineup, CSV in/out.                                                                                                                     |
| **Lighting**     | Fixture patch with DMX collision detection, rigging positions at their trim heights, plan / front / 3D views of the rig, truss-length estimates, and MVR/GDTF + Lightwright/console CSV import. |

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
- Voice is a self-hosted **LiveKit** SFU that ships _inside_ the box binary
  and starts with it (~LAN latency), with a hold-to-talk intercom UI;
  mic-less users degrade to listen-only. Upstream ships no macOS binary, so
  the darwin box compiles one from source at build time — same program, same
  pinned version, so voice is inside the box on all three platforms.
- Collaboratively edited state (patch sheets) uses **Yjs CRDT documents**
  stored on each device: fully functional offline, merging without conflicts
  when devices sync through the box.

## Repo layout

```
site/     the public download page + install.sh (deployed to Vercel)
shared/   protocol types + zod schemas (used by both sides)
server/   Fastify + WebSocket + node:sqlite (no native deps)
web/      React + Vite PWA — shell + modules
native/   Capacitor wrappers (Android with offline lock-screen alerts, iOS)
deploy/   systemd unit, dnsmasq config, cert-renew.sh, backup.sh,
          restore.sh, make-poster.mjs, soak.mjs, RUNBOOK.md (the box serves
          TLS and voice itself, so no Caddy or livekit-server to install)
```

Live Patch used to sit under `import/` while it was being ported. That port is
finished and the directory is gone; its history is still here, reachable
through the merge commit that brought it in (`git log 23d20ec`), so
`git show 23d20ec:<path>` still resolves any original file.

## Development

```bash
npm install
npm run dev        # server on :8787, web on :5173 (proxied)
npm test           # server integration tests (reliability protocol) + web unit tests
```

Dev event PIN is `1234`. A dev run has no voice server — that ships inside
the release binary. For voice while developing: `brew install livekit` then
`livekit-server --dev`.

Two-user testing: open `http://localhost:5173` and `http://127.0.0.1:5173`
— different origins get separate logins.

## Running it

Download the box and run it — see [QUICKSTART.md](QUICKSTART.md). The binary
carries the web app _and_ the voice server, so there is nothing else to
install and no separate "full" edition.

**`/setup`** is the first run: event name, Wi-Fi network and event PIN, asked
once in a browser the box opens for you, then straight to the QR. It exists
only while nobody has joined — at that point anyone who can reach the box can
join and become admin anyway, so an open form grants nothing extra, and the
moment someone joins it closes and the admin panel takes over.

**`/connect`** is the live onboarding page: a QR of the join URL (event PIN
prefilled), the PIN in print, and the Android APK download when
`crewbox.apk` sits in the data directory. The event name, event PIN and Wi-Fi
hint are all changeable at runtime from the admin panel.

**Admin → This box** reports what actually works on that machine right now —
voice, HTTPS-gated features, the Android app, disk, crew joined — with the
fix attached to anything that doesn't. It is the honest answer; this file
is only a description.

**Admin → This network** is the same idea one scope out: what the box has been
plugged into. A DHCP lease that never arrived, a hostname still pointing at
last year's box, a certificate expiring on the Saturday — none of those are
software faults, and none of them surface until crew can't connect. Real
problems also appear on `/setup`, where they are far cheaper to fix than after
the posters are printed.

**No internet is reported as normal, not as a fault**, because that is the
state this product exists for. Those rows carry an `info` state that never
colours the summary. A captive portal is different and _is_ flagged: it looks
exactly like a working uplink while silently breaking certificate renewal.

For a dedicated festival rig — HTTPS on your own domain so browsers get the
mic and the installable app, local DNS, UPS and spare-box discipline —
`deploy/` carries the pieces and `deploy/RUNBOOK.md` is the day-of checklist.

Environment (see `deploy/systemd/crewbox.service`): `CREWBOX_PORT`, `DATA_DIR`,
`WEB_DIST`, `EVENT_PIN`, `LIVEKIT_URL`, `LIVEKIT_KEY`, `LIVEKIT_SECRET`,
`CREWBOX_MODULES` (module ids to enable beyond chat, comma-separated;
defaults to every department module the build ships, and chat is always on).
Setting `LIVEKIT_URL` points voice at an SFU you run instead of the one
inside the box.

## Load

`node deploy/soak.mjs http://localhost:8787 50 60` runs 50 simulated crew
members for a minute and asserts exactly-once delivery for every client.

## Smoke-testing a build

`scripts/smoke-box.sh build/box/crewbox-linux-x64` starts a built box, walks
setup → join → admin, and asserts the voice server actually came up. Plain sh
and curl, so it also runs on a festival admin's Mac against a downloaded
release.

Every release runs it on each platform, including against the universal
`Crewbox.app`. It exists because a box can build perfectly and still ship
without working voice — a missing SFU asset, an SFU that won't execute on that
OS, a universal binary whose slices lost their payload — and none of that
appears in a build log.

## Versioning & updates

The build version (`package.json` version + short git commit, e.g.
`0.1.0+dbed74e`) shows on the join screen and at the foot of the sidebar, and
is returned by `GET /api/health` and in the WebSocket `welcome`. Bump the
`web`/`server` `package.json` version for a user-facing release.

To cut a release (box binaries for Linux/Windows/macOS + the Android APK,
attached to a GitHub release), either push a `v*` tag, or run the **Release**
workflow from the Actions tab: pick the branch to build and type the version
(e.g. `v0.1.1`). The tag is created at that commit, so no local tag push is
needed. The run refuses to publish a version whose tag already points at a
different commit.

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
- Mic, install prompt and service worker require HTTPS _in the browser_ — a
  browser security rule, not something packaging can remove. On site that
  means a pre-fetched certificate plus the local DNS trick (see RUNBOOK).
  **The native apps are exempt**: they talk plain HTTP to the crew server and
  grant mic permission natively, so voice works for them on any box.

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
