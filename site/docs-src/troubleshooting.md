---
title: Troubleshooting
section: Reference
order: 30
blurb: Symptom first — can't join, can't talk, no alerts, and friends.
---

# Troubleshooting

Symptom-first. Crew problems first, box problems at the end.

## "I can't join"

- **The join page never loads** — you're not on the event network. Join the
  Wi-Fi named on the poster, then scan again. Some phones cling to mobile
  data; turning it off for a minute forces them onto the venue Wi-Fi.
- **"That name is taken and the PIN doesn't match"** — the name you typed
  exists and the PIN isn't its PIN. If it's yours, you've misremembered your
  PIN: ask an admin to reset it. If it isn't yours, pick another name.
- **The event PIN is rejected** — PINs change occasionally; read it off the
  current poster or the `/connect` screen, not a photo from yesterday.
- **"Too many attempts"** — the box rate-limits guessing. Wait a minute.

## "I can hear voice but nobody hears me"

That's the HTTPS microphone rule — the voice bar will say **listen-only**.
See [the voice page](/docs/voice#the-https-rule-read-before-show-day).
Quick fixes: use the Android/iOS app, or ask whoever runs the box whether
HTTPS is set up.

If you're **not** listen-only but still silent: open the voice bar's gear
and watch the mic meter while you speak. Flat bar → wrong mic selected, or
the browser was denied mic permission (check the padlock icon in the
address bar).

## "I'm not getting alerts"

- Check the **bell** in the sidebar isn't muted.
- Backgrounded browser alerts need notification permission — the browser
  asks once; if it was refused, re-enable it in site settings.
- **iPhone, locked, no internet: alerts cannot work.** Apple's push
  servers are unreachable from an offline event network and no app can work
  around it. Give Android phones to roles that must not miss a call — the
  Android app holds its own connection to the box and buzzes on the lock
  screen, entirely on the LAN.

## "My message says sending… forever"

The box is unreachable from your device. The message is safe and will
deliver when the connection returns — don't retype it. If everyone nearby
has the same problem, the box or the Wi-Fi is down; if it's just you, walk
closer to an access point and watch the banner.

## "A channel looks empty" / "someone's messages are missing"

If the filter bar is open, close it — a filter narrows the view to what's
loaded on your device, and it clears itself when you switch channels
precisely so this state can't linger. For history beyond what's loaded, use
search (`⌘K`), which asks the box for everything.

## "The reload pill does nothing"

**New version available — Reload** occasionally needs a few seconds while
the new version finishes downloading. Tap it again. If it persists, close
and reopen the app — nothing unsent is lost either way.

## "The lighting plot shows no levels"

The drawings only colour by desk output when **Levels** is switched on in
the live bar — it's off by default because levels are the expensive part.
No live bar at all means this box isn't listening to a lighting network —
that's an operator setting (**Admin → Lighting network**).

## "The Network module says Not watched"

Honest reporting, not a fault: the box wasn't told to watch that network.
The card says what to change; it's an operator switch, not something in the
app.

## For the box's operator

- **The box won't start / port already in use** — a box is already running
  on that machine; `crewbox --status` shows it, `crewbox --stop` stops it.
- **Crew can't reach the box by name** — the venue DNS doesn't answer for
  your hostname. **Admin → This network** flags this and offers a
  ready-made `crewbox-dns.conf` download for the router.
- **Setup page gone** — `/setup` closes forever once the first person
  joins. Everything on it lives on in the admin panel; the admin password,
  if lost, can be overridden with the `ADMIN_PASSWORD` environment variable
  and a restart.
- **Everything else** — the readiness list in **Admin → This box** exists
  precisely for "what's wrong and what do I do": every red or amber row
  carries its own fix.
