---
title: Network audit
section: Network
order: 10
blurb: Three graded networks, the history behind every finding, the admin deep probe, and the report for venue IT.
---

# Network audit

The **Network** module answers one question continuously: _is this site's
networking good enough for A/V — and if not, what exactly is wrong and what
is the fix?_ Everyone on the crew can see it; it grades from what the box
passively hears, and it never transmits on a show network.

## The three cards

- **Crew network** — the Wi-Fi the crew's phones are on: connections, and
  the round trip crew phones actually experience (each phone reports its
  own median once a minute — the box can't measure your Wi-Fi from where
  it sits).
- **Lighting network** — what the DMX listener hears: frames arriving,
  loss, refresh rate, competing sources, sync health.
- **Audio & media network** — PTP clocking, Dante/NDI rosters, stream
  announcements, when the box is watching them.

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

Everything above is passive. The one exception is the **deep probe** — a
single admin-triggered sweep that checks the internet uplink, venue DNS,
sends **one** Art-Net poll and **one** mDNS query, and stops. Every packet
it sends is listed in the results **verbatim**, so a strict venue can verify
the claim against a capture. Only an unlocked admin device shows the **Run
deep probe** button; the results are visible to everyone.

If your venue forbids any transmission on the show networks: simply don't
run it. Nothing else in the module transmits.

## The HTML report

**Download HTML report** produces a single self-contained file — findings,
grades, charts, the event log, the probe's verbatim send-list — that opens
anywhere with no internet and prints cleanly. It's built to be handed to
venue IT or attached to the post-event report: the good and the bad, with
evidence.

**Share to channel** posts the audit into chat as an **Open ↗** chip, for
"have a look at this" moments.
