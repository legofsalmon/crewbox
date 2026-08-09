---
title: Glossary
section: Reference
order: 20
blurb: The words crewbox uses — especially the ones that mean two things.
---

# Glossary

Sound, lighting and chat vocabulary collide constantly — "channel" alone
means three different things in this app, all visible in one sidebar. When a
page seems to be talking nonsense, check which meaning it's using.

## The collisions

**Channel** — three meanings. In **chat**, a room: `#stage`, `#foh`. In a
**patch sheet**, a numbered input on the desk: channel 1 is the kick mic. In
**lighting**, a slice of DMX: a fixture "needs 16 channels". Chat channels
have a `#`; the other two are always numbers.

**Input** — in a patch sheet, both the **house input** (what lives on that
channel all day, written in the channel row) and an **act's input** (what
that act puts there instead, written in their column). An act's input
overrides the house input for their set. In **voice settings**, your
microphone.

**Patch** — the noun ("the master patch" — the whole channels × acts grid),
the derived table ("the stage patch" — what's plugged where on stage), and
lighting's meaning (which DMX address each fixture answers to). The module
called **Patch Sheets** is the sound one.

**Position** — in **lighting**, a place fixtures hang: a truss, a boom, the
floor. In a **patch sheet's** sub-box settings, where the box sits on stage
(USC, DSR…). Same word, same stage, different modules.

## Patch sheets

**Sub-box / sub-snake** — a small stage box (often colour-named: PINK,
BLUE) whose tails carry a group of channels to one part of the stage.
Declared in the Boxes dialog; referenced from grid cells.

**"PINK 3"** — the cell syntax that drives the stage patch: this channel
arrives on **tail 3** of the sub-box named **PINK**. Type it in the Sub-box
column of the grid.

**Stage patch** — the per-act, box-by-box view of what's plugged where.
Derived entirely from the grid — nobody types it separately.

**House input** — what's on a channel all day regardless of act (the row's
own input field). An act's column overrides it.

**Changeover** — the gap between two acts' sets. The lineup shows the gap
the set times imply, and lets you write the _agreed_ changeover next to it —
and warns when the two disagree, because only the person holding the running
order knows which is right.

**Version** — a named snapshot of a sheet ("After soundcheck") you can
restore later. Restoring replaces the sheet's content (and can itself be
undone).

## Lighting

**Plot** — one rig, drawn: its fixtures, their positions, and the paperwork
around them. What the Lighting module edits.

**Fixture** — one light. A row in the fixtures list; a symbol on the
drawings.

**Universe** — one run of DMX, 512 channels. Big rigs use several; a
fixture's address is universe + channel ("U2 @ 17").

**Footprint** — how many DMX channels a fixture occupies in its current
mode. Determines whether two fixtures clash.

**Trim** — the height a truss or bar is flown to, in metres. Set per
position; the Front and 3D views draw with it.

**GDTF / MVR** — fixture-description and rig-exchange file formats. An MVR
import brings real profiles (GDTF) with it, which is what unlocks the
channel-by-channel readout, beam drawing and accurate footprints. A CSV
import brings none of that — the lighting import guide has the honest
comparison.

**sACN / Art-Net** — the two protocols desks use to send DMX over a
network. The box can listen to either (listen only — it never transmits on a
lighting network).

## The rest

**The box** — the crewbox program running on a machine at the event. Serves
the app, stores everything, runs voice. When these docs say "the box", they
mean that machine.

**Event PIN / Your PIN / Admin password** — the three codes, explained in
[Getting connected](/docs/getting-connected#the-three-codes-untangled).

**On-site / office** — someone joining from the event network is on-site; a
name in the DM list marked `office` is connected from somewhere else (over a
tunnel or from off the LAN).

**PTT (push-to-talk)** — hold to speak, release to stop. The voice
intercom's normal mode; there's a latch for gloved hands.

**PWA** — the app installed to your home screen from the browser. Same app,
own icon, works offline.

**PTP / Dante / NDI / AES67** — clocking and media-over-network systems the
**Network** module can watch on the audio/media network. If none of that is
on your network, that card simply says "Not watched".
