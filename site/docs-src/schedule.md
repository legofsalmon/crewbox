---
title: Running order
section: Running order
order: 10
blurb: What's on and what's next, on every phone — read from the patch sheets that already hold the set times.
---

# Running order

The most-consulted document on any site is the running order, and until now
crewbox held it and showed it to nobody. A festival patch sheet is already
one stage's day — every act on it carries a start time, an end time and the
changeover before it, imported from the production company's own
spreadsheet — but that lives inside **Patch Sheets**, which a stage manager,
a lighting tech or the bar lead has no reason to open.

**Running order** reads those same sheets and shows the two facts everybody
actually wants: what's on, and how long until the next thing.

## Nobody types the day twice

This module owns no documents of its own. It reads the patch sheets on the
box, so:

- A set time corrected on the audio desk moves the countdown on every phone.
  There's no second copy to keep in step, and no version that can be wrong.
- A stage appears as soon as somebody makes a patch sheet for it. The
  sheet's **stage** field is the name you'll see.
- If there are no sheets yet, the module says so and points at the one that
  holds the data, rather than looking broken.

Reading a sheet is not the same as being in it. Your phone won't appear in
anyone's patch sheet as a second pair of eyes just because your running
order is up — the presence count on a sheet still means people who actually
have it open.

## What it shows

Per stage, ordered so whatever is happening soonest is at the top:

- **On now** — the act playing, and when it comes off.
- **Next** — what follows, and how long until it starts.

Between sets, **On now** reads `—` and `changeover`. That's the busiest
moment on a stage and the answer someone is looking for, so it's stated
rather than left blank. Once a stage is done for the day it says so and
sinks to the bottom.

The sidebar carries the same thing in one row per stage, so a stage manager
who never opens the module still sees who's on and how long they have.

## Sets that run past midnight

A 00:30 headliner belongs to the night that started at 19:00, not to the
following morning — so the running order treats anything before 06:00 as
part of the night before. Without that, sorting by the clock alone puts the
biggest act of the weekend first thing in the morning.

A set that crosses midnight (23:40 to 00:20) is measured by its length, so
it reads as forty minutes rather than twenty hours.

Acts with no start time are carried but never shown as "on now" or "next" —
a TBC slot shouldn't silently become the answer to "who's on".

## Turning it off

It's on by default. `CREWBOX_MODULES` without `schedule` removes it, the
same as any other module.
