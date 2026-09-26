---
title: Running the box
section: Running the box
order: 10
blurb: Download, first run, the setup questions, the QR noticeboard, and stopping it properly.
---

# Running the box

The box is one program on one machine — a laptop is fine — serving
everything: the app, the files, the history, the voice server. This page
takes you from download to crew scanning the QR; nothing here needs
internet at the venue.

## Install and run

- **macOS** — download the `.dmg` from [the front page](/), open, drag to
  Applications, launch. Signed and notarised, so it opens without warnings
  — including with no internet. It keeps the Mac awake while running, lid
  shut included. When macOS asks whether Crewbox may find and connect to
  devices on your local network, say **Allow**: it is how the phone apps
  find the box on the Wi-Fi. Said no by mistake? **System Settings →
  Privacy & Security → Local Network**, and turn Crewbox on.
- **Windows** — download the `.exe`, double-click. SmartScreen will warn
  about an unsigned app: **More info → Run anyway**. That means Windows
  hasn't seen the file before, not that something is wrong.
- **Linux, or macOS by one line**:

```sh
curl -fsSL https://crewbox.letissier.ie/install.sh | sh
```

Downloads the right binary, clears the macOS quarantine flag, starts it.

## First run: four questions

![The /setup page and its four questions](shot:setup-page)

The box opens a browser on `/setup`:

1. **Event name** — what crew see when they join. Changeable any time.
2. **Wi-Fi network** — the network crew join to reach the box, shown as
   join guidance. Leave blank if you don't know yet. Type it exactly: the
   iPhone app listens for alerts on the network with this name.
3. **Event PIN** — pre-filled with a freshly minted one; keep or change.
4. **Admin password** — also minted for you, shown **this once**.

> [!WARNING]
> **Write the admin password down now.** It is never shown again, and the
> setup page closes forever the moment the first person joins. If it's
> lost, get back in from the box itself: **Open the admin panel** in the
> Crewbox menu, or `crewbox --admin` ([below](#day-to-day)).

A **Networks** section appears when the machine has more than one network
adapter — pick which side the crew are on, and whether to listen to a
lighting network ([why you'd want to](/docs/lighting-live)). Everything
else on the setup page is editable later in [the admin panel](/docs/admin);
the network choices apply on the next start.

## The noticeboard: /connect

Saving setup lands on `/connect`: the join QR (with the PIN already in it),
the join URL as a tappable link, the PIN in print, and — once you've put
the Android app on the box — a download link for it. Leave it on a spare
screen, or print poster versions. Crew scan, pick a name, done.

The QR also names the event and carries its key, so the phone apps check
that the box at its address is this one before a PIN goes to it; a phone's
own camera ignores them. That makes it a denser code than the address alone:
print it from `/connect` at the size the page draws it or bigger. Posters
printed before this version still work, without the check. Print them again
when the event starts afresh on another box ([below](#data-backup-updates)).

The box's own terminal prints the same thing, QR included, for headless
machines.

## Day to day

```sh
crewbox --status   # is it running, on what address, with which PIN
crewbox --admin    # a link that opens the admin panel once, no password
crewbox --stop     # stop it — works over SSH, works headless
```

- **macOS**: a menu-bar item beside the clock — the event, the join link,
  copy-the-PIN, **Open the admin panel**, and **Stop Crewbox and quit**. No
  Dock icon; it's a server.
- **Windows**: the same menu in the system tray.
- **Linux**: Ctrl-C in its terminal, or `crewbox --stop`.

**Open the admin panel** opens the panel already unlocked, so a lost admin
password is never the end: get in, then set a new one under **Admin → This
box**. Each link works once, and only someone logged in on the box can get
one — the menu and `--admin` read it from the box's data directory, which
nobody on the network can. From another device, run `crewbox --admin` on the
box (over SSH, say) and open the second link it prints. Setting the
`ADMIN_PASSWORD` environment variable and restarting still works too, and
overrides the stored password for as long as it is set.

A second copy of the box refuses to start while one is running — it can't
steal the port or hurt the live one. Stop the old one first (`--stop`),
including when upgrading: running programs can't be overwritten.

## Serving the Android app

Drop the `crewbox-*.apk` file into the box's data directory (`~/.crewbox/
data`) and it's served at `/crewbox.apk` — the `/connect` page starts
offering it automatically. The URL never changes, so printed posters stay
valid across versions.

## Data, backup, updates

Everything lives in `~/.crewbox/data` — one directory to back up, one to
restore. **The box backs itself up every 6 hours**, ten minutes after it
starts and then on the clock: a WAL-safe database snapshot, the uploads, the
certificate and the Android APK. Choose where under **Admin → Backups**:
until you do, backups go to the data folder's own `backups`, which a dead
disk takes with it, so point it at a USB stick. **Back up now** takes one
there and then, and **Admin → This box** shows a **Backup** row saying how
long ago the last one was. **Admin → Box settings → Back up every** changes
the interval (`0` for none on a timer). A rig installed from source can still run
`deploy/backup.sh`, which writes the same thing.

To restore one by hand, on any platform: quit Crewbox, rename its data folder
out of the way, make a new empty one, copy everything inside the newest
backup folder into it, and start Crewbox again. `deploy/restore.sh` goes
the other way, onto the spare: it picks the newest backup that actually
finished and whose database reads, and passes over — out loud — any that
does not. A spare restored from a backup is the same event to every phone,
and they carry straight on: the backup carries the event's ID and the box's
signing key with everything else. At another address, phones check that key
before they follow the event there: put the spare on the old address, or
tell crew the new one to type. A box behind a port forward can't be checked,
and phones take its typed address at the crew member's word, and a QR shown
at the forward's address names no event, so phones join from it the same
way; one restored
from a backup older than its key fails the check, and phones say so and send
it nothing. One started with a fresh database is a new
event: phones say the box has changed and send it nothing, and the phone
apps refuse the old event's posters there, so print its own from `/connect`. When it takes
over from the event's box, say so in **Admin → This box → Carries on
another event**, and each phone that has the event, once it has joined,
offers to bring its documents, running order and unsent messages across
([what crew see](/docs/getting-connected#more-than-one-event)). The chat
history is only in a backup. Updating
the box is: stop it, replace the binary (or app), start it. Crew phones
notice the new version and offer a **Reload** pill; nothing they had queued
is lost.
