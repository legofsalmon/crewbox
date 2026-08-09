---
title: Voice intercom
section: Chat & voice
order: 30
blurb: Push-to-talk in any channel — hold to speak, latch for gloves, and the one HTTPS rule.
---

# Voice intercom

Every channel can be a party-line intercom: join voice, hold the button,
talk. The voice server runs inside the box, so it works with no internet —
but browsers have one rule about microphones that you should know before
show day.

## Join and leave

The **headset** button in a channel's header joins that channel's voice.
A bar appears above the app — it stays with you while you move around
channels and modules — showing who's on the line, with a dot per person that
lights while they speak. The **Leave** button on the bar hangs up.

If the headset button isn't there at all, this box doesn't have voice
configured.

## Push-to-talk

- **Hold** the big button to talk; release to go quiet. It reads **HOLD**
  when idle and **LIVE** with a level halo while you're transmitting — if
  the halo doesn't move, your mic isn't picking you up.
- The **lock** button latches your mic open — for gloved hands or a long
  explanation. Tap again to release. The bar shows everyone whose mic is
  open, so a stuck latch is visible to the whole line.
- A "🔊" pill names whoever is speaking right now.

## Audio settings

The **gear** on the voice bar picks your microphone and speaker. The mic
picker has a live level meter — "say something, the bar should move; if
not, pick another mic". On iPhones the speaker is routed by the system:
switch outputs in Control Centre or your Bluetooth settings.

## The HTTPS rule (read before show day)

Browsers refuse to hand a microphone to a page served over plain
`http://` — a browser security rule, not a crewbox choice. On a plain-HTTP
box you can still **join voice and hear everything**, but you'll be
**listen-only**: the bar says so, and the talk button won't transmit.

Ways around it:

- The **Android and iOS apps** are exempt — they use the phone's own mic
  permission and work over plain HTTP.
- The box's operator can give the box a certificate — that's covered in the
  operator docs, and it also unlocks installing the web app to home screens.
- The machine **running** the box is always fine at `localhost`.

> [!NOTE]
> If you joined and can hear but not speak, look for the "listen-only" note
> on the voice bar — that's this rule in action, not a broken mic.

## Reconnection

Voice rides the same weather as everything else: if the connection drops,
the bar shows "Voice reconnecting…" and rejoins by itself. If you were
transmitting when it dropped, the mic is released — nobody gets stuck live
without knowing it.
