---
title: Driving the box from a desk
section: Running the box
order: 50
blurb: The keyed control API — tally, running order and messages on a Stream Deck button, from Companion or anything that can make an HTTP request.
---

# Driving the box from a desk

A production desk already has a Stream Deck where vision, lighting and
playback are each one button away. Crewbox being the exception makes crewbox
the thing somebody has to remember to go and click — which on a show is the
same as the thing that doesn't happen.

So the box answers a small HTTP surface designed for a machine: raise a
tally, read what is on which stage, post a message to a channel. It is meant
for [Bitfocus Companion](https://bitfocus.io/companion) and works from
anything that can make a request — a cue stack, a Node-RED flow, a shell
script in a show folder.

## The key

Every call carries a key. The box mints one the first time it is asked for,
and prints it at the bottom of **Admin → This box**.

![The desk control key in the admin panel](shot:admin-desk-key)

Present it either way — both are conventional and both work:

```sh
curl -H "x-api-key: YOUR-KEY" https://box.local/api/control/state
curl -H "Authorization: Bearer YOUR-KEY" https://box.local/api/control/state
```

> [!NOTE]
> This is deliberately not the admin password. The admin password is a person
> doing something once; the key is a machine doing something a hundred times
> a night, and it grants far less. Nothing on this surface can change the
> event, delete anything, or read a message anybody wrote.

To pin the key — so a spare box answers the buttons you already built, or so
a leaked one can be replaced without touching a running show — start the box
with `CREWBOX_CONTROL_KEY` set. The environment wins over the stored key and
is never written to disk, the same rule the rest of the box follows.

## Tally: who is on camera

```sh
POST /api/control/tally   { "user": "Dev Okafor" }   raise
POST /api/control/tally   { "user": null }           clear
GET  /api/control/tally                              read it back
```

The crew member is named the way the person building the button knows them —
their name in the app. An id works too, if a script stored one. A name that
matches nobody is a `404` rather than a success that lit nobody up.

Everyone's app shows a bar the moment it changes; the person named gets the
loud version of it. It is raised from the desk and never from inside the app,
because the person on camera is the last person who should be tapping a
phone.

Bind two buttons — one that names the camera's crew member, one that sends
`null` — and the tally follows your cuts.

## State: everything a button can show

```sh
GET /api/control/state
GET /api/control/state?stage=Main%20Stage
```

One request rather than five, because a desk polls this a second at a time
all night. It answers with the event name, who is on air (by id _and_ by
name), how many crew are online, whether voice is configured and what the
crew's own devices said about it, the channels a message could go to, and
the running order per stage:

```json
{
  "event": "Test Event",
  "onAir": { "userId": "…", "name": "Dev Okafor", "since": 1770000000000 },
  "crew": { "online": 14, "total": 22 },
  "runningOrder": {
    "known": true,
    "stages": [
      {
        "stage": "Main Stage",
        "onNow": { "name": "The Fixture", "endsIn": 60, "ends": "in 1h" },
        "next": { "name": "Night Bus", "startsIn": 120, "starts": "in 2h" }
      }
    ]
  }
}
```

Each act comes with the numbers and the same thing in words, so a button can
print `starts` without doing any arithmetic of its own.

Two details worth knowing:

- **`known: false` means the box is not holding a copy of the running
  order**, which is different from the running order being empty. The
  timetable lives on the crew's phones and syncs through the box; when
  nobody on site has the app open there is nothing to read. A button should
  show a dash rather than an empty stage.
- **The clock is the show's, not the calendar's.** A set at 00:30 belongs to
  the night that started at 19:00, and the box says so — it reads the running
  order with exactly the code the app uses, so a desk and a phone can never
  disagree about who is on.

## Messages: telling the crew something from the desk

```sh
POST /api/control/message   { "channel": "general", "body": "Changeover started" }
```

The channel is named the way it is written down — `general`, `#general`, or
an id. It lands as a system message, in the same voice as "#foh created",
because a machine posting under a crew member's name is a machine putting
words in somebody's mouth on a comms channel.

Public channels only. A key sitting in a desk config file can never write
into a DM.

## Setting it up in Companion

Companion's **Generic: HTTP requests** module covers all of this — there is
no crewbox module to install.

- **A tally button** is a POST action to
  `https://box.local/api/control/tally` with the body
  `{"user": "Dev Okafor"}` and a custom header `x-api-key: YOUR-KEY`. Bind a
  second button to the same URL with `{"user": null}` for the clear.
- **A changeover call** is a POST to `/api/control/message` with
  `{"channel": "general", "body": "Changeover started"}` — the same button
  that fires the walk-in music.
- **Button feedback** is a polled GET of `/api/control/state`; pull the
  fields you want out of the response with Companion's HTTP variables and
  draw them on the button. `starts` and `ends` are already worded for a
  button face.

Check the URL and the key once with `curl` before building the page. A
mistyped key answers `401` and a mistyped host answers nothing, and telling
those two apart at a desk mid-show is nobody's idea of an evening.

> [!WARNING]
> If the box is serving HTTPS with its own certificate, the desk machine
> needs to trust that certificate — see
> [HTTPS, names and certificates](/docs/https-and-voice). A desk that cannot
> verify it will fail every call with a TLS error, not a `401`.

## Limits

- **A correct key is never throttled.** Poll the state as often as your desk
  wants to; that is what it is for.
- **A wrong one is**, at 120 tries a minute per source address. Past that the
  answer is `429` rather than another `401`, so a throttled desk and a
  mistyped key never look the same.
- Everything here is read-or-tally-or-post. There is no call that changes the
  event, deletes anything, or reads what the crew wrote to each other.
