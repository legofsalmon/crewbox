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
  shut included.
- **Windows** — download the `.exe`, double-click. SmartScreen will warn
  about an unsigned app: **More info → Run anyway**. That means Windows
  hasn't seen the file before, not that something is wrong.
- **Linux, or macOS by one line**:

```sh
curl -fsSL https://crewbox.letissier.ie/install.sh | sh
```

Downloads the right binary, clears the macOS quarantine flag, starts it.

## First run: four questions

The box opens a browser on `/setup`:

1. **Event name** — what crew see when they join. Changeable any time.
2. **Wi-Fi network** — the network crew join to reach the box, shown as
   join guidance. Leave blank if you don't know yet.
3. **Event PIN** — pre-filled with a freshly minted one; keep or change.
4. **Admin password** — also minted for you, shown **this once**.

> [!WARNING]
> **Write the admin password down now.** It is never shown again, and the
> setup page closes forever the moment the first person joins. If it's
> lost, the supported way back in is setting the `ADMIN_PASSWORD`
> environment variable and restarting the box.

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

The box's own terminal prints the same thing, QR included, for headless
machines.

## Day to day

```sh
crewbox --status   # is it running, on what address, with which PIN
crewbox --stop     # stop it — works over SSH, works headless
```

- **macOS**: a menu-bar item beside the clock — the event, the join link,
  copy-the-PIN, and **Stop Crewbox and quit**. No Dock icon; it's a server.
- **Windows**: the same menu in the system tray.
- **Linux**: Ctrl-C in its terminal, or `crewbox --stop`.

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
restore. Updating the box is: stop it, replace the binary (or app), start
it. Crew phones notice the new version and offer a **Reload** pill; nothing
they had queued is lost.
