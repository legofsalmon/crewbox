---
title: Live DMX on the plot
section: Lighting
order: 30
blurb: The live bar, the Levels toggle, and reading what the desk is actually sending.
---

# Live DMX on the plot

When the box is listening on the lighting network, the plot stops being
paperwork alone: every fixture's row shows whether data is reaching its
address, and the drawings can dim and colour by what the desk is sending.
The box only ever **listens** — it never transmits on a lighting network.

## The live bar

Above the tabs, the live bar reports plainly:

- **"Not watching a lighting network"** — the box isn't listening at all.
  That's an operator setting (**Admin → Lighting network**), not something
  in the plot.
- **"Listening, but none of this plot's universes has been heard"** — the
  box is on the network but this plot's addresses have seen nothing.
- **"● Live — 12 receiving · 4 nothing sent · 1 universe not heard, since
  18:42"** — the working state, counted fixture by fixture.

It also warns when **two sources** are fighting over one universe, and when
the rig is being **held for sync** or has **frozen on its last look** —
each in those words.

## Fixture dots

In the fixtures list, each row's live dot answers one question — is
anything being sent to this fixture's addresses?

- **Receiving** — data is arriving there.
- **Nothing sent since the box started listening** — the network is fine;
  the desk simply hasn't sent to those addresses.
- **Universe not heard at all** — that whole universe is silent.

The wording is deliberate: the box can see the network, not the rig. A
fixture can be "receiving" and hang dead (lamp off, data cable unplugged
after the node) — the dot narrows the search, it doesn't replace looking.
Where a profile identifies the dimmer channel, the verdict sharpens to "by
dimmer"; without one it falls back to any activity in the footprint.

## The Levels toggle

The drawings don't show desk output until you switch **Levels** on in the
live bar — levels are the expensive half of watching, so they're opt-in per
device. With it on:

- **Plan/Front**: each fixture dims with its real dimmer level and gets a
  halo in the colour the desk is asking for.
- **3D**: moving heads with profiles grow beam cones aimed by live
  pan/tilt.
- The status dot **keeps its rigging colour** — a plot is paperwork first
  and a monitor second; live data changes the drawing, not your checklist.

## The channel readout

Select a fixture whose type has a GDTF profile and a channel-by-channel
table appears under the drawing: address, channel name, value, raw DMX.
Values are translated by the profile — "Dimmer 60%", "Pan 135°", "Colour:
Congo", "Strobe 18.1 Hz" — with swatches for colours and per-cell names on
multi-cell fixtures.

No profile, no table: crewbox won't guess what channel 7 of an unknown
fixture means. Profiles arrive with MVR import —
[the import page](/docs/lighting-import) shows exactly what each route
unlocks.
