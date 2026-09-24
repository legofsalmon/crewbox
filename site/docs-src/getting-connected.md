---
title: Getting connected
section: Start here
order: 20
blurb: Scan the QR, pick a name, set a PIN — and how to get back in later.
---

# Getting connected

Joining takes one scan and three fields. You make up your own name and PIN on
the spot — there are no accounts to create in advance and no email involved.

![The join screen: name, event PIN, your PIN](shot:join-screen)

## Join for the first time

![The /connect page: QR code, join link and event PIN](shot:connect-page)

1. Join the event Wi-Fi named on the poster (if your phone isn't on it
   already).
2. Scan the QR code — it's on the join poster, on the box's screen, or on
   the `/connect` page someone may have sent you. In the phone app, scan it
   from the app: tap **Scan the join poster** and point the camera at the
   QR, and the app fills in the box's address and the event PIN. The
   phone's own camera would open the QR in the browser instead. Or skip the
   scan: the join screen lists the boxes on this Wi-Fi under **On this
   Wi-Fi**, and tapping **Pick** beside your event fills in its address. On
   an iPhone, tap **Find boxes** the first time, and allow Crewbox to find
   devices on your local network when the iPhone asks.

3. You'll land on the join screen. Fill in:

- **Your name** — what the rest of the crew will see. Adding your role or
  stage helps: "Alex (Stage 2)".
- **Event PIN** — the 4-digit code printed next to the QR. If you scanned
  the QR it's usually filled in for you.
- **Your PIN** — 4 to 8 digits **you invent right now**. This is yours;
  remember it. It's how you sign back in on any device.

4. Tap **Join**. You're in `#general` with the rest of the crew.

> [!NOTE]
> **Remember Your PIN.** Your name plus Your PIN is the whole of your
> identity here. There's no email reset — if you forget it, an admin has to
> reset it for you from the admin panel.

## The three codes, untangled

Crewbox has three different secrets, and every crew ever assembled has mixed
them up at least once:

| Code               | Who uses it        | What it's for                                                                                                                           |
| ------------------ | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| **Event PIN**      | Everyone, once     | Lets a new person join this event. It's on the poster — it's not meant to be very secret.                                               |
| **Your PIN**       | Just you           | Signs you back in as you, on any device. Made up by you when you first join.                                                            |
| **Admin password** | The box's operator | Unlocks the admin panel — settings, crew management, exports. The box printed it when it was first set up. It is **not** the event PIN. |

## Signing back in

Joining and signing in are the same screen. Type the **same name** you used
before and **Your PIN**, and you're back — with your channels and unread
state. You don't need the event PIN again.

This also means you can move between devices freely: same name, same PIN, on
a phone at the barricade and a laptop at front of house.

If you type a name that's already taken and the PIN doesn't match, crewbox
says so — either you've misremembered your PIN, or someone else got to that
name first. Pick another name, or ask an admin to reset your PIN.

## More than one event

Each event keeps its own messages, documents and unsent work on your
device, so last week's sheets never turn up at this week's box. To go on to
the next event's box, sign out and join it. Your device keeps the old event
too: **Your boxes**, at the top of the menu, lists every event it holds, and
one tap opens another. In the phone apps it also lists the other boxes on
this Wi-Fi, with **Join** beside each, and marks an event of yours _On this
Wi-Fi_ when its box is here, at a new address too once the box has shown it
is the same one.

- **"The box at … has changed, and is starting afresh"**, or **"… is running
  … now"**: the box at that address is running another event than the one
  you had open, a spare box or next week's. Your device has sent it nothing.
  Tap **Open it** to join it. Everything from before stays on your device.
- **"The box at … is running …, which this phone knew at …"**: your
  event's own box, now at another address. Your device checked it first,
  with the key it kept when you joined, so **Open it** carries on there.
- **"The box at … says it is running …, but it can’t show that it is that
  event’s box"**: something at that address says it runs an event your
  device holds somewhere else, and failed that check. Nothing has gone to
  it, and your device still has the event where it was. Type the address
  from the event's join poster in **Your boxes**. If you are sure it is your
  event's box, restored from an old backup, **Open it anyway** is beside
  the message there.
- **"Bring your work across?"** is asked once, after you join a box that
  started afresh where your event's box was. **Move it here** brings your
  documents and running order, sends your unsent messages to the channels
  with the same names, and files your unsent show-log entries in its log.
  Messages to a person or with a file stay behind, and so do show-log
  entries written more than a day ago, which no box takes. Messages for a
  channel the new box doesn't have yet stay too: once an admin has made it,
  bring them across from that event's row in **Your boxes**. The old chat
  stays on your device to read.
- **Forget**, beside an event in **Your boxes**, deletes what your device
  keeps for it. It says first what that is, and warns you about anything
  that never reached the box, because nothing else has a copy of that.

## When it won't connect

The app tells you what it's doing rather than spinning forever:

- **"Can't reach the crew server"** — your phone can't see the box. Check
  you're on the event Wi-Fi (the screen names it), then tap **Retry now**.
  It also keeps retrying by itself. In the phone apps, a box that has moved
  to a new address never answers the old one, so after a little while the
  app looks for it on the Wi-Fi. If it finds your event's box somewhere
  else, and the box shows it is the same one with the key your device kept
  when you joined, the app carries on there by itself and says so: nothing
  goes to a box that can't show it. If it isn't found, tap **Your boxes** and
  type the address from its join poster.
- **"No boxes found on this Wi-Fi"** — in the phone apps, nothing on this
  network said it was a box. Check you're on the crew Wi-Fi. The box may not
  be announcing itself (an admin can see why under **Admin → This box**), or
  the Wi-Fi may not pass announcements on; typing the address from the join
  poster works either way.
- **"This iPhone doesn't let Crewbox look on the local network"** — Local
  Network is off for Crewbox. Tap **Open Settings** and switch it on, or
  type the address from the join poster, which works without it.
- **"That code is for the Wi-Fi, …"** — in the phone apps, the scanner read
  the Wi-Fi poster's QR, which is often on the same wall. Join that network
  with the phone's own camera or its Wi-Fi settings, then scan the crew
  code.
- **"That isn't the crew code"** — the scanner read a QR that isn't a box's
  join code. Scan the one on the join poster, or type the address printed
  under it.
- **"Crewbox isn't allowed to use the camera"** — the camera is off for
  Crewbox. Tap **Open Settings** and allow it, or type the address from the
  join poster.
- **"This phone can't scan codes"** — the phone has no camera the scanner
  can use. Type the address from the join poster.
- **"An iPhone only connects to a name like … over HTTPS"** — in the iPhone
  app, you typed the box's name without `https://`. Type `https://` before
  it if the box has a certificate, or use the box's IP address from the join
  poster instead.
- **Yellow "Connecting…" banner** — you were connected and it dropped.
  Anything you send is queued on your device and delivered when the
  connection returns; nothing is lost.
- **"Offline" banner** — same story, longer gap. Everything you already
  loaded stays readable, and the app catches up the moment the box is back
  in reach.

There's more in [Troubleshooting](/docs/troubleshooting).
