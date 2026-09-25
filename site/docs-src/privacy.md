---
title: Privacy and your data
section: Reference
order: 40
blurb: What the box stores, the little that leaves the venue and when, and what the network module listens to.
---

# Privacy and your data

Crewbox's privacy story is architectural, not promised: there is no company
server. Everything runs on the box the event's organiser operates, on the
event's own network.

## Where your data lives

Everything you type, send or upload is stored **on the box** — messages,
files, your name and PIN (the PIN as a hash, not the number). So are the
patch sheets, plots and screen maps that pass through it, so that somebody
who opens one later gets it from the box. Your own device keeps a working
copy so the app opens offline.

Your device also keeps your sign-in to each event, the key the box gave it
when you joined, so that it opens signed in. In a browser that is the page's
own storage. The apps keep it in the phone's: the iPhone's Keychain, and on
Android a file sealed with a key held by the phone's Keystore. Either way
it stays on that phone. A new phone set up from the old one's backup
doesn't bring your sign-ins, whatever else comes across, and you sign in to
each event again with your name and PIN. Nor does an Android phone set up
straight from the old one. An iPhone set up straight from the old one, side
by side with Quick Start, may bring them: Apple's documentation doesn't
say, and other developers have reported what their apps kept this way
arriving on the new phone.

Earlier versions of the apps kept the sign-in in the page's storage, so a
backup made before you updated has it. The updated app moves it into the
phone's, and the next time the phone reaches the box, the box swaps it for
a new one. From then on, the one in the backup signs nothing in.

The apps also keep a note of the events your phone has joined: each one's
name, where its box was, and the key your phone checks that box by. It is in
files of the app's own, so that your phone still knows them, and stays
signed in, if the app's web storage is cleared, which iPhones and Android
phones can both do by themselves. The note holds no sign-in. It is left out
of backups and transfers to a new phone, though on an iPhone that is only
guidance to iOS, so a new iPhone set up from the old one may bring it.

Messages and show-log entries you write while your phone can't reach the
box wait on the phone until it can. The apps keep them in those files too,
so that none is lost if the web storage is cleared before it has gone, and
delete each one there once the box has it. Signing out deletes them, and so
does forgetting the event on the Boxes screen. They are left out of backups
in the same way as the note.

Deleting a sheet, plot or screen map deletes it from the box too. The box
overwrites what it held rather than only marking the space free, and never
saves it again, though the SD card or disk underneath can keep an old copy
of a block it has moved, as it can of any file. Each device that had a copy
deletes it the next time it opens that list, once it has heard of the
delete. A backup of the box made before the delete still has it.

The makers of Crewbox never receive your messages, files or name, and track
nothing. When the event ends, the data is wherever the box's operator put
it — typically an export in the production archive — and deleting your
account removes your identity from the box.

## What leaves the venue

Nothing from your phone goes anywhere but the box, or, for voice, a voice
server of the operator's own if they have set the box up to use one. The
box's own voice server tells phones to ask nobody else how to reach it. A
voice server run elsewhere hands phones its own list of servers to ask, and
a LiveKit server given no list of its own sends each phone joining voice to
Google's and Twilio's public STUN servers to learn its internet address.

Scanning the join poster in the apps reads the QR code on the phone, and
neither the picture nor what it read goes anywhere. Before joining from it,
the app asks the box at the poster's address to sign a random challenge,
which is all it sends there until the box has shown it is the poster's. The iPhone app uses
Apple's own scanner, and the Android app the open-source ZXing, rather than
Google's ML Kit, which reports its use to Google.

A Wi-Fi network's QR code, scanned in the apps, goes to the phone's own
Wi-Fi settings, which ask before joining it, and its password stays there.
The iPhone app then asks iOS which network the phone is on, which iOS
answers only for a network the app added itself. The app doesn't ask for
your location, and learns nothing of the phone's other networks. The Android
app learns only whether the network was saved.

The box needs no internet and works the same without it. When it does have
internet it makes the few requests below, and nothing else. If the operator
sets up a remote support tunnel, connections through it are marked — that's
the `office` badge in the DM list.

