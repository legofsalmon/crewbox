# What buzzes a phone

The box decides what alerts, for each person, and sends each of their phones
finished alerts: who, where, what, and how loud. A phone's native code posts
what it is given. It never reads chat.

This page is the contract between the box (`server/src/alerts`), the rules
(`shared/src/alerts.ts`) and the phones (Android's `AlertsService`, the
iPhone's `CrewboxAlerts` provider, and the page itself). Every frame below has
a fixture in `native/android/app/src/test/resources/alerts-fixtures.json`,
written by `scripts/alerts-fixtures.mjs` and read by the Node and JVM tests,
so a frame is described once and every reader is held to it.

## Why the box decides

There were three copies of these rules and they disagreed. The page decided
in the browser. Android's service decided again, in Java, from the raw chat
protocol: it buzzed for every message in every channel, for "@Sammy" when you
are Sam, and for "@allison" as if it were "@all". The iPhone had nothing while
the app was out of sight. Half of what the rules need is only on the box
anyway: a person's read position on their other devices, their settings, the
running order and the festival's clock, and which system messages came from
the production desk.

## The rules

### Messages

For each person who can see the channel (everyone for a public channel, its
two members for a DM), except the author:

- Nothing from a retired channel, nothing the person has already read (`seq`
  at or below their read position), and no system message except the desk's.
- Each person sets each channel to **All messages**, **Mentions** or
  **Muted**. Every channel starts at **Mentions**, for everybody.

| What                            | All        | Mentions   | Muted     |
| ------------------------------- | ---------- | ---------- | --------- |
| A DM                            | `dm`       | `dm`       | nothing   |
| Their own name, `@Sam`          | `mention`  | `mention`  | `mention` |
| `@all`, `@everyone`, `@channel` | `everyone` | `everyone` | nothing   |
| The production desk             | `desk`     | `desk`     | nothing   |
| Anything else                   | `message`  | nothing    | nothing   |

A name needs a boundary after it: "@Sammy" is not Sam, and "@allison" is not
everyone. Your own name gets through a mute, because somebody needs you in
particular.

**One sound per channel per 30 seconds.** Further alerts in the same channel
within that time arrive quiet: posted, but silent. A channel set to All
messages during a busy changeover would otherwise buzz every few seconds.

### The show log

An entry alerts everyone but its author when it is a **show stop or a hold**,
isn't a correction (`amends` unset), and was written down within **15
minutes** of when it happened (`loggedAt − at`). The log is written after the
fact: an entry at 02:00 about a stop at 22:10 is history, and buzzing every
phone on site with "Show stop" at 02:00 would be alarming and wrong. These
are urgent: Time Sensitive on an iPhone, the alarm stream on Android.

### Changeover calls

For each stage a person follows, on the festival's clock (`CREWBOX_TZ`), with
the phones' own agenda maths so a call and the sidebar agree on who is next:

- **Changeover.** When a set ends and another follows it on that stage the
  same show day: _Changeover on Main Stage: The Hollows on in 30 min_. None
  for a gap of zero, nor after a set with no end time.
- **On in 5.** Five minutes before a set starts: _The Hollows on in 5 min_.
- **Moved.** When a set due on in the next two hours moves: _The Hollows now
  on at 21:45 (was 21:30)_. Not urgent. On an iPhone it is also what prompts
  somebody to open the app, so the Lock Screen countdown catches up.

The first two are urgent. A call's id includes the set's start, so a set that
moves re-arms its calls.

### Coming back

A phone that reconnects says when it last heard from the box, in the box's
own clock. The box answers with what it missed since then, unread, within
the last **12 hours**: at most **20** alerts, and a count of the rest.
Changeover calls come back only from the last **two minutes**. The phone
posts them all quietly but the newest, so it sounds once. A first connection
has no catch-up.

### Ids

Every alert has a stable id: `m:<message id>`, `i:<entry id>`, or
`c:<act id>:<call>:<show day>:<start>`. A phone sent one twice replaces the
notification instead of adding another, so a catch-up errs towards overlap.
With a margin of two minutes, a box clock that steps back by less than that
loses nothing.

## The socket

`/ws/alerts`, beside the chat socket. A box that has it says so in
`GET /api/config`, as `alerts: 1`, and a phone checks that before it opens the
socket. An older box doesn't answer 404 as the design assumed: it has no such
path and drops the upgrade without a word, which looks the same as a network
fault. So the config is the signal, and a phone that finds no `alerts` there
keeps its own rules for that box: Android its chat parsing, the page its own
banner rules.

### 1. The box proves itself first

The phone opens `/ws/alerts?nonce=<challenge>`, with 16 to 64 fresh random
bytes, base64url, as for `GET /api/identity`. The box's first frame is:

```json
{ "type": "box", "v": 1, "eventId": "…", "signature": "…", "beatMs": 30000, "t": 1780005400000 }
```

`signature` is made exactly as `GET /api/identity` makes one
([DISCOVERY.md](DISCOVERY.md), "How a box proves which event it is"): P-256
ECDSA with SHA-256, IEEE P1363, base64url, over

```
crewbox-identity-v1
<event id>
<the address the phone asked at, the Host header in lower case>
<the phone's challenge>
```

The phone checks it against the key it kept for the event and the address it
asked at, and only then sends its token. So a box that took over the
address, or anything else answering there, never sees this event's sign-in.
That matters most on the iPhone, whose provider starts on any Wi-Fi with a
registered name. `signature` is absent when the box won't sign for the
address it was reached at (a port forward, a name over plain HTTP); a phone
that kept a key then goes no further. A phone that kept no key for the event,
because it joined before boxes had keys, checks `eventId` alone.

### 2. Then the phone says hello

```json
{ "type": "hello", "token": "…", "since": 1780005100000, "timeZone": "Europe/London" }
```

`since` is when it last heard from this box (the largest `t` it has seen),
or `null` on a first connection. `timeZone` is the phone's IANA zone, for
the countdown. A dead session is closed with **4001**, as on `/ws`.

### 3. The box answers

```json
{ "type": "welcome", "t": …, "settings": {…}, "catchUp": [ …alerts ], "more": 3, "stages": [ … ] }
```

Then, as they happen:

| Frame      | Means                                                                      |
| ---------- | -------------------------------------------------------------------------- |
| `alert`    | Post `alert`.                                                              |
| `read`     | The person read `channelId` up to `seq` somewhere: take those alerts back. |
| `withdraw` | These alert `ids` are no longer true (a deleted message, a moved set).     |
| `settings` | The person's settings changed on another device.                           |
| `stages`   | The countdown for the stages they follow changed.                          |
| `beat`     | Answer with `{ "type": "beat", "t": <the same t> }`.                       |

Every frame from the box carries `t`, the box's clock. A phone keeps the
largest it has seen, for its next `since`. A frame a phone doesn't know is
skipped, never an error: a newer box may send more.

### An alert

```json
{
  "id": "m:m-7",
  "kind": "mention",
  "title": "Jo in #foh",
  "body": "@Sam can you check FOH",
  "target": { "kind": "channel", "channelId": "c-foh" },
  "thread": "c-foh",
  "quiet": false,
  "urgent": false,
  "at": 1780000000000,
  "from": { "id": "u-jo", "name": "Jo" },
  "seq": 12,
  "channelName": "foh"
}
```

- `kind`: `dm`, `mention`, `everyone`, `desk`, `message`, `showStop` or
  `changeover`.
- `target`: where a tap goes: `{ "kind": "channel", "channelId" }`,
  `{ "kind": "showlog" }` or `{ "kind": "stage", "stage" }`.
- `thread`: groups notifications: the channel, `showlog`, or `stage:<name>`.
- `quiet`: post it without sound.
- `urgent`: Time Sensitive on an iPhone; the Show stops or Changeover calls
  channel on Android.
- `from`, `seq`, `channelName`: for messages only. `from` is absent for the
  desk.

### On the phone

Both apps post an alert under its `id`, so a repeat replaces it, without
sound when `quiet`. A tap opens a `crewbox://open` link naming the event and
where to go: `&channel=<id>`, `&to=showlog` or `&stage=<name>`. The page
follows it only for the event it has open.

- **Android** (`AlertNotice.java`): messages as conversations on the
  Mentions or Messages channel, show stops on Show stops (the alarm stream),
  calls on Changeover calls. While the app is on screen it posts only show
  stops and calls; the page announces the rest.
- **iPhone** (`native/ios/App/Alerts/AlertPoster.swift`, the Local Push provider): the
  notification's `userInfo` carries `kind` (the alert's), `link`, `event`,
  and for a channel `channelId` and `seq`, which a `read` uses to take it
  back. `threadIdentifier` is `thread`; `urgent` is Time Sensitive. The
  app's delegate (`AlertsNotifications.swift`) shows `showStop` and
  `changeover` while the app is open and opens `link` on a tap.

