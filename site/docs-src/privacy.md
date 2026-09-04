---
title: Privacy and your data
section: Reference
order: 40
blurb: What the box stores, what leaves the venue (nothing), and what the network module listens to.
---

# Privacy and your data

Crewbox's privacy story is architectural, not promised: there is no company
server. Everything runs on the box the event's organiser operates, on the
event's own network.

## Where your data lives

Everything you type, send or upload is stored **on the box** — messages,
files, patch sheets, plots, your name and PIN (the PIN as a hash, not the
number). Your own device keeps a working copy so the app opens offline.

The makers of crewbox operate no server, receive nothing, and track
nothing. When the event ends, the data is wherever the box's operator put
it — typically an export in the production archive — and deleting your
account removes your identity from the box.

## What leaves the venue

Nothing, in normal operation. The box needs no internet and the app phones
nobody home. The one optional exception: if the operator sets up a remote
support tunnel, connections through it are marked — that's the `office`
badge in the DM list.

**One request a day, if the box has internet at all.** A box asks GitHub
whether a newer crewbox exists, so the admin panel can say so. That request
carries this box's IP address, as any request does, and the version it is
running, as its `User-Agent` (`crewbox/0.18.0+abc1234`) — that is how it can
be told a newer one exists. Nothing else: no event name, no crew, no message
counts, no identifier. The reply is a version number and a link. Nothing is downloaded or installed unless an
admin asks for it, twice. `CREWBOX_UPDATE_CHECK=0` stops the box asking at
all; see [Updating the box](/docs/updating).

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
