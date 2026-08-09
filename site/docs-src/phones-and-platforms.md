---
title: Phones and platforms
section: Running the box
order: 40
blurb: What each platform genuinely can and can't do — Android's lock-screen alerts, iOS's honest limit, the desktop helpers.
---

# Phones and platforms

The web app runs everywhere. The native apps exist for the things a browser
can't do — and one thing no app can do, stated plainly so nobody promises
it to a stage manager.

## The capability table

|                                   | Browser / installed web app | Android app | iOS app             |
| --------------------------------- | --------------------------- | ----------- | ------------------- |
| Chat, patch, lighting, network    | yes                         | yes         | yes                 |
| Works offline                     | yes                         | yes         | yes                 |
| Voice: listen                     | yes                         | yes         | yes                 |
| Voice: talk on plain HTTP         | no — needs HTTPS            | **yes**     | **yes**             |
| Alerts, app open                  | yes                         | yes         | yes                 |
| Alerts, phone locked, no internet | no                          | **yes**     | **no — impossible** |

## The Android app

The one with a superpower: a small always-on service holds its **own**
connection to the box and raises notifications while the phone is locked —
mentions and DMs buzz hard, ordinary messages quietly — entirely on the
LAN, no internet, no push service. Give Android phones to the roles that
must not miss a call.

It's distributed from the box itself: the operator drops the APK into the
box's data directory and `/connect` offers it
([how](/docs/run-the-box#serving-the-android-app)). First run asks for
notification permission and to be excused from battery optimisation — say
yes to both, that's the superpower asking.

Sideloading means Android warns about "unknown apps" once; that's the
price of installing from your own box instead of a store.

## The iOS app

Native microphone permission, so **voice talk works over plain HTTP** —
the main reason it exists. But read the last row of the table again:

> [!WARNING]
> **A locked iPhone on an offline network cannot be alerted.** Apple
> notifications go through Apple's servers, which an offline event network
> can't reach — no app can work around this. In-app sounds work while the
> app is open. Don't promise lock-screen alerts on iOS; hand the on-call
> radio roles an Android.

## Native join: the server field

Both phone apps show one extra field on the join screen — **Crew server** —
because unlike a browser, the app doesn't know which box it belongs to.
It's on the join poster, or baked into the QR so scanning fills it in.

## Desktop helpers

- **macOS**: the box runs as a menu-bar item — event name, join link, copy
  the PIN, open the QR page, stop. Deliberately no Dock icon.
- **Windows**: the same menu from the system tray; double-click opens the
  join page.

Both are conveniences for the machine _running_ the box; crew on laptops
just use the browser.
