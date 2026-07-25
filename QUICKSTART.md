# Crewbox — Quickstart

Three ways to run it, smallest first. In every case, crew join by scanning a
QR and picking a name — no accounts, no app store required (the web app works
in any phone browser; the Android app adds offline lock-screen alerts).

## 1. Try it on your laptop (2 minutes)

```bash
npm install
npm run dev        # server :8787, web :5173
```

Open http://localhost:5173, join with event PIN `1234`. Open a second
browser at http://127.0.0.1:5173 to be a second crew member.

## 2. Small event — the one-file box (5 minutes)

For club shows, one-stage festivals, or anywhere "good enough now" beats
"perfect later". No Node, no npm, nothing to install:

1. Download the binary for your machine from
   [Releases](https://github.com/legofsalmon/crewbox/releases)
   (Linux/Windows/macOS).
2. Run it on any machine on the venue network (a laptop is fine).
3. It prints the join URL, a freshly minted event PIN, and a QR — and
   `http://<that-machine>/connect` shows the same as a page you can leave
   open on a spare screen. Crew scan, pick a name, done.

The first person to join is the admin (channel management, event PIN,
Wi-Fi hint — all in the app). Drop `crewbox.apk` from the same release into
`~/.crewbox/data/` and the box serves it to Android phones at `/crewbox.apk`
and links it from `/connect`.

What you give up vs. the full box: no HTTPS (so no installable PWA or
browser mic — the native apps don't care), no push-to-talk voice, no
domain. Chat, patch sheets, files, and presence all work.

## 3. Full festival box

Dedicated hardware, HTTPS on your own domain with zero internet on site,
LiveKit push-to-talk voice, Android lock-screen alerts, printed posters,
UPS-and-spare-box discipline. This is `deploy/RUNBOOK.md` — read it well
before the event, do the cold-boot rehearsal it insists on.
