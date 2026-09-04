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

|                                   | Browser / installed web app | Android app     | iOS app             |
| --------------------------------- | --------------------------- | --------------- | ------------------- |
| Chat, patch, lighting, network    | yes                         | yes             | yes                 |
| Works offline                     | yes                         | yes             | yes                 |
| Voice: listen                     | yes                         | yes             | yes                 |
| Voice: talk on plain HTTP         | no — needs HTTPS            | **yes**         | **yes**             |
| Alerts, app open                  | yes                         | yes             | yes                 |
| Alerts, phone locked, no internet | no                          | **yes**         | **no — impossible** |
| Exports (CSV, reports, archives)  | downloads to the device     | the share sheet | the share sheet     |

The exports row is worth a sentence. A WebView has no download handler, so
the ordinary "save this file" path does nothing at all inside either app —
it used to do nothing _and say it had worked_. Both apps hand the file to
the system share sheet instead, which is the better answer anyway: what
somebody does with a network audit at a venue is send it to the venue's IT,
and that is one tap from the share sheet and several from a downloads
folder. If a device refuses to share the file, the app says so rather than
claiming a save.

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

## The "no internet" problem

Every phone tests a Wi-Fi network the moment it joins: it fetches one fixed
web address and checks the answer. An event network with no uplink fails
that test, and each platform reacts differently.

- **Android** shows an exclamation mark on the Wi-Fi icon and carries on.
  Annoying, harmless.
- **iOS** does not carry on. It drops the Wi-Fi symbol from the status bar
  and **moves traffic to mobile data**. The box is on a private address
  reachable only over the Wi-Fi the phone has just walked away from, so
  crewbox sits on **Connecting** forever — on a phone that is still joined
  to the network, showing full signal. It looks exactly like a broken box.

The box can settle this by answering those tests itself. Two things have to
be true, and the box's readiness list (**Admin → This box**, _Phones stay on
this Wi-Fi_) tells you which half is missing:

1. **Phones can reach the responder.** A packaged box tries port 80 at
   startup. Only root may have that port, so on a double-clicked Mac app it
   won't get it — and rather than give up, the box takes port 8880 and says
   so. One redirect rule then feeds it, and **Admin → This box** offers a
   **Download port 80 config** button with your adapter and address already
   filled in. On Linux the neater answer is
   `sudo setcap 'cap_net_bind_service=+ep' /path/to/crewbox` once, after
   which it takes port 80 directly and no redirect is needed — but **a
   capability belongs to the file, and a self-update replaces the file.** The
   first time the box updates itself the capability is gone and the probes go
   unanswered, silently. Either re-run `setcap` after every update, or use
   the redirect rule, which survives one. On the systemd rig neither applies:
   the shipped unit grants the capability to the service, which is a property
   of the unit and not of the binary.

   > [!NOTE]
   > Running the whole box with `sudo` also works, and is the wrong fix: it
   > leaves a process that accepts file uploads and serves untrusted crew
   > traffic running as root for the entire event, to hold one socket. The
   > redirect keeps the privilege in a one-off rule instead.

2. **The router's DNS points the test addresses at the box.** Download
   `crewbox-dns.conf` from **Admin → This network** and paste its second,
   clearly-marked optional block onto the router alongside the first.

> [!NOTE]
> Once both halves are in, phones stop warning that this network has no
> internet — because as far as they can tell, it now has one. That's the
> intent: crew on this network are talking to the box, not browsing. Nobody
> should be relying on the crew Wi-Fi for internet anyway.

One gotcha worth knowing if you go the `pf` route on macOS: it doesn't
redirect traffic the Mac sends to itself, so testing with `curl` on the box
fails even when the rule is working. Test from a phone.

Set `CREWBOX_CAPTIVE=0` to turn the responder off entirely. Without the DNS
half it does nothing regardless, except one small courtesy: typing the box's
name into Safari without `https://` lands on the app instead of a
connection error.

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
