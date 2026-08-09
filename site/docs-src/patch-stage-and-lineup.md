---
title: Stage patch and lineup
section: Patch sheets
order: 30
blurb: Sub-boxes, the derived stage patch and its "PINK 3" syntax, acts, set times and changeovers.
---

# Stage patch and lineup

The grid holds the master patch; two dialogs turn it into the other
paperwork a stage runs on. The **stage patch** — what's plugged into which
box on stage — is _derived_ from the grid, never typed twice. The
**lineup** holds the acts, their times, and the changeovers between them.

## Sub-boxes

**Boxes** declares the stage's sub-boxes (sub-snakes): a name, how many
inputs it has, a colour, and where it sits on stage (USC, DSR…). Colours
show up as stripes in the grid's Sub-box column, so a glance tells you
which box a channel lands on.

## The "PINK 3" syntax

Here's the trick that makes the stage patch free: in an act's **Sub-box**
cell, type the box name and a tail number — `PINK 3`. That one cell says
"this channel arrives on tail 3 of the PINK box". Do that as you patch, and
the stage patch writes itself.

## The stage patch

**Stage Patch** shows, per act, each sub-box as its own table: tail number,
channel, input, mic/DI — including empty tails, because "tail 4 is free" is
information. It warns loudly when two channels claim one tail
("⚠ Two channels on one tail: BSNAKE 4"), and unused boxes collapse out of
the way.

It's read-only on purpose. Fix anything by fixing the grid cell it came
from — there is exactly one source of truth.

## The lineup

**Lineup** manages the acts:

- **+ Add Artist**, then name, **start and end times**, a **Spec** field
  (backline, band size, what they bring) and an **Additional info** field
  for what came up on the day.
- **Files** — drop an act's rider or stage plot straight onto their row.
  Attachments live on the box, so they need a connection to add or open.
- Acts appear as the column groups of the grid, in running order.

## Changeovers

Between each pair of acts the lineup shows a **changeover**:

- The greyed-in number is the gap the set times imply.
- Type the _agreed_ changeover over it if it's different ("45", "1hr30",
  "HR" all parse).
- If the two disagree, you get a warning — "⚠ the set times leave 1 hr" —
  and crewbox **deliberately doesn't pick a side**. The sheet doesn't know
  whether the running order moved or the changeover did; only the person
  holding the running order does. Fix whichever is wrong and the warning
  goes.

## Day sheets

Nothing special to learn: a second-stage day sheet is just another sheet.
Import it like any CSV — changeovers and per-act info boxes come through —
and share it to that stage's channel.
