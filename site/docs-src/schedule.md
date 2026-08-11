---
title: Running order
section: Running order
order: 10
blurb: Who's on, where and when — entered once and read by every department.
---

# Running order

The most-consulted document on any site is the running order — who's on,
where, and when. Crewbox keeps one, in one place, and every department reads
the same copy.

It belongs to the event rather than to a department, so it lives in the app
itself rather than inside any one module. A box that turns a module off
doesn't lose it, and nothing has to be kept in step with anything.

## Adding the acts

**Running order → Edit.** Add an act, give it a stage, a date and its times.
That's the whole thing.

Changes are shared as you type. There's no save button because there's
nothing to save to — everyone on the box is looking at the same document, so
a set time corrected at the production desk is corrected on every phone
before the next person looks. Two people can edit at once and neither loses
work.

Stage names are offered back to you as you type them, because "Main Stage"
and "Main stage" are two stages to a computer and one to a crew.

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

## One place, many readers

Nobody types the day twice. The running order is entered once and everything
else reads it — the countdowns here, and the modules that need to know what's
on. Adding a consumer doesn't mean adding a copy.

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

`CREWBOX_MODULES` without `schedule` removes the screen, the same as any
other module. The running order itself is still there — it belongs to the
event, not to the module that displays it — so anything else that reads it
keeps working.
