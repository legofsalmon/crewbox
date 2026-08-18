---
title: Updating the box
section: Running the box
order: 45
blurb: How a box updates itself, what it checks before it trusts a build, and how to turn the whole thing off.
---

# Updating the box

A box checks once a day whether a newer crewbox exists and says so — in the
tray icon, and in the admin panel beside the version. It never installs
anything on its own. Two separate presses stand between that notice and a
restart, and the second one shows you what the restart would interrupt.

## What you'll see

When there's news, the admin panel grows a line above the version list:
**v0.18.0 is available**, with a link to what changed.

A box with nothing to do says nothing at all. There's no "up to date" row —
a row that's almost always the same word is a row nobody reads.

## Downloading changes nothing

**Download** fetches the build and checks it. It does not install it, and it
does not restart anything. You can download during a show and install at
half four in the morning; the box will still have it.

What it costs is the venue's uplink — a couple of hundred megabytes — and a
little disk. That's why it's an admin's decision rather than a crew member's,
even though nothing happens to the box.

While it downloads you can close the panel and get on with something else.

## Installing asks you twice

**Install and restart…** doesn't restart anything. It asks the box what
that would interrupt right now, and shows you the answer:

```
Main Stage: Fontaines D.C. is on for another 35 minutes.
14 people connected on 20 devices — everyone loses comms.
Chat, voice and every module go down for about 20 seconds while the box restarts.
```

That's read off the running order and the live connection count, not guessed.
**It will never stop you.** A box that refused to update during a show would
be a box that couldn't be fixed during a show, and you know things it doesn't
— that the stage is dark, that the act finished early, that comms are already
broken and that's exactly why you're here.

**Install now** is the only thing that takes the box off the air.

## What happens then

Every phone loses the box for about twenty seconds, then reconnects on its
own. Nobody has to rejoin, nothing is lost, and unsent messages send when the
connection returns.

Behind that:

- The database is copied first, so going back is possible.
- The old binary is kept, not deleted.
- The old program stays running until the new one answers.
- If the new one never answers, the old one comes back and the box carries on.

You do not have to do anything for that last part. It is not a recovery
procedure, it is what happens.

## Turning it off

A box on a network that must make no outbound connections at all: set
`CREWBOX_UPDATE_CHECK=0` and it never contacts anything. The tray never
mentions updates and the panel shows nothing.

The check is one HTTPS request a day, asking GitHub for the newest release
number. It carries this box's IP address and nothing else — no event name,
no crew, no history. See [Privacy](/docs/privacy).

## Checking a build yourself

Every release carries a `SHA256SUMS-<version>` file listing every download's
fingerprint, and a signature over it. The box checks both automatically —
the signature against keys built into the program, so a stranger who got hold
of our GitHub account still couldn't publish something a box would run.

If you want to check by hand, or your venue's IT wants to:

```
sha256sum -c SHA256SUMS-v0.18.0
```

The full procedure, including checking the signature, is in `docs/UPDATING.md`
in the source.

## If something goes wrong

**The panel says the install failed.** Read the line — it says what failed and
whether the previous version is back. In almost every case it is, and the box
you're looking at is the one you had. **Try again** re-uses the download.

**The box didn't come back.** The previous binary is beside it with `.old` on
the end. Rename it back and start it.

**It came back but something's wrong with the data.** Database copies are in
the `snapshots` folder in the box's data directory, named with the version
they belong to. Stop the box, copy the right one over `crewbox.db`, start it.

**The power went out mid-update.** Nothing to do. The box works out on its
next start whether the new version is running, and either keeps it or puts the
old one back.

## A box run from source

If you're running crewbox with `npm run dev` or from a checkout, there's no
binary to swap and the panel offers nothing. Update it with git.
