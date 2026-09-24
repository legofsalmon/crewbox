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

Nothing from your phone goes anywhere but the box. The box needs no internet
and works the same without it. When it does have internet it makes the few
requests below, and nothing else. If the operator sets up a remote support
tunnel, connections through it are marked — that's the `office` badge in the
DM list.

**One request a day, if the box has internet at all.** A box asks GitHub
whether a newer crewbox exists, so the admin panel can say so. That request
carries this box's IP address, as any request does, and the version it is
running, as its `User-Agent` (`crewbox/1.0.0+abc1234`) — that is how it can
be told a newer one exists. Nothing else: no event name, no crew, no message
counts, no identifier. The reply is a version number and a link. Nothing is downloaded or installed unless an
admin asks for it, twice. `CREWBOX_UPDATE_CHECK=0` stops the box asking at
all; see [Updating the box](/docs/updating).

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

These go to LeTissier Creative Studios at letissier.ie and nowhere else — no
analytics or crash-reporting company. `CREWBOX_UPDATE_CHECK=0` stops the box
making any outbound connection; reports then stay on the box.

## What the box says on the crew network

So the phone apps can find it, a box announces itself on the crew network
the way a printer does (multicast DNS, often called Bonjour). Anyone on
that network can hear it, and it says only what the join screen already
shows anybody who reaches the box: the event's name, the box's version,
whether it has been set up, the name on its certificate, and the event's
ID, a random string that tells one event's box from another's. Never a
PIN, a password or the Wi-Fi's. It is not announced on a lighting or media
network the box listens to, and it never leaves the venue. An admin can
turn it off under **Admin → This box**.

The phone apps listen for it only while their join screen or **Your boxes**
is open. The question they put to the network, which boxes are here, says
nothing about you beyond the phone's own address on the Wi-Fi, as anything
it sends does.

## What the network module listens to

The [Network audit](/docs/network) grades networks by **passive
listening** — it reads what's already broadcast on the wire (DMX frames,
clock announcements, device advertisements) and transmits nothing. The one
exception, the admin-triggered deep probe, prints every packet it sent,
verbatim, in its results. Two numbers involve crew devices:

- Each phone reports its own Wi-Fi round trip to the box, once a minute:
  one number, no identity attached beyond the connection it rode in on,
  kept as minute-averages for about seven days.
- Connection counts — how many devices are on, not who.

## The formal bit

The full privacy policy — written for the app stores, covering the same
facts in their language — is at
[/docs/privacy-policy](/docs/privacy-policy).
