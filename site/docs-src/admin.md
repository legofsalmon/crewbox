---
title: The admin panel
section: Running the box
order: 20
blurb: Unlocking it, the five sections, resetting PINs, readiness lists and the post-event export.
---

# The admin panel

![The unlock: the admin password, not the event PIN](shot:admin-unlock)

The **cog** in the sidebar's identity row opens the admin panel. Everyone
can see the cog — a hidden control is how a box loses its admin — but it
opens with the **admin password**, which is not the event PIN and not
anyone's personal PIN ([the three codes](/docs/getting-connected#the-three-codes-untangled)).

The unlock lives in memory only: closing the app re-locks it, and the
**Lock** button does it on the spot — use it before handing your phone to
someone.

## Crew

![The crew list with Reset PIN](shot:admin-crew)

Every account on the box, with presence and role. The one action you'll
actually use mid-event is **Reset PIN** — for the crew member who invented
a PIN at 9am and lost it by noon. Type a new one, tell them, done.

## Channels

Rename a channel, fix its topic, or **Retire** it (two-step confirm) when a
stage wraps. `#general` can't be retired — there's always somewhere
everyone is.

## This box

![The This box section: readiness list and settings](shot:admin-this-box)

The health of the machine you're running on, as a readiness list — crew
network, voice, modules, install/offline support, the Android app download,
disk space — each row with a plain verdict and, when it isn't fine, the
fix. Below it, the settings:

- **Event name**, **Event PIN**, **Wi-Fi network** — the setup-page
  answers, editable live. Changing the PIN notes that the poster and
  `/connect` need re-checking.
- **Networks** — the crew-side adapter, lighting-network listening
  (off / sACN / Art-Net / both) and its adapter, and the sACN universes.
  Join links update immediately; **socket changes apply when the box
  restarts**, and a banner reminds you while saved settings differ from
  what the box started with. There's no restart button — stop and start
  the box ([how](/docs/run-the-box#day-to-day)).
- **Admin password** — changeable here; doing so locks every other device
  that had the panel open.

Settings pinned by environment variables show a note instead of a field —
the environment always outranks the panel, which is also the recovery path.

## This network

What the venue's network is actually providing, probed on demand (**Check
again**): the box's address, internet (a captive portal is flagged; plain
"no internet" is just information — the box doesn't need it), whether crew
can reach the box by its name, certificate expiry, and clock sanity.

When the name check fails, a **Download DNS config** button appears with a
ready-made `crewbox-dns.conf` for the venue router — hand it to whoever
runs the router instead of explaining DNS at the production desk.

## Export

**Download chat logs** — every user, channel and message as one JSON file
for the post-event archive. Patch sheets and plots export from their own
modules as CSV.
