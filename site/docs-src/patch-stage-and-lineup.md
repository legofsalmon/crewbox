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

![The sub-box manager: names, inputs, colours, stage positions](shot:patch-subbox)

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

![The derived stage patch, box by box](shot:patch-stage)

**Stage Patch** shows, per act, each sub-box as its own table: tail number,
channel, input, mic/DI — including empty tails, because "tail 4 is free" is
information. It warns loudly when two channels claim one tail
("⚠ Two channels on one tail: BSNAKE 4"), and unused boxes collapse out of
the way.

It's read-only on purpose. Fix anything by fixing the grid cell it came
from — there is exactly one source of truth.

## The lineup

![The lineup: acts, set times and changeovers](shot:patch-lineup)

**Lineup** manages the acts:

- **+ Add Act**, then name, **start and end times**, a **Spec** field
  (backline, band size, what they bring) and an **Additional info** field
  for what came up on the day.
- **Files** — drop an act's rider or stage plot straight onto their row.
  Attachments live on the box, so they need a connection to add or open.
- Acts appear as the column groups of the grid, in running order.

### Where the acts come from

The names and times aren't the sheet's — they're the event's
[running order](/docs/schedule), and this is one of its editors. Move a set
time here and it has moved on every phone, every countdown and every other
department's screen before you look up. The **Spec**, **Additional info**
and **Files** belong to this sheet alone, so an audio sheet and a lighting
sheet can say different things about the same band.

That means two things worth knowing:

- **The Stage field in the toolbar decides the columns.** A sheet shows its
  own stage's acts on its own date. Type a stage the running order doesn't
  use and the grid is empty — the field offers back the stages already in
  use for exactly that reason. A sheet with no stage named yet shows
  everything on its date.
- **Removing an act removes it from the event**, not just from this sheet,
  along with this sheet's patch for it. Crewbox asks first and says so.

A sheet with no acts says so and offers the way out, rather than showing a
grid with no columns and no explanation.

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
