---
title: Importing rigs
section: Lighting
order: 40
blurb: CSV from Lightwright or a console, MVR with GDTF — and exactly what each route unlocks.
---

# Importing rigs

Rigs arrive as files: a Lightwright export, a console patch dump, or an MVR
from the designer's software. Drop any of them onto an open plot (or use
**Import**) and crewbox reads what it can. The honest headline: **CSV gets
you the list; MVR gets you the rig.**

## CSV

Crewbox matches CSV headers **by meaning**, not by exact name — circuit /
ckt / cct, universe / uni, address / addr / patch / dmx, channel / chan /
ch, footprint / chancount, mode / dmxmode, and friends — so Lightwright,
Eos, grandMA and Hog exports all come through without editing the file.
Positions named in the file are created automatically. The import summary
names any columns it didn't recognise, so nothing is silently dropped.

## MVR (with GDTF inside)

An MVR carries the rig's _geometry and identity_, not just its list. The
import reads:

- **Real 3D positions** — layers become positions, and where fixtures
  actually line up, they're drawn along a fitted bar in true order. Group
  layers that aren't physical bars ("Spots") become groupings without a
  drawn bar rather than fake trusses.
- **GDTF profiles** — the manufacturer's own description of each fixture:
  authoritative footprints, channel maps, watts, weight, physical size,
  beam angles.

Large MVRs take a moment; the UI says "Reading…" rather than freezing
silently.

## On a phone

**Import CSV / MVR** opens the phone's own file picker, in either app or a
phone's browser. In the apps, and in any browser on an iPhone, the picker
offers every file rather than only rig files, because the phone has no file
type for an MVR to narrow it down by. On an iPhone that means the photo
library and the camera are offered too: tap **Choose File** for your
files. Choose something that isn't a CSV or an MVR and crewbox says so.

A phone won't import a file over **100 MB**. An import holds the whole file
in memory while it reads it, and a phone that runs out doesn't just fail
the import: the app closes or starts over. Import a file that big on a
computer instead: the plot reaches every phone on the box from there.

## What each route unlocks

| Capability                               | CSV                                   | MVR + GDTF                   |
| ---------------------------------------- | ------------------------------------- | ---------------------------- |
| Fixture list, addressing, clash warnings | yes                                   | yes                          |
| Positions created                        | named only                            | with real geometry and order |
| Accurate footprints per mode             | if the file has them                  | from the profile             |
| Watts / weight placeholders              | if the file has them                  | from the profile             |
| Truss-length estimates                   | widths assumed                        | widths from profiles         |
| Live verdict "by dimmer"                 | no — falls back to footprint activity | yes                          |
| Channel-by-channel readout               | no                                    | yes                          |
| Colour haloes and 3D beams               | no                                    | yes                          |

This table is the answer to "why does that plot show more than mine": the
difference is never a setting, it's whether the fixtures carry profiles.

> [!NOTE]
> You can have both: import the MVR for geometry and profiles, then paste
> or type the day-to-day changes. When the designer sends the MVR again,
> import it again: the fixtures it brought last time are updated in place,
> keeping the crew's status and notes, and any the new file no longer has
> are left where they are and counted in the summary. A CSV imported again
> adds its fixtures a second time.

## Out again

**Export** downloads the plot as CSV — the list, addressing, positions and
notes — readable by the same tools the rig came from.
