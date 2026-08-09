---
title: Lighting plots
section: Lighting
order: 10
blurb: Plots, fixtures grouped by position, addressing with clash warnings, and the rigging status cycle.
---

# Lighting plots

A plot is one rig's paperwork made live: every fixture, where it hangs, how
it's addressed, its wattage and weight — shared and editable by the whole
crew, with warnings where the numbers don't add up. When the box is
listening to the lighting network, the plot also shows what's actually
arriving — that's [the live page](/docs/lighting-live).

## Plots

The **Lighting** sidebar section lists recent plots; **All plots…** shows
everything. **+ New Plot** asks for a name and an optional venue. Open a
plot and you get four tabs — **Fixtures · Plan · Front · 3D** — plus the
actions row: **Positions · + Fixture · Import · Export · Share**.

The summary line above the tabs keeps the totals honest: fixture count,
per-universe usage ("U1: 64/512"), and "⚠ 2 addressing problems" when
something clashes.

## Fixtures

The **Fixtures** tab lists every unit, grouped by the position it hangs on.
Each group header shows the position's totals — count, watts, kilograms —
and each row carries: unit number, desk channel, universe, address, type,
mode, footprint, purpose, circuit, watts, weight, status, notes.

Things the list does for you:

- **Clash warnings.** An address that collides with another fixture, or
  runs past channel 512, gets a ⚠ naming exactly what's wrong ("DMX clash
  with Spot 3, Spot 4").
- **Address run.** Each position group can address its fixtures nose to
  tail from the first free block in one tap — and tells you if the universe
  has no room.
- **Watts and weight from profiles.** Fixtures imported with GDTF profiles
  show the manufacturer's figures as greyed placeholders until someone
  types a measured number over them.
- **The status cycle.** The status cell is a button that taps through
  **To do → Rigged → Working → Fault** — chosen over a dropdown because on
  a dark stage with gloves you'll tap it hundreds of times.

## Positions

**Positions** manages where things hang: name, kind (truss, bar, boom,
floor…), length, angle, and **trim** height (the drawings use it). Two
things worth knowing:

- Each truss row estimates the length the fixtures on it actually need —
  "Needs 8.4 m · 2 × 3 m + 1 × 2 m" — with a one-tap **Set** button. The
  estimate allows ~250 mm between fixtures and doesn't know about motor
  points; treat it as a starting figure.
- Deleting a position doesn't delete its fixtures — they collect under
  "No position" until rehomed.

## Share and export

As everywhere: **Share** posts the plot to a chat channel as an **Open ↗**
chip; **Export** downloads CSV. Getting rigs _in_ — Lightwright, console
exports, MVR with GDTF — is [the import page](/docs/lighting-import).
