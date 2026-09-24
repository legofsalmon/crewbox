---
title: Around the app
section: Start here
order: 30
blurb: The sidebar and drawer, themes, installing to your home screen, and what offline looks like.
---

# Around the app

Everything lives off one sidebar: chat channels at the top, then a section
for each module the box has switched on. On a phone the sidebar becomes a
drawer — and every screen has a way back to it.

![Crewbox on a phone: a channel with the composer](shot:chat-phone)

## The sidebar

From top to bottom:

- A **connection dot** and the event's name.
- **Channels** and **Direct messages** — chat, which is always on.
- A section per module — **Running order**, **Patch Sheets**, **Lighting**,
  **Network** — whichever this box has enabled. Running order carries what's
  on each stage right now, so the answer is there without opening anything.
- Your **identity row**: your avatar and name, your connection ("Online ·
  42 ms"), and four buttons — **admin panel** (the cog — visible to
  everyone, but it wants the admin password), **mute/unmute alert sounds**
  (the bell), **light/dark theme** (sun/moon), and **sign out**.

## On a phone: the drawer

![The drawer open over chat on a phone](shot:drawer)

Below tablet width the sidebar tucks away and a **☰** button (top left,
"Open channels") brings it back. Opening a channel or a module closes the
drawer so the content gets the whole screen; the ☰ is always there to get
back. Every module's screens carry it too — you can't get stranded.

## Light and dark

The sun/moon button in the identity row switches theme, and the choice
sticks on that device. Dark is the default and follows your system setting
until you choose. Both themes are maintained deliberately: dark for a FOH
tent at night, light for reading a patch sheet outdoors in daylight.

## Install it like an app

Crewbox is a web app that installs to your home screen and keeps working
offline:

- **Android**: the browser offers "Install app" / "Add to home screen" — or
  use the Android app from the box's `/connect` page, which adds lock-screen
  alerts.
- **iPhone/iPad**: Share → **Add to Home Screen**. (The app shows this tip
  once; it's worth doing — you get a real icon and full-screen.)
- **Desktop**: the install icon in the address bar, if you want it.

> [!NOTE]
> Installing from the browser needs the box to be on HTTPS. If the install
> option doesn't appear, the box is running plain HTTP — everything still
> works in the browser tab.

## Offline is normal here

The app treats a dropped connection as expected weather, not an error:

- Everything you've already loaded stays readable.
- Anything you send while offline is queued on your device — marked
  "sending…" — and delivered, once, when the box is back in reach.
- A banner says **Offline** or **Connecting…** so you always know which
  state you're in. When the connection is up but slow, signal bars appear in
  the channel header instead.
- On reconnect the app fetches only what it missed, so catching up is quick
  even on bad Wi-Fi.

## If a screen goes wrong

If something on a screen breaks, you get **Something went wrong on this
screen** instead of a blank page, with **Try again** and **Reload the app**.
Your messages are safe either way: anything you sent that the box hasn't
confirmed is still queued on your device. The sidebar, voice and every other
module keep working — open the menu and go somewhere else.

Under **Send a crash report** you can pass the error on to the people who
make Crewbox, with a note about what you were doing if you like. It goes to
the crew box, which sends it when it next has internet. Nothing is sent unless
you press **Send report**.

## Send feedback

**Send feedback…** at the bottom of the sidebar, beside the version, is for
anything you'd tell the people who make Crewbox: something broken, an idea, a
question, or something that worked. Add your email if you'd like a reply.
Tick **OK to post this publicly** and a bug or idea may be filed on the public
issue tracker — message only, never your name or email. It goes through the
crew box, so it may arrive after the show; if the box is out of reach, your
phone keeps it and hands it over later.

## When a new version arrives

If the box has been updated, a pill appears: **New version available —
Reload**. Tap it when convenient; anything unsent survives the reload. If
the pill seems to do nothing for a moment, it's still fetching the new
version — give it a few seconds and tap again.
