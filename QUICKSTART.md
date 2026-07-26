# Crewbox — Quickstart

One box, everything on. Download it, run it, crew scan a QR. No accounts, no
app store, nothing to install on anyone's phone unless they want it.

## Run it

**macOS / Linux**

```sh
curl -fsSL https://crewbox.letissier.ie/install.sh | sh
```

Downloads the box for your machine, clears the macOS quarantine flag, and
starts it.

**Windows** — download `crewbox-win32-x64.exe` from the download page and
double-click it. SmartScreen will warn about an unsigned app: **More info →
Run anyway**. That warning means Windows hasn't seen this file before, not
that anything is wrong with it.

**By hand on macOS/Linux**

```sh
chmod +x crewbox-*                       # make it runnable
xattr -d com.apple.quarantine crewbox-*  # macOS only: clear the download flag
./crewbox-*
```

Without that `xattr` line macOS refuses to open it, with a dialog that offers
no way forward.

## What happens next

The first time it runs, the box opens a browser on **three questions**: what
the event is called, which Wi-Fi crew join, and the event PIN (already filled
in with a random one — change it or keep it). Save, and you land on the QR
page.

That page is `/connect`, and it's the one to leave on a spare screen or print:
a QR of the join link with the PIN already in it, the PIN in print, and the
Android app when you've put it on the box. Crew scan it, pick a name, and
they're in. Every run after the first goes straight here.

The first person to join is the admin. Everything from the setup screen — plus
channels and crew — is editable afterwards in the app under **Admin**, so
nothing you type on the first run is permanent. The setup screen itself closes
once someone has joined.

No screen on the box (a headless machine, or SSH)? The terminal prints the
setup address too, and any device on the same network can open it.

## What you get

Everything. There are no tiers or editions.

- **Chat** — channels, DMs, mentions, files, presence
- **Push-to-talk voice** — the voice server runs inside the box, nothing to
  install. **Linux and Windows boxes only**: LiveKit publishes no macOS build,
  so a Mac box has everything except voice. If voice matters, make the box a
  Linux or Windows machine — or run `livekit-server` yourself (it's in
  Homebrew) and start the box with `LIVEKIT_URL` pointing at it.
- **Patch sheets** — input patch per artist, sub-boxes, lineup, CSV in and out
- **Lighting** — fixture patch with DMX clash detection, positions, a plot, MVR/GDTF and Lightwright/console CSV import
- **Offline throughout** — the box needs no internet, and neither do the crew

**Admin → This box** shows what's actually working on your machine right now,
and what to do about anything that isn't. Trust that over any document,
including this one.

## Two things worth knowing

**Browsers won't grant a microphone over plain `http://`.** That's a browser
security rule rather than a crewbox limitation, and the same rule blocks "add
to home screen" and the offline shell. Voice works today in the **Android and
iOS apps**, which are exempt.

To get it in browsers too, give the box a certificate for a name you control:
drop `cert.pem` and `key.pem` into its data directory (the readiness panel
names the path) and restart. **The box serves HTTPS itself** — there is no
reverse proxy to install. Where the certificate comes from is up to you:
certbot, a wildcard you already own, whatever your IT department hands over.
On site, point the venue's DNS at the box so the name resolves locally.

**iOS can't get lock-screen alerts with no internet.** Apple's push servers
are unreachable and no app can work around it. The **Android app** solves this
with a foreground service holding its own connection to the box, buzzing for
messages and mentions while the phone is locked, entirely on the LAN. Give
Android phones to the roles that must not miss a call.

Drop `crewbox.apk` from the release into the box's data directory — the
readiness panel names the path — and the box serves it to crew at `/connect`.

## Running an event

`deploy/RUNBOOK.md` is the day-of checklist: kit, cold-boot rehearsal, health
checks, what to do when something breaks, teardown. Read it before the event,
not during.

## Development

```bash
npm install
npm run dev        # server :8787, web :5173
```

Open http://localhost:5173 and join with event PIN `1234`; a second browser at
http://127.0.0.1:5173 is a second crew member. A dev run has no voice server —
that ships inside the release binary.
