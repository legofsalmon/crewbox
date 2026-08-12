---
title: LED walls
section: Video
order: 10
blurb: Watching LED processors from a phone — cabinets, temperature, inputs — with a box that reads them and has no way to control them.
---

# LED walls

The **Video** module answers the question a screens tech asks from the far
side of a field: _are all the cabinets talking, is anything cooking, and is
there still a signal on the input?_

Every one of those is answerable by reading, and none of them needs the
ability to change what is on the wall. So crewbox reads, and that is all it
can do.

![The LED pane, watching two processors](shot:video-walls)

## It cannot control the wall

There is no way from this pane — or from any other surface, at any permission
level — to change brightness, recall a preset, black out a screen or select an
input. The code to do it does not exist in the box.

(Control may come later, as its own thing with its own rules about who can
drive a wall. Everything on this page describes a version that cannot.)

That is a property of the build rather than a policy: the HTTP client's method
is typed as the literal `GET`, the SNMP encoder can only produce a GetRequest,
and a test reads every file in the module to check that neither has quietly
grown a write. `docs/VIDEO_MONITORING.md` in the repository has the detail.

The reason is the same one behind the lighting listener. Every crew phone on
the box inherits whatever the box can do, and a festival's video network
carries the show. An app that _can_ black out a screen is a way to black out a
screen from somebody's pocket.

## The pane is yours; the sweep is an admin's

Anyone signed in can open it, name a processor, watch one, and stop watching.
You do not need the admin password for any of that — everything it starts is
the box reading one address you gave it.

The **sweep** is the one exception, and it takes the admin password. The
difference is not how much it matters: it is that a sweep broadcasts to a
whole network segment rather than reading one processor somebody named. That
is a decision about the venue's network, not about your wall.

## Adding a processor

Type its address and a name — "upstage left", whatever the crew calls it. If
the processor tells the box it calls itself something else, that appears
underneath rather than replacing what a human chose.

The person who knows the address is usually the screens tech, so this does
not go through an admin.

**Adding contacts nothing.** An address in the list is a note about the world,
not permission to talk to it. The row says so until somebody turns it on.

## Turning watching on

![The confirmation, naming every packet](shot:video-confirm)

This is the step that puts traffic on the video network, so it asks — and it
asks properly. Instead of "are you sure?", you get the exact requests the box
would make: the addresses, the ports, the interval. They are the words you
would need if a venue's network manager asked what your box put on their VLAN.

Confirming starts a poll about every twenty seconds. It is not a permission
check — anyone signed in can do this — it is there so you read what the box
is about to put on a show network before it does.

**Stopping needs no confirmation at all.** Anything that makes stopping
harder than starting is the wrong way round on a show day.

## Sweeping for processors

If you know which network the processors are on but not their addresses, an
admin can sweep for them. One broadcast, the same packet NovaLCT sends to find
controllers, run once when you ask and never on a timer.

This is the admin-gated one because it is the only thing here that talks to a
whole segment instead of to an address somebody typed in.

It shows you what it would send before it sends anything, and afterwards it
prints what it actually transmitted, verbatim, for a venue that wants to check
it against a capture.

A processor answers with its address, and crewbox shows whatever follows raw
and unlabelled — nobody has captured a real reply, so putting a label like
"model" on those bytes would be a guess dressed as a fact.

Sweeping needs the box to know which adapter is on the video network
(`CREWBOX_VIDEO_IFACE`). Without it the pane says so, and processors added by
address still work.

## What a row tells you

Only what the processor actually said. A controller that did not report a
temperature contributes no temperature, and the row reads "couldn't tell"
rather than "fine" — a screens tech reading _fine_ off a box that never asked
the question is worse off than one reading _couldn't tell_.

- **cabinets** — how many are online, and how many are not
- **temperature** — the hottest cabinet, not an average. An average hides the
  one panel in the sun, which is the only one worth walking over to look at
- **inputs** — how many are live, and any that are connected with no signal.
  Unused connectors are not faults and are not counted as any
- **blacked out / frozen** — usually somebody's decision, so it is a note
  rather than an alarm. But a wall that is black when nobody meant it to be is
  exactly what you want to notice from across a site

## "SNMP is switched off"

Some controllers answer over SNMP, which is NovaStar's own monitoring
interface and carries far more detail — per-cabinet health, per-input signal,
fan and card status. Others have it turned off, and the box falls back to the
HTTP API: fewer numbers, less per-cabinet detail.

When that happens the row says so. Turning SNMP on is a change to the
processor, so it is something to do at the front panel or in VMP — crewbox
will not offer to do it, because it has no way to.

## "Nothing to read"

An address that answers on neither interface reads as **nothing to read**,
with the honest explanation: either there is no processor there, or it is a
model whose only interface is the register bus — a VX4S, or a NovaPro UHD Jr.

crewbox cannot tell those apart, and deliberately does not try. Finding out
would mean opening a control session, which on that interface may be exclusive
— so a connection made out of curiosity could take the desk away from the
operator using it.

## Worth knowing

The protocol details behind this module came from reverse-engineering work in
a separate project, and **no NovaStar hardware has been in front of any of
it**. The interfaces are documented by the manufacturer; the exact field names
in the HTTP responses are not confirmed against firmware.

That is why the pane leaves blanks where a controller said something it did
not recognise, rather than filling them in. If a row looks sparse, that is the
box being honest about what it read.