### The countdown

`stages` lists each followed stage's set on now and the next, as instants
(epoch ms) worked out in the phone's own zone with the phones' own agenda
maths, so a phone's lock-screen countdown agrees with its own sidebar. The
phone counts to them with its own clock; the box's clock and the phone's are
never compared. `end` is `null` when the running order gives no end and
nothing follows.

On the iPhone the countdown is a Live Activity, which only the app can
update. The app never hears `stages`: the page works out the same thing
from its own running order with the same code (`countdownFor`) and hands it
to the app whenever the running order changes and whenever it is opened.
Its `staleDate` is five minutes after the next set is due on.

### Heartbeats

The box sends `beat` every `beatMs` (30 seconds) and the phone answers it.
Either end that hears nothing for **three** beats closes the socket, and the
phone reconnects and catches up. This is Apple's pattern for a Local Push
provider. The interval is in the first frame, so tuning it after the phone
tests needs only the box.

The socket counts as online, as Android's chat socket did: a person whose
phone is on the event Wi-Fi with the app signed in is reachable.

## Settings

Kept on the box, per person, because the iPhone's provider can't read the
page's storage, a person's phone and laptop should agree, and the box needs
them to decide:

- **Per channel:** `channel_members.alerts`, beside the read position.
- **Per stage:** the stages a person follows, by name, because the running
  order has no stage ids. A renamed stage loses its followers.

