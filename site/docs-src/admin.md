---
title: The admin panel
section: Running the box
order: 20
blurb: Unlocking it, the sections, resetting PINs, readiness lists, the licence, crash reports and the post-event export.
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
fix.

Two rows exist to warn you before something takes the box down rather than
after:

- **Power** — whether this machine is on mains, and if not, how long it has
  left. A laptop nobody plugged in is the commonest crewbox, and it fails
  with no warning at all: fine, then gone, discovered by crew phones sitting
  on "Connecting" mid-set. It goes amber on battery and red under half an
  hour. Machines with no battery don't show the row.
- **Backup** — how long since `deploy/backup.sh` last finished, and where it
  wrote to. The box can't go looking for backups (they're on a USB stick
  that usually isn't plugged in), so the script leaves it a note. A backup
  regime that quietly stopped three events ago looks identical from the
  production desk to one that ran last night; this is the row that tells
  them apart.

Below the list, the settings:

- **Event name**, **Event PIN**, **Wi-Fi network** — the setup-page
  answers, editable live. Changing the PIN notes that the poster and
  `/connect` need re-checking.
- **Networks** — the crew-side adapter, lighting-network listening
  (off / sACN / Art-Net / both) and its adapter, and the sACN universes.
  Join links update immediately; **socket changes apply when the box
  restarts**, and a banner reminds you while saved settings differ from
  what the box started with. There's no restart button — stop and start
  the box ([how](/docs/run-the-box#day-to-day)).
- **Let the apps find this box on the crew network** — the box announces
  itself on the crew network the way printers and sound desks do (Bonjour),
  so a phone app there can find it without being given the address.
  **Automatic** announces on the crew network only, and stays quiet when a
  lighting or media listener is on that network too, because the box does
  not transmit on a show network unless told to. **Always** announces there
  anyway, for a rig whose crew and show share one network on purpose, and
  **Never** stops it. It takes effect at once, and the line underneath says
  what the box is doing, or why it is quiet. On a Mac that has not allowed
  Crewbox on the local network, it says so and where to allow it. A box
  run from source starts with it off.
- **Carries on another event** — for a spare with no backup, or a bigger
  box, taking over from an event's box. A box started without a backup is
  a new event to every phone, and they send it nothing of the one they had.
  Pick that event here and save, and each phone that has it offers, once
  its crew member has joined this box, to bring its documents, running
  order and unsent messages across
  ([what crew see](/docs/getting-connected#more-than-one-event)). The chat
  history comes back only from a backup. The list is the events the device
  you are using has been on, so use one that was on the old event: a phone
  app, or a browser that joined the old box at the address this box has
  now. It stays open on an unlicensed box, since it is how a spare takes
  over mid-show.
- **Admin password** — changeable here; doing so locks every other device
  that had the panel open.

Settings pinned by environment variables show a note instead of a field —
the environment always outranks the panel, which is also the recovery path.

## This network

What the venue's network is actually providing, probed on demand (**Check
again**): the box's address, internet (a captive portal is flagged; plain
"no internet" is just information — the box doesn't need it), whether crew
can reach the box by its name, certificate expiry, and clock sanity.

**Download DNS config** gives a ready-made `crewbox-dns.conf` for the venue
router — hand it to whoever runs the router instead of explaining DNS at the
production desk. On a box with a certificate it points the name at the box;
on one without, it carries only the optional block below.

That file carries a second, clearly-marked **optional** block: the addresses
phones fetch to decide whether a network has internet. Adding it stops
iPhones abandoning the crew Wi-Fi for mobile data — see
[the "no internet" problem](/docs/phones-and-platforms#the-no-internet-problem)
for what that failure looks like and why it's worth doing.

## Licence

A licence belongs to the **box**, never to a crew phone: one seat, and the box
can go 90 days without checking in with letissier.ie. Nothing about the
licence ever touches crew comms — chat, voice, files and every module work the
same on an unlicensed box. What an unlicensed box won't do is set up or
configure an event until a key or a 30-day trial is entered.

In **Licence**: type a key and **Activate** (the box needs the internet for a
moment), or **Start a 30-day trial**, or — the usual case on site — **Activate
offline**: read this box's request code off the panel, get a token for it at
letissier.ie/account on any phone with signal, and paste the token back in.

## Crash reports

If the box ever closes without being stopped — a crash, a power cut, a lid
closed on a laptop with a dead battery — the next time you open the panel it
asks once: **Crewbox closed unexpectedly last time. Send a crash report to
LeTissier Creative Studios?** **Send** queues it; **Don't send** deletes it.
Tick **Always send crash reports** to stop being asked.

**Send crash reports automatically** starts off. A report holds the Crewbox
version, the operating system, a random id for this install, and the error
with its stack trace; home folders, user names, network addresses and
anything after `?` in a web address are removed on the box before it is
saved. It never holds messages, names, files, the event or the licence.

Reports wait on the box and go when it next has internet — that may be
after the show, and that's fine. A box set with `CREWBOX_UPDATE_CHECK=0`
makes no outbound connections, so its reports stay on the box. They are
plain files in the `reports` folder of the box's data directory, if you want
to read or delete one.

## Export

**Download chat logs** — every user, channel and message as one JSON file
for the post-event archive. Patch sheets and plots export from their own
modules as CSV.