**One request a day, if the box has internet at all.** A box asks GitHub
whether a newer crewbox exists, so the admin panel can say so. That request
carries this box's IP address, as any request does, and the version it is
running, as its `User-Agent` (`crewbox/1.0.0+abc1234`) — that is how it can
be told a newer one exists. Nothing else: no event name, no crew, no message
counts, no identifier. The reply is a version number and a link. Nothing is downloaded or installed unless an
admin asks for it, twice. `CREWBOX_UPDATE_CHECK=0` stops the box asking at
all; see [Updating the box](/docs/updating).

**A check that the internet works, when the box starts and when an admin
asks.** So the admin panel can say whether the box has internet, and whether
a venue login page is in the way, the box opens a connection to 1.1.1.1 or
8.8.8.8 (Cloudflare's and Google's public addresses) and asks Google for the
empty page Android phones use for the same test
(`connectivitycheck.gstatic.com/generate_204`). The connection carries
nothing. The request says it comes from a Node.js program and, as any
request does, carries this box's IP address. It runs when the box starts,
when an admin presses **Check again**, and when an admin runs the
[Network audit's](/docs/network) deep probe.

**The box's licence, if it has internet.** A licensed box checks in with
letissier.ie about once a day when it can: the licence key, an id for the
machine, and the product. Nothing about the event or the crew. A box that
never has internet can be licensed offline and never checks in at all.

**Crash reports, only if the organiser says yes.** After the box crashes, the
admin panel asks once before sending anything, and "Send crash reports
automatically" starts off. A report carries the Crewbox version, the
operating system, a random id for this install, and the error and its stack
trace with home folders, user names, network addresses and web-address query
strings removed on the box. Never messages, names, files or the event. If a
screen on your phone breaks, the same kind of report goes only if you press
**Send report**, and it goes via the box.

**Feedback you choose to send.** "Send feedback…" sends the type and message
you wrote, the Crewbox version and platform, and your email only if you typed
it. It goes via the box.

The licence check, reports and feedback go to LeTissier Creative Studios at
letissier.ie and nowhere else — no analytics or crash-reporting company.
`CREWBOX_UPDATE_CHECK=0` stops the box making any outbound connection;
reports then stay on the box.

One question stays on the venue's network. To check crew phones can find the
box by the name on its certificate, the box looks that name up in the
network's own DNS when it starts and when an admin asks. Whether that DNS
server asks anyone else is up to whoever runs the network.

## What the box says on the crew network

So the phone apps can find it, a box announces itself on the crew network
the way a printer does (multicast DNS, often called Bonjour). Anyone on
that network can hear it, and it says only what the join screen already
shows anybody who reaches the box: the event's name, the box's version,
whether it has been set up, the name on its certificate, and the event's
ID, a random string that tells one event's box from another's. A box an
admin has said carries on another event gives that event's ID too. Never a
PIN, a password or the Wi-Fi's. It is not announced on a lighting or media
network the box listens to, and it never leaves the venue. An admin can
turn it off under **Admin → This box**.

The phone apps listen for it only while their join screen or **Your boxes**
is open, and while they can't reach their box. The question they put to the
network, which boxes are here, says nothing about you beyond the phone's own
address on the Wi-Fi, as anything it sends does. A box found claiming an
event you hold at a new address is asked to prove it is that event's box,
with a random challenge, before anything else goes to it.

## What the network module listens to

The [Network audit](/docs/network) grades networks by **passive
listening** — it reads what's already broadcast on the wire (DMX frames,
clock announcements, device advertisements) and transmits nothing. The one
exception, the admin-triggered deep probe, prints every packet it sent,
verbatim, in its results. Three kinds of number involve crew devices:

- Each phone reports its own Wi-Fi round trip to the box, once a minute:
  one number, no identity attached beyond the connection it rode in on,
  kept as minute-averages for about seven days.
- A phone on voice reports how the calls it hears sound, every 15 seconds:
  how much of the audio was lost, how unevenly it arrived, and how much its
  decoder had to fill in, for whichever call was worst. Kept the same way,
  with how many phones reported in each minute and nothing to say which.
- Connection counts — how many devices are on, not who.

## The formal bit

The full privacy policy — written for the app stores, covering the same
facts in their language — is at
[/docs/privacy-policy](/docs/privacy-policy).