## Tests only a phone can run

These need a real phone, and for the iPhone, Apple's Local Push entitlement
and a Wi-Fi with no internet. None of it has been run yet.

**iPhone**

1. Join a Wi-Fi with no internet, mobile data on, iOS 26 or later. Lock the
   phone. From another device, @mention its person. It should buzz. Repeat
   with mobile data off, with no SIM, and on iOS 17 and 18.
2. Leave it locked on battery for several hours on the real box and access
   point, mentioning it now and then. Note how often it reconnects.
3. Log a show stop with the phone in a Focus that allows Time Sensitive
   notifications, with the capability on the app only, then on both targets.
4. Tap a notification with the app running, and with it force-quit.
5. Restart the phone, unlock it once, lock it, and mention it.
6. Watch the provider's memory in Instruments with messages arriving. Apple
   staff measured the limit at 24 MiB.

**Android**

1. Force Doze (`adb shell dumpsys deviceidle force-idle`), screen off, and
   time how late a mention arrives, and whether the box drops the phone.
2. Log a show stop with the phone on silent, on vibrate, and in Do Not
   Disturb, on a Pixel, a Samsung and a Xiaomi.
3. Mark a conversation Priority and mention the phone in Do Not Disturb.
4. Reboot, unlock, and mention it. Repeat on Xiaomi with Autostart off, and
   on Samsung with crewbox in sleeping apps.
5. Kill the process in the background, with and without the battery
   exemption, and mention it.
6. Follow a stage and show its countdown on the lock screen, on Android 16
   QPR2 or later: does the chip count, and what does it show after zero?
