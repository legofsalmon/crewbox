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

|                                   | Browser / installed web app | Android app           | iOS app             |
| --------------------------------- | --------------------------- | --------------------- | ------------------- |
| Chat, patch, lighting, network    | yes                         | yes                   | yes                 |
| Works offline                     | yes                         | yes                   | yes                 |
| Voice: listen                     | yes                         | yes                   | yes                 |
| Voice: talk on plain HTTP         | no — needs HTTPS            | **yes**               | **yes**             |
| Alerts, app open                  | yes                         | yes                   | yes                 |
| Alerts, phone locked, no internet | no                          | **yes**               | **no — impossible** |
| Exports and file downloads        | downloads to the device     | Downloads, then Share | the share sheet     |

The last row is worth a paragraph. A WebView has no download handler, so
the ordinary "save this file" path does nothing at all inside either app —
it used to do nothing _and say it had worked_. Now each app does what its
phone expects:

- **Android** saves the file to the phone's Downloads folder, then offers
  **Share** at the foot of the screen for a few seconds, for sending it on.
  Android 9 and older have no shared Downloads an app may write to without a
  permission, so there the phone asks where to save it.
- **iPhone** opens the share sheet. **Save to Files** keeps it on the phone,
  and the rest send it on: what somebody does with a network audit at a
  venue is send it to the venue's IT. An iPhone only shares within a few
  seconds of the tap, so if a report took longer than that to build, it
  waits at the foot of the screen with a **Share** button for a fresh tap.

If a device cannot take the file at all, the app says so rather than
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

Scanning the join poster asks to use the camera the first time, and **Take
a photo** in the attach menu needs the same yes. Say no and both stop, and
each says so with an **Open Settings** button, which goes to Crewbox's page
in Settings: allow it again under Permissions → Camera. Android stops
asking once somebody has said no twice, so Settings is then the only way
back.

Sideloading means Android warns about "unknown apps" once; that's the
price of installing from your own box instead of a store.

## The iOS app

Native microphone permission, so **voice talk works over plain HTTP** —
the main reason it exists. But read the last row of the table again:

> [!WARNING]
> **A locked iPhone on an offline network cannot be alerted.** Apple
> notifications go through Apple's servers, which an offline event network
> can't reach — no app can work around this. Alerts sound and show a banner
> while the app is open. Don't promise lock-screen alerts on iOS; hand the
> on-call radio roles an Android.

One rule about addresses, which iOS enforces inside the phone: **the iPhone
app uses plain HTTP only with an IP address** like `192.168.8.1`, a `.local`
name, or a one-word name like `crewbox`. A box without a certificate
advertises its IP address, so its poster and QR already work. What doesn't
is a name the network knows the box by, like `crewbox.lan`, typed without
`https://`: iOS refuses to send anything to it, and the join screen says so
rather than trying. A name needs the box to have a certificate for it (see
[HTTPS, names and certificates](/docs/https-and-voice)), and `https://` in
front.

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
It's on the join poster, and **Scan the join poster** reads the poster's QR
with the phone's camera and fills in the field and the event PIN. The phone
asks whether Crewbox may use the camera the first time. The scan happens on
the phone, which sends what it read nowhere, and a QR that isn't a box's
join code fills in nothing. On an iPhone, a name in the field needs
`https://` in front; an IP address doesn't ([why](#the-ios-app)).

The same button reads a Wi-Fi network's QR code, the kind printed on a
router's label or shown by a phone sharing its Wi-Fi, and asks the phone to
join that network. The phone asks you first: an iPhone asks whether Crewbox
may join it, and Android 11 and later show their own screen asking whether
to save it, naming the app. Once saved it is one of the phone's own
networks, as if typed into its Wi-Fi settings, and the phone goes back to it
by itself, though an iPhone forgets it if the app is deleted. The iPhone app
then checks that the phone got on it, which iOS lets an app see only for a
network that app added. WEP networks, ones where each person signs in with
their own username, and codes that give the password as a 64-digit key are
left to the phone's Wi-Fi settings, and so is Android 10 and older, which
can't add a network for an app without a permission Crewbox doesn't ask
for.

Set the crew Wi-Fi to WPA2/WPA3 rather than WPA3 alone. A phone without
WPA3 can't join a WPA3-only network at all, and Apple doesn't say whether an
app can join one on an iPhone.

Above the field, the apps list the boxes on this Wi-Fi, which announce
themselves ([Admin → This box](/docs/admin)), and picking one fills the field
in after asking that box which event it runs. The apps look only while that
screen or **Your boxes** is open, and while they can't reach their box, to
find it if it has moved. An iPhone asks once whether Crewbox may find
devices on your local network: the list needs a yes, and the field works
either way. A browser can't look for boxes, so the join page there is
unchanged.

A `crewbox://join` link fills in the same two fields, and opens the app to
do it: `crewbox://join?server=192.168.8.1&pin=4821`. Join is still yours to
press. A link for another box, while the app is signed in to one, opens
**Your boxes** with that box's address ready to **Connect**, and its join
form then has the PIN. The app asks nothing of any box until you press one
of those.

On a phone, the join page in the browser offers **Open in the Crewbox app**:
the same link, for that box and the PIN in its field. That is the way in from
a message. Most messaging apps leave a `crewbox://` link as plain text but
make a web address tappable, so send the address under the QR on `/connect`,
which opens the join page. A phone without the app can't follow the link: an
iPhone says Safari can't open the address, and an Android phone goes to the
box's `/connect` page, which offers the app when the box has it.

## Desktop helpers

- **macOS**: the box runs as a menu-bar item — event name, join link, copy
  the PIN, open the QR page, stop. Deliberately no Dock icon.
- **Windows**: the same menu from the system tray; double-click opens the
  join page.

Both are conveniences for the machine _running_ the box; crew on laptops
just use the browser.
