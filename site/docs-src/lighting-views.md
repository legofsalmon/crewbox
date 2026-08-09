---
title: Plan, Front and 3D
section: Lighting
order: 20
blurb: The three drawings — reading them, moving positions, and what needs real data to appear.
---

# Plan, Front and 3D

Three drawings of the same rig, all live: change a trim in the Positions
dialog and every open device redraws. None of them needs a gaming laptop —
they're deliberately lightweight so a phone at the dimmer beach and a
years-old FOH machine both keep up.

## Plan

![The plan view: top-down in metres](shot:lighting-plan)

Top-down, in metres, with the centre line and the downstage edge marked.

- **Drag a position to move it** — it snaps to 0.25 m and syncs live to
  everyone.
- Zoom with the −/+ buttons; unit numbers appear once you're in past 120%.
- Click any fixture to select it — the app flips to the Fixtures tab with
  that unit highlighted.

## Front

![The front elevation at trim height](shot:lighting-front)

The audience's view: width across, height up, everything drawn at its
position's trim. Upstage positions draw dimmer and slightly smaller so
depth stays readable in 2D.

## 3D

![The 3D view of the rig over the stage deck](shot:lighting-3d)

An orbitable view of the rig over a stage deck — **drag to orbit**, and
**Reset view** brings back the default angle. When the box is receiving
live DMX and a fixture's profile provides real pan/tilt ranges, moving
heads grow faint beam cones pointing where the desk is pointing them —
[the live page](/docs/lighting-live) covers switching that on.

## What the drawings need from your data

The drawings are only as good as the plot's numbers:

| You see                      | Because                                                                        |
| ---------------------------- | ------------------------------------------------------------------------------ |
| Fixtures in a neat line      | Their position has a length and they're spread along it                        |
| Sensible heights in Front/3D | Positions have real trim heights                                               |
| Beam cones in 3D             | Live levels are on **and** the fixture has a GDTF profile with pan/tilt ranges |
| A dot at stage centre        | The fixture has no position — it's parked in "No position"                     |

An MVR import fills nearly all of this in one go — positions, real
coordinates along the truss, profiles. A CSV import gives you the list but
not the geometry; see [the import comparison](/docs/lighting-import).
