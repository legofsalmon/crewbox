# Cue lights and the panic button

Two calls that go to a person rather than a channel, built on the alerts the
box already decides ([ALERTS.md](ALERTS.md)). The rules are
`shared/src/cues.ts`, the box's half is `server/src/cues.ts`, the page's is
`web/src/modules/cues` (the caller's pane), `web/src/components/CueLight.tsx`
(the operator's lamp), `PanicButton.tsx` and `PanicBar.tsx`. The user's page
is `site/docs-src/cue-lights.md`.

## Why they are live state

A cue and a call for help are what is happening now, so the box holds them
in memory and tells every device, as it does the on-air tally. Neither is
the chat log (nobody appends to a cue) nor a shared document (nobody edits
one). A box that restarts loses a standby the way a cue light loses power:
visibly, and the caller calls it again.

What has to outlive the moment goes where records already go. A call for
help, each person who goes, and its end are system messages in `#general`,
and the five-second clip is a file message beside them. System messages
never alert (ALERTS.md), so the record rings nobody twice.

## Cue lights

A cue is called to one person, by id.

| State        | Means                                  | Who moves it on                                   |
| ------------ | -------------------------------------- | ------------------------------------------------- |
| `standby`    | Called, not answered                   | The operator: `ready`. Anyone: `go`, `stand-down` |
| `ready`      | The operator said they are standing by | Anyone: `go`, `stand-down`                        |
| `go`         | Gone. History.                         |                                                   |
| `stood-down` | Called off, or the operator couldn't   |                                                   |

Only the operator answers a standby: a caller answering their own would be
the one lie a cue light must never tell. Anyone may finish one, because the
caller's phone is the one that dies at the wrong moment; `by` keeps who did
when it wasn't the caller. A standby left for **30 minutes** is stood down by
the box. The box keeps the last **40** finished cues for the pane, and they
go with a restart.

`actName` is what the running order said was on the cue's stage when the
standby was called, copied as the show log copies it, so the history keeps
saying "during The Hollows" after the running order moves.

### Alerts

| When           | To           | Alert                                                   |
| -------------- | ------------ | ------------------------------------------------------- |
| Standby called | The operator | `q:<cue id>`, `kind: cue`, urgent, "Standby: Pyro 1"    |
| GO             | The operator | `q:<cue id>` again, so it replaces the standby, "GO: …" |
| Standing by    | The caller   | `q:<cue id>:ready`, not urgent, "Jo is standing by"     |
| Stood down     | Both         | `withdraw` of `q:<cue id>`                              |

Cue alerts are never quiet. One sound per thread per 30 seconds is right for
a chatty channel and exactly wrong here: a GO twenty seconds after its
standby is the alert that matters most. `target` is `{ "kind": "cues" }`,
and a tap opens `crewbox://open?event=…&to=cues`.

## The panic button

Held for **2 seconds** (`PANIC_HOLD_MS`), longer than the design system's
`timing.hold`, because a false alarm rings every phone on site and the crew
stop believing the next one. A second hold while the first call is live is
the same call.

| When                    | To                       | Alert                                                 |
| ----------------------- | ------------------------ | ----------------------------------------------------- |
| Held                    | Everyone online but them | `p:<call id>`, `kind: panic`, urgent, "Jo needs help" |
| Somebody says I'm going | The caller               | `p:<call id>:<their id>`, urgent, "Ali is on the way" |
| Stood down, or lapsed   | Everyone                 | `withdraw` of every one of those ids                  |

Everyone, not a channel: until there are departments, a call narrowed to a
channel would miss whoever muted it. `target` is `#general`, where the
record and the clip are; a phone posts it as an alarm, not as a message in
that channel. A call nobody stands down lapses after **2 hours**, and
`#general` says so.

The clip is recorded on the device the button was held on, after the call
has gone: a microphone prompt, a busy microphone or a browser without
MediaRecorder costs the clip and nothing else.

## On the wire

Chat socket, client to box: `cueStandby { targetId, label, stage }`,
`cueStep { cueId, step: ready | go | stand-down }`, `panic {}`,
`panicStep { panicId, step: respond | stand-down }`. Box to every device:
`cue { cue }` and `panic { panic }`. The welcome carries `cues` (live, then
the history) and `panics` (live). All of it is additive: an older box drops
the new frames and sends neither field, and the page then hides the panic
button and says the box has no cue lights.

A press is refused, never queued, while the page can't reach the box. A
standby that turns up late is worse than one that never came, and a call
for help that seems sent and isn't is worse still; the page says to use the
radio.

A phone coming back onto the Wi-Fi gets, in its catch-up, a standby still
waiting for it, a GO from the last minute, and any call for help still
live. These go last and sounding, whatever their age: they are not history
yet.

## On the phones

- **Android** (`AlertNotice.java`): `cue` on **Cue lights** (`cues`), which
  vibrates in two long buzzes and has no sound, because a phone that rings
  in a wing is the wrong noise; it buzzes again when GO replaces the
  standby. `panic` on **Calls for help** (`panic`), on the alarm stream as
  show stops are, and posted while the app is open. Both channel ids are
  storage names and never change.
- **iPhone** (`AlertPoster.swift`): both Time Sensitive, with the default
  sound, since an iPhone vibrates only with one. `panic` shows while the app
  is open. Until Apple grants the Local Push entitlement, an iPhone hears
  them only while the app is open.
- **The page** lights the operator's whole screen for a standby and GO,
  buzzes with `navigator.vibrate`, and keeps the screen awake while a
  standby waits. It posts no banner for either: the lamp and the red bar are
  the announcement.

## Design

- **Standby is amber**, the system's attention colour: something is held,
  nothing is wrong yet. **GO is green.** That departs from the grammar,
  where green means healthy: every cue light in the industry is
  standby-then-green, and an operator reading a colour from a metre away
  should not have to learn ours. The word is always there too.
- **A call for help is red**, at the top of every screen: the most urgent
  thing the app can say.
- **Who is going is shown to everyone** (Social Proof, to coordinate), and
  an answered standby is shown to the caller (Commitment).

## Tests only a phone can run

None of these has been run.

1. Android, locked, in a pocket: call a standby, then GO 20 seconds later.
   Both should buzz, the second as hard as the first.
2. Android in Do Not Disturb, on silent: hold the panic button on another
   phone. It should ring. Repeat on a Samsung and a Xiaomi.
3. iPhone with the app open: call a standby. The screen should light and
   the phone vibrate (Safari has no `navigator.vibrate`, so check whether
   it does).
4. Any phone: hold for help and say where you are. The clip in #general
   should be audible, from an iPhone (`audio/mp4`) and from Android
   (`audio/webm`).
5. A standby to a phone that is off the Wi-Fi, which then comes back: it
   should ring on its return.
