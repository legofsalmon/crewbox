---
title: Network audit
section: Network
order: 10
blurb: Three graded networks, the history behind every finding, the admin deep probe, ST 2110 checks, and the report for venue IT.
---

# Network audit

The **Network** module answers one question continuously: _is this site's
networking good enough for A/V — and if not, what exactly is wrong and what
is the fix?_ Everyone on the crew can see it; it grades from what the box
passively hears, and it transmits on a show network only when an admin
runs the [deep probe](#the-deep-probe).

## The three cards

![The three network cards, graded](shot:network-cards)

- **Crew network** — the Wi-Fi the crew's phones are on: connections, and
  the round trip crew phones actually experience (each phone reports its
  own median once a minute — the box can't measure your Wi-Fi from where
  it sits).
- **Lighting network** — what the DMX listener hears: frames arriving,
  loss, refresh rate, competing sources, sync health.
- **Audio & media network** — PTP clocking, Dante/NDI/NMOS rosters, stream
  announcements, when the box is watching them. On an ST 2110 rig it also
  checks each announced stream's SDP file, and the video clock against
  SMPTE ST 2059-2.

Each card wears a grade: **Good for A/V · Usable — fixes below · Not
suitable right now · Not watched**. "Not watched" is an honest state, not a
fault — the box wasn't told to listen to that network, and the card says
what would change that. An unwatched network never drags the overall verdict
down.

## Findings and sparklines

Inside each card, findings use the same vocabulary as the rest of crewbox
(Working / Limited / Fault / For information), each with a plain sentence
and — where it isn't fine — the fix: "Slow Wi-Fi, not a slow box: add an
access point near the stage, and get crew phones off the venue guest SSID."

Where history backs a finding, a **sparkline** draws the last hour beside
it — the shape (steady, sagging, spiky) is usually more diagnostic than the
number. The box keeps about seven days of minute-by-minute history, so the
picture survives restarts and power cuts.

## The event strip

A 24-hour tick strip: red marks for faults (an outage, a frozen rig, a
device disappearing), amber for changes, with the most recent spelled out in
words below. This is the "it was fine until 17:40" view — pair a complaint
("comms dropped during changeover") with what the network was doing at that
minute. A quiet strip says so: "No events in the last 24 hours — a quiet
network."

## The deep probe

![Deep probe results, each with its verbatim sent line](shot:network-probe)

Everything above is passive. The one exception is the **deep probe** — a
single admin-triggered sweep that checks the internet uplink, venue DNS,
sends **one** Art-Net poll and **one** mDNS query, reads the NMOS registry
if there is one, and stops. Every packet it sends is listed in the results
**verbatim**, so a strict venue can verify the claim against a capture; for
the registry, that is how many requests went to which devices. A box set to
make no outbound connections (Admin → Box settings) skips the uplink check
and sends nothing for it. Only an unlocked admin device shows the **Run
deep probe** button; the results are visible to everyone.

The registry is the one the mDNS query finds, or the one named in Admin →
Box settings → **NMOS registry** when it doesn't announce itself. The probe
only reads it, as any NMOS controller does, and lists what it found wrong
with what is registered, one line each, naming the device to fix it at.

If your venue forbids any transmission on the show networks: simply don't
run it. Nothing else in the module transmits.

## Checking SDP files and captures

Two tools at the bottom of the page check ST 2110 files on your own device,
with the same checks the box runs. The file goes nowhere, the box
included, and they work even while the box doesn't answer.

- **Check an SDP file** — paste one, open one, or drop one on the panel.
  It comes back line by line, with each problem under the line it's about:
  a **fault** is something a receiver would refuse or misread, a
  **warning** is worth a look, and each names the standard behind it.
- **Check a capture** — choose a pcap or pcapng file from Wireshark or
  tcpdump and, if you have them, the SDP files of the streams in it. Each
  RTP flow is measured as SMPTE RP 2110-25 describes (packet timing,
  latency, the ST 2110-21 sender models), the PTP messages are followed,
  and every fault is listed with its flow and when it first happened. It
  runs in the background, so the page stays usable while a big capture is
  read. Up to 1 GB: cut a bigger one down with Wireshark's `editcap` first.

The first check fetches the checks from the box, a few hundred kilobytes;
after that they work offline.

## The HTML report

**Download HTML report** produces a single self-contained file — findings,
grades, charts, the event log, the probe's verbatim send-list — that opens
anywhere with no internet and prints cleanly. It's built to be handed to
venue IT or attached to the post-event report: the good and the bad, with
evidence.

**Share to channel** posts the audit into chat as an **Open ↗** chip, for
"have a look at this" moments.
