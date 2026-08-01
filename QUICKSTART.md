# Crewbox — Quickstart

One box, everything on. Download it, run it, crew scan a QR. No accounts, no
app store, nothing to install on anyone's phone unless they want it.

## Run it

**macOS** — download the `.dmg` from the download page, open it, drag
Crewbox to Applications, and launch it. One file works on every Mac, Intel or
Apple Silicon. It keeps the machine awake while it runs, so a laptop with the
lid shut is still a working box.

Nothing to click past: the `.dmg` is signed, notarised and stapled, so it
opens like any other app — including on a box with no internet, which is the
whole point of stapling. The bare `crewbox-darwin-*` binaries below are _not_
signed and still need the dance.

**macOS / Linux, one line**

```sh
curl -fsSL https://crewbox.letissier.ie/install.sh | sh
```

Downloads the box for your machine, clears the macOS quarantine flag, and
starts it. This installs the bare binary rather than the app, so it is the
Linux path and the macOS fallback; on a Mac the `.dmg` is now the easier one.

**Windows** — download the `.exe` from the download page and
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
no way forward. Only the `.dmg` is signed; the bare binaries are not.

## Stopping it

The box is a server, so it keeps running after you close whatever started it.
Where to find it depends on the platform:

- **macOS** — beside the clock. The menu shows the event, the join link and the
  PIN, and **Stop Crewbox and quit** stops it properly. There is no Dock icon
  on purpose; a server doesn't belong there.
- **Windows** — the system tray, same menu.
- **Linux** — Ctrl-C in the terminal it's running in, or the **Stop Crewbox**
  action on the launcher entry. Running it as a service instead:
  `systemctl --user stop crewbox`.

From any terminal, on any platform:

```sh
crewbox --status   # is it running, on what address, with which PIN
crewbox --stop     # stop it
```

`--stop` is the one that always works, including over SSH on a box with no
screen. It's also what you want before replacing the app with a new version —
macOS and Windows both refuse to overwrite a running program.

## What happens next

The first time it runs, the box opens a browser on **four questions**: what
the event is called, which Wi-Fi crew join, the event PIN (already filled in
with a random one — change it or keep it), and the admin password. Save, and
you land on the QR page.

That page is `/connect`, and it's the one to leave on a spare screen or print:
a QR of the join link with the PIN already in it, the PIN in print, and the
Android app when you've put it on the box. Crew scan it, pick a name, and
they're in. Every run after the first goes straight here.

**The admin password is not the event PIN.** The event PIN goes on the poster
and every crew member types it; the admin password opens the cog in the
sidebar, and only you should have it. The box mints one on first start and
prints it to its own terminal, so write it down — it is never shown again.

Anyone can _see_ the cog; the password decides whether it opens, and it stays
unlocked until the app is closed. That's deliberate. Admin used to belong to
whoever joined first, which meant a box could lose its admin panel for good if
that person deleted their account.

Everything from the setup screen — plus channels and crew — is editable
afterwards under **Admin**, so nothing you type on the first run is permanent.
The setup screen itself closes once someone has joined.

**Lost the admin password?** Set `ADMIN_PASSWORD` in the box's environment (or
its service file) and restart. That overrides the stored one, and is the
supported way back in.

No screen on the box (a headless machine, or SSH)? The terminal prints the
setup address too, and any device on the same network can open it.

## What you get

Everything. There are no tiers or editions.

- **Chat** — channels, DMs, mentions, files, presence
- **Push-to-talk voice** — the voice server runs inside the box, nothing to install
- **Patch sheets** — input patch per artist, sub-boxes, lineup, CSV in and out
- **Lighting** — fixture patch with DMX clash detection, positions, a plot, MVR/GDTF and Lightwright/console CSV import
- **Offline throughout** — the box needs no internet, and neither do the crew

**Admin → This box** shows what's actually working on your machine right now,
and what to do about anything that isn't. Trust that over any document,
including this one.

## Checking a download before the event

```sh
scripts/smoke-box.sh ./crewbox-darwin-arm64
```

Starts the box on a scratch port, walks setup → join → admin, confirms the
voice server came up, and cleans up after itself. Needs nothing but `curl`.
Every release runs the same script on every platform, so a failure here means
something specific to your machine — worth knowing in the office rather than
on site.

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
On site, point the venue's DNS at the box so the name resolves locally —
**Admin → This network** writes that config for you. If you're on a venue
network you don't control, `deploy/RUNBOOK.md` covers the one case where a
public record works instead.

**iOS can't get lock-screen alerts with no internet.** Apple's push servers
are unreachable and no app can work around it. The **Android app** solves this
with a foreground service holding its own connection to the box, buzzing for
messages and mentions while the phone is locked, entirely on the LAN. Give
Android phones to the roles that must not miss a call.

Drop the `.apk` from the release into the box's data directory — the
readiness panel names the path, and any `crewbox*.apk` name works as
downloaded — and the box serves it to crew at `/connect`.

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
