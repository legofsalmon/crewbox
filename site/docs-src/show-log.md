---
title: The show log
section: Show log
order: 10
blurb: What happened, when, and who wrote it down — the running log that becomes the show report, and the correction that replaces the crossing-out.
---

# The show log

![The show log, with a night's entries](shot:incident-log)

The paper log a stage manager keeps: the show stops, the holds, the near
misses and the things that ran late, each with a time against it. On the
Monday it is the show report. Six months later, when somebody asks why the
headliner went on forty minutes down, it is the only account anybody has.

Everyone on the box can read it and everyone can write to it. A lighting
tech who watched the same thing happen from a different angle can add what
they saw while it is still fresh, which is worth more than tidy authorship.

## Filing an entry

![Logging an entry, with the "when" row](shot:incident-form)

**Log an entry**, then the words. Everything else already has an answer:

- **Kind** — show stop, hold, delay, technical, medical, crowd, security,
  weather, or a plain note. Nine, so the list is one glance. Anything that
  doesn't fit is a note and the words carry it.
- **How bad** — note, issue, or serious. Three, because a scale with more
  points is one nobody applies the same way twice at two in the morning.
  Only issue and serious get a colour; if everything is highlighted, nothing
  is.
- **Where** — offered from the stages already on the [running
  order](/docs/schedule), so nobody types "Main Stage" and "Main stage" into
  the same night.
- **When** — the one worth a moment. **Now**, **5 / 15 / 30 min ago**, or an
  exact time.

An entry filed in four seconds with the wrong label beats a perfect one
nobody had time to write.

> [!NOTE]
> The log records **when it happened**, not when you typed it. You deal with
> the thing first and write it up once there is a hand free, so an entry
> written up later says so on its own line — "logged 30 min later". Anyone
> reading it back can tell a note made at the time from one made afterwards,
> which is exactly the distinction that matters if it is ever read in
> earnest.

What was on stage at that moment is captured with the entry, so the log says
"during Night Bus" — and keeps saying it even after somebody corrects the
running order or deletes the act.

## Corrections, not edits

**Nothing in the log can be edited or deleted.** That is the point of it.

Got a time wrong, or a name? **Add a correction** on the entry, and write
what the record should say. The correction appears underneath the original,
indented, and both stay — the crossing-out in a paper log book, which never
removes the line underneath it.

## Reading a long night

The log reads backwards, newest first, because the question during a show is
nearly always "what just happened". Filter by kind, by how bad, by stage, or
search the words — the search also matches the act and whoever wrote it.

Nights are grouped by the show day, which rolls over at 06:00: the 00:30
entry belongs to the night that started at 19:00, not to the following
morning.

## The show report

**Show report** downloads the night as a single HTML file — no internet
needed, nothing to fetch, opens and prints anywhere. It reads forwards,
because that is how a report is read, with the corrections under their
originals and a count of the serious ones at the top. Attach it to the
production email or file it with the paperwork.

## Offline

Entries file with no signal. They are held on the phone that wrote them —
through a reload, a dead battery, a walk out of Wi-Fi range — and go to the
box the moment it is reachable. The pane says how many are still waiting
rather than pretending they have landed.

Because the log is the box's, not the phone's, an entry only reaches the
rest of the crew once it has arrived. What you cannot lose is the entry
itself.

## Turning it off

The module ships on by default. A box that doesn't want it runs without:

```
CREWBOX_MODULES=schedule,patch,lighting,network
```

Entries already filed stay in the box's database and come back if the module
is turned on again.
