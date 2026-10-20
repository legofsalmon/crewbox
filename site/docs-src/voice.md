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
- On a computer, **hold Space** to do the same — as long as you aren't
  typing in a text box ([all shortcuts](/docs/shortcuts)).
- The **lock** button latches your mic open — for gloved hands or a long
  explanation. Tap again to release. The bar shows everyone whose mic is
  open, so a stuck latch is visible to the whole line.
- A "🔊" pill names whoever is speaking right now.

## Party line: hear several channels, talk on one

Like a beltpack, you can keep an ear on other channels while you talk on
your own. Your voice only ever goes to one channel: the one on the voice
bar.

- While you're on voice, every other channel's header has an **ear**
  button next to the headset. Tap it to hear that channel too; tap it again
  to stop. You can hear up to three channels besides the one you talk on.
- The channels you're hearing sit in an **Also hearing** row under the
  voice bar, each with who's speaking on it (or how many people are on it).
  The **×** stops hearing it.
- **Talk here** on one of them swaps: you now talk on that channel, and the
  one you were talking on joins the row so you keep hearing it. Your mic is
  closed during the swap, and a locked mic is unlocked, so nothing you were
  saying spills into the other channel.
- With more than one channel in your ears, the talk button names where your
  voice goes ("to #foh"), and the 🔊 pill says which channel each speaker
  is on.
- On the voice bar, people with a **dashed** outline are listening to your
  channel from their own: they hear you, but they can't answer there.
- The headset button still moves you: joining voice in another channel's
  header makes it your talk channel and leaves the old one, as before.
  Leaving voice leaves every channel.

Each channel you hear is its own connection to the box, which is why
there's a limit. Private channels and DMs stay private: you can only hear a
channel you're a member of.

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

- The **Android app** is exempt — it uses the phone's own mic
  permission and works over plain HTTP.
- The box's operator can give the box a certificate —
  [HTTPS, names and certificates](/docs/https-and-voice) is the recipe —
  which also unlocks installing the web app to home screens.
- The machine **running** the box is always fine at `localhost`.

> [!NOTE]
> If you joined and can hear but not speak, look for the "listen-only" note
> on the voice bar — that's this rule in action, not a broken mic.

## Reconnection

Voice rides the same weather as everything else: if the connection drops,
the bar shows "Voice reconnecting…" and rejoins by itself. If you were
transmitting when it dropped, the mic is released — nobody gets stuck live
without knowing it.
