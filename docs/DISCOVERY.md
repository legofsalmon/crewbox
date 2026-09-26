# How the apps find a box

A crew phone on the event Wi-Fi should not need anybody to read out an IP
address. The box says where it is the way a printer or a sound desk does:
multicast DNS ([RFC 6762](https://www.rfc-editor.org/rfc/rfc6762)) carrying a
DNS-SD service ([RFC 6763](https://www.rfc-editor.org/rfc/rfc6763)), which is
what Apple calls Bonjour. The phone apps browse for it; nothing else about
joining changes.

This page is the contract between the box (`server/src/announce`) and the
apps. It says what the box announces, where, and what an app may and may not
conclude from it.

## Where it speaks

**Only on the crew adapter.** The box's watchers never transmit
([NETWATCH.md](NETWATCH.md), [DMX_MONITORING.md](DMX_MONITORING.md)), and this
is the one thing the box multicasts, so where it goes is the whole design:

- It opens its own socket, joins `224.0.0.251` on the crew adapter, and sends
  by that adapter alone (`IP_MULTICAST_IF`), whatever the routing table thinks
  of `224.0.0.0/4`.
- It answers only questions from the crew adapter's own subnet, and ignores
  everything else it hears. A socket bound to port 5353 hears the other
  adapters' multicast too on Linux, so this is a check in the code, not a
  property of the socket.
- It needs to know which adapter is the crew's: the one set as the crew
  network (`CREWBOX_IFACE`, or **Admin → This box → Networks**), or the only
  one the box has. A box with several adapters and none chosen stays quiet and
  says why.

The setting (**Admin → This box**, or `CREWBOX_ANNOUNCE`, which outranks it):

| Setting       | What it does                                                                                                                                                                |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Automatic** | Announces on the crew adapter, unless a watcher is on it too or was left to the operating system's choice: then the crew network may be a show network, and it stays quiet. |
| **Always**    | Announces on the crew adapter even when a watcher shares it, for a rig whose crew and show share one network on purpose.                                                    |
| **Never**     | Nothing.                                                                                                                                                                    |

Unset and never chosen, a packaged box is automatic and a source run is off,
the rule the captive responder follows. The admin panel shows what the box is
doing, or why it is quiet, in words, and changes take effect at once.

Adapters are looked at again every fifteen seconds: a crew adapter that comes
up after boot gets the box announced on it, one that goes takes the
announcement with it, and a port that would not open is tried again rather
than given up on.

## What it says

One service instance of type **`_crewbox._tcp`** in `local.`:

| Record              | Contents                                                                                                                 |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| PTR `_crewbox._tcp` | The instance. Its label is the event's name (cut to 63 bytes without splitting a character), `crewbox` when it has none. |
| SRV                 | The crew port, and the host `crewbox-<first six hex digits of SHA-256(event ID)>.local`.                                 |
| TXT                 | The keys below.                                                                                                          |
| A                   | The crew adapter's IPv4 address. No AAAA: the box's crew address is IPv4, and an NSEC record says so.                    |

TXT keys, all lower case. An app must ignore keys it does not know, since
later boxes may add some.

| Key         | Value                                                                                                                               |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `txtvers`   | `1`, the version of this table.                                                                                                     |
| `id`        | The event's ID (`PublicConfig.eventId`): its database's, minted once. Tells one event's box from another's at the same address.     |
| `name`      | The event's name in full, up to 250 bytes, where the instance label may have been cut or numbered. Empty before the event is named. |
| `ver`       | The box's version, as `/api/health` gives it.                                                                                       |
| `proto`     | The wire protocol's generation (`PROTOCOL_VERSION`).                                                                                |
| `setup`     | `1` once the box has been set up, `0` for a new box nobody has.                                                                     |
| `tls`       | Present when the crew port speaks HTTPS. Its value, when there is one, is the name on the certificate, which is what to connect by. |
| `continues` | Present when an admin has said this box carries on another event: that event's ID ([below](#a-box-that-carries-on-another-event)).  |

Nothing else, and never a PIN, a password or the Wi-Fi's: the TXT record says
what the join screen already shows anybody who reaches the box. The privacy
page says so to the crew.

## What an app may conclude

**It is a hint, not an identity.** Anything on the crew Wi-Fi can announce
`_crewbox._tcp` with any TXT record it likes. An app may list what it finds
and use it to fill in an address, but it must confirm, by connecting, that the
box at that address is the one it thinks: `GET /api/config` returns the event's
ID, and a box the app has joined before proves itself with its signing key
([below](#how-a-box-proves-which-event-it-is)). An app must never send
credentials to an address because of what a TXT record said.

When `tls` names a certificate, connect by that name, as crew typing it would;
the address in the A record is for a box without one.

## How a box proves which event it is

An event ID is public, so on its own it proves nothing. Each box also has a
P-256 signing key, minted with its database and kept in it
(`server/src/identity.ts`), so a backup carries the key with the ID: a spare
restored from last night's backup proves itself as the same event, and a spare
started with a fresh database has an ID and key of its own and is another
event.

- `GET /api/config`, and the answer to `POST /api/join`, carry the public key
  as `eventKey`: the uncompressed point (65 bytes: `0x04`, then x and y),
  base64url, which WebCrypto imports as `raw` with
  `{ name: 'ECDSA', namedCurve: 'P-256' }`. An app keeps the key it was given
  when it joined, with the event.
- `GET /api/identity?nonce=<challenge>` answers
  `{ "eventId", "key", "signature" }`. The challenge is 16 to 64 random bytes,
  base64url, fresh each time; anything else is a 400. The signature is ECDSA
  with SHA-256 over the UTF-8 bytes of these four lines, with no line break
  after the last:

  ```
  crewbox-identity-v1
  <eventId>
  <host>
  <challenge>
  ```

  `<host>` is the request's Host header in lower case: the address the app
  connected to, as `new URL(origin).host` gives it, with the port unless it
  is the scheme's default. The signature is in IEEE P1363 form (r, then s,
  64 bytes), base64url, which is what WebCrypto's `verify` takes, with s in
  the lower half of the group, so that a stricter verifier, one that takes
  only that half, accepts it too.

- **Check it against the key you kept and the address you connected to,
  never against the key in the answer.** Anything can send a key and a
  signature that agree with each other. A box whose answer verifies against
  the key kept for that event, over the address the app asked at, holds that
  event's database and was reached there, and the app may follow the event to
  that address. One whose answer doesn't, or that has no key, is another box
  however it announces itself: say so and ask, as the app does for a box that
  has started afresh.
- **A box signs only for an address that is its own.** It answers 421
  (Misdirected Request) instead of signing when the Host header is:
  - an IP address other than the one the request arrived at,
  - `localhost`, unless the request came over loopback from the box's own
    machine, or
  - any name, unless it is on the certificate the request was served with over
    TLS. Over plain HTTP a name proves nothing, since whoever asks can put any
    name in the header.

  An app treats a 421 as a box it cannot check. A box reached through a port
  forward, or by a name over plain HTTP (`crewbox.local`, typed), is one.

- All of it is public and needs no sign-in, so an app checks a box before it
  sends it a token or anything of the event's.
- An app holding an event from before its box had a key takes the key from
  that box the next time it connects to it at the address it syncs with,
  never from a box found somewhere else.

Why the address is signed: without it, anything on the Wi-Fi could announce a
phone's event at its own address, pass the phone's challenge on to the real
box and the answer back, and stand between the phone and its box from then
on. With it, the box won't sign for the relay's address, and an answer signed
for the box's own address fails the check on a phone that connected to the
relay.

What it does not do: on plain HTTP, something on the path to the box's own
address (by spoofing ARP or DHCP on the Wi-Fi, which a managed access point
can refuse) can still pass challenges through, because the phone did connect
to the box's address. The signature proves that a box holding the key
answered at that address, not that nothing stands between; HTTPS (the `tls`
key above) closes that. What it does stop is an app following its event to
the wrong box: another event's, a stale address now used by something else,
anything announcing an ID it copied, or a relay announcing the event at its
own address.

A box that predates this has no `eventKey` and answers `/api/identity` with a
404; an app treats it as any box it cannot check.

## How the apps check a box

What the apps do with all this (`web/src/lib/identity.ts`):

- **They keep the first key.** Joining an event keeps the `eventKey` from the
  sign-in with it. A key kept is never swapped for another a box offers:
  that is what it is there to catch.
- **They check before an event moves.** Where a box says it runs an event
  this phone holds at another address, the app sends it a fresh 32-byte
  challenge and verifies the answer against the kept key, over the address it
  asked at. Until that is done, and unless it passes, nothing of either
  event's goes to the box and neither event's records change.
- **Three outcomes.** _Proven_: the kept key signed for this event, this
  address and this challenge. _Refused_: the box answered, and said another
  event or gave a signature the kept key did not make. _Unchecked_: there was
  nothing to check with (no key kept, or a page without WebCrypto, as a
  browser on a plain-HTTP box is) or nothing to check: no answer, a box too
  old to sign (404), or one that won't sign for the address asked at (421).

What each allows depends on how the app came to the box:

- **At the address it already uses**, when the box there now says it runs
  another event this phone holds, the app follows the event there only when
  it is proven, and then says so, with **Open it**: _The box at … is running
  “…”, which this phone knew at …_. While it checks, and if it is refused or
  can't be checked, it says what the box claims and that nothing has gone to
  it, and points to **Your boxes**, where an address can be typed. The event
  stays where the phone knows it.
- **Found on the Wi-Fi**, announcing an event this phone holds at another
  address, the app follows the event there only when it is proven, on a
  proof from the last minute, and only to one box
  ([below](#following-an-event-to-its-box)).
- **At an address somebody typed**, in **Your boxes** or on the join screen,
  it goes ahead unless refused: the address was theirs to give, and a box
  behind a port forward, or one too old to sign, is taken at their word, as
  before. The join screen checks before the PIN goes, and checks the
  sign-in's event again after, in case the box's config could not be read
  first or said another event.
- **Scanned from a poster** that names the event and its key, the box has to
  be the poster's before the PIN goes, whatever this phone holds
  ([below](#the-join-qr)).
- **Refused** is said in so many words, and nothing goes to the box. In **Your
  boxes**, a refused box that offered a key of its own also gets **Open it
  anyway**, for a spare restored from a backup older than the event's key,
  which is the event's box and can't show it. Opening it that way keeps the
  key it offered in place of the old one; nothing else replaces a kept key.

A box at the address the phone already has, saying it runs the event the
phone has open there, is taken at its word, as before: the app does not ask
it to prove itself each time it connects.

The alerts socket is the exception ([ALERTS.md](ALERTS.md), "The box proves
itself first"). Android's alerts service and the iPhone's Local Push
provider connect without anybody looking, and the iPhone's starts on any
Wi-Fi with the crew network's name. So each sends a fresh challenge every
time, and sends the sign-in only when the box signs it with the kept key
for the address asked at, or, for an event joined before boxes had keys,
says it runs the event. The same statement is signed, with the same code on
the box.

## The join QR

The QR a box prints for crew, on `/connect` and in its console at start-up
(`server/src/joinCode.ts`), is a link to the box that also names the event:

```
http://192.168.8.1:8787/?pin=4821&event=<eventId>&key=<eventKey>
```

- `pin` is the event PIN, only where whoever reads it may be shown it:
  `/connect` leaves it out of the QR, as out of print, for a request from off
  the LAN.
- `event` and `key` are the event's ID and public key as `/api/config` gives
  them to anyone, the key in full: 87 characters, the form the apps keep.
  They are on it everywhere but at an IP address that isn't the box's own,
  as a port forward's (`namesEventAt`): the box never signs there, and the
  apps would refuse the poster (below), so it joins as an older one does.
- A phone's own camera opens the link in the browser, where `pin` fills in
  the join form and the rest goes unread. The apps' scanner reads all of it
  (`web/src/lib/joinCode.ts`).

Why the key is on it: the poster is the one thing a crew member has that came
from the event's box rather than over the network. Without it, the event PIN
and a new crew member's personal PIN went to whatever answered at the
poster's address: on the wrong Wi-Fi, another stage's box at the same default
address, a router, anything. With it, the box there has to sign for the
poster's event with its key first, which only the box holding the event's
database can. Wi-Fi Easy Connect puts a whole public key in its QR codes for
the same reason: the code is how the key arrives by a way the network can't
touch. A fingerprint of the key would make a smaller code, with
the phone taking the key the box offers and checking it against the
fingerprint; the whole key keeps to the one form the apps already keep and
compare, with no hashing scheme of its own to get right.

What the apps do with a poster that names its event (`checkPoster` in
`web/src/lib/identity.ts`), before the PIN goes to the box at its address:

- **Proven** against the poster's key: the join goes ahead, and the app keeps
  the poster's key for the event, which from then on is what it checks that
  event's boxes against. A move of an event this phone holds elsewhere is
  proven by the same check.
- **Refused**, or a box that can't sign at all (a 404, or a key that isn't a
  point on the curve): nothing goes to it, and the join screen says _The box
  at … isn’t the one on this poster, so nothing has gone to it._ Most often
  the phone is on another Wi-Fi, where something else has that address.
- **At an IP address, a box that won't sign for it (421) is refused too.** A
  box reached at its own address signs for it, so one that won't is behind a
  port forward or isn't the poster's box, and a 421 is all anything would
  have to answer to be let past. The address can still be typed, and is
  then joined as a typed address is.
- **Unchecked**: a box reached by a name that won't sign for it (421), as a
  box never does over plain HTTP or through a tunnel, or a web view without
  WebCrypto. The join goes ahead, and the sign-in has to name the poster's
  event and key, or the app keeps nothing of it and says so. That catches
  the wrong box, not one set on the PIN, which can answer 421 and name the
  poster's event: by a name, only HTTPS to a box holding its own certificate
  stops that, since nothing else can answer by its name.
- **No answer**: the join screen says the box can't be reached, as for any
  address.
- **A poster for an event this phone holds with another key** is refused
  without asking the box: a poster is no reason to swap a kept key. The app
  says so, and points to **Your boxes**, as for a refused box.

The check belongs to the poster while the address is the one it gave. Typing
over the address, picking a box from the list or following a
`crewbox://join` link joins as a typed address does. A link names no key,
and shouldn't: the page that offers it is served by the box it would vouch
for.

A poster printed before the QR named the event, or naming it in a form the
app doesn't take, has an address and a PIN, and joins as it always did,
unchecked.

**Printed posters** from `deploy/make-poster.mjs` name the event too, when
the box at the address given proves it there as the apps will ask it to: the
script reads the event and key from `/api/config`, and checks the box's
signature for that address over a fresh challenge (`posterEvent`). By a name
the box has no certificate for, it names the event, and the apps check the
sign-in. At an address where the box won't sign, or with no box answering,
the poster names no event, and the script says why and that phones will
join from it unchecked. So run it where the poster's address reaches the
box.

**When the event gets a new ID, print new posters.** A spare box started
without the event's backup is another event, with an ID and key of its own,
and the apps refuse the old posters there: print `/connect` again from the
spare. A spare restored from the backup has the event's ID and key, and the
posters on the wall still work.

The key makes the code longer: about 150 characters with a LAN address and a
PIN, version 8 or 9 at error correction M (49 or 53 modules across) where the
address and PIN alone were version 3 (29). `/connect` draws it the full width
of its card, one SVG unit to a module, so at a laptop's width each module is
still seven-eighths of its old size; the console draws it at level L, 47
characters wide. Both were checked by decoding them with ZXing, the page's at
a phone's and a laptop's width.

## How the apps look

The iPhone and Android apps browse for `_crewbox._tcp` while a screen that
lists boxes is open: the join screen and **Your boxes**. They also browse while
the app can't reach its box: once nothing has answered at its address for 25
seconds, or something else has (a box running another event), until the box
is back ([below](#following-an-event-to-its-box)). A web page has no way to
browse, so in a browser none of this happens. The page
(`web/src/lib/discovery.ts`) asks the app's `CrewboxDiscovery` plugin to look
(`native/ios/App/App/DiscoveryPlugin.swift`, and `DiscoveryPlugin.java` in the
Android app), and the plugin passes on each service's name, IPv4 addresses and
port, and the TXT keys above. Nothing else.

**Only while somebody is looking.** The search stops when the screen closes,
when the box answers again, and when the app goes to the background, and starts
again when the app is back in front with a reason to look. Nothing looks on a
phone in a pocket.

**On an iPhone**, the first search is what brings up iOS's Local Network
alert, so the app doesn't start one until the crew member taps **Find boxes**,
under a line saying what the alert will ask. After that it looks by itself, for
a box it has lost too; until then it doesn't look for one, rather than bring up
the alert unasked.
The rest is what Apple's
[TN3179](https://developer.apple.com/documentation/technotes/tn3179-understanding-local-network-privacy)
asks:

- `Info.plist` lists `_crewbox._tcp` in `NSBonjourServices`, without which iOS
  refuses the browse, and `NSLocalNetworkUsageDescription` is the alert's
  text.
- NWBrowser finds the services and their TXT records. Network framework cannot
  turn a service into an address (Apple's advice on the developer forums,
  [thread 673771](https://developer.apple.com/forums/thread/673771)), so each
  one found is looked up with NetService.
- A search refused because Local Network is off for the app waits with
  PolicyDenied. The screen says so, with an **Open Settings** button, and the
  search starts afresh when the app comes back to the front.
- A search is never started while the app is in the background: iOS refuses
  one there without asking, and doesn't remember that it did.

**On Android**, NsdManager browses. Nothing is asked of the user: at the app's
target (API 36) local network access comes with the internet permission.

- On Android 14 and later each service found is followed with
  `registerServiceInfoCallback`, which keeps its address current. Before
  that, `resolveService` handles one service at a time, with no time limit
  that its source shows, so the app resolves them in turn, allows each ten
  seconds, and tries one that failed again a second later, three times at
  most.
- Android 12 and earlier, and Android 13 without the T extensions 7 update,
  hear mDNS only while an app holds a multicast lock. The app takes one there,
  only while it is looking; that is what `CHANGE_WIFI_MULTICAST_STATE` is for,
  a permission granted at install that nobody is asked about.
- Android 17 blocks the local network for an app that targets it until the
  user allows it (`ACCESS_LOCAL_NETWORK`). The app passes that refusal on as
  it does the iPhone's; raising the target will need the permission in the
  manifest and a way to ask for it.
- With mobile data on, Android sends an app's traffic over mobile data rather
  than a Wi-Fi with no internet, and a box found on that Wi-Fi can't be
  reached that way. So while the search runs on such a Wi-Fi, the app's
  traffic goes over it (`SiteWifi.java`), and asking a found box, or
  following one, reaches it. The app's own box keeps it there too, whenever
  its address is on the Wi-Fi. A connection keeps the network it opened on,
  so each time the app's traffic moves, the page gets an `online` event, which
  the web view never sends by itself, and the chat socket, the documents,
  voice and the alerts service try again at once.

**What they list.** Each box found is a row: the event's name from `name`, and
the address the app would connect to, the certificate's name from `tls` where
there is one and the IPv4 address otherwise. Every box is looked up as soon as
it is found, which Apple's engineers call a faux pas on a busy network; a crew
Wi-Fi has a box or two, and without the address the app can't tell a box it
knows from one it doesn't.

- A box nobody has set up says so, with its setup address, and has no button.
- Two boxes with one event ID, or one name, each say another box here has the
  same name, and to check the address on the join poster.
- **An event this phone holds is never listed.** Where its box answers at the
  address the phone knows, **Your boxes** marks that row _On this Wi-Fi_.
  Anything announcing it at another address is left out: listing it would put
  the phone's work one tap from going somewhere else. Instead the box there
  is asked to prove it, and the event follows it only if it does
  ([below](#following-an-event-to-its-box)).

**Picking one asks the box.** Before using an address it found, the app asks
for `/api/config` there, and takes the event's ID and name from the box's
answer, not the announcement's. A box that doesn't answer, one too old to say
which event it is, and one saying it runs an event this phone holds at another
address are each refused, in a line saying which, and nothing changes. On the
join screen a picked box fills in the server field and moves on to the name;
in **Your boxes** it opens that event, as typing its address would.

### Following an event to its box

A box announcing an event this phone holds, at an address other than the one
the phone knows it by, is sent a fresh challenge and nothing else
([above](#how-the-apps-check-a-box)). If it proves itself, the event goes there
(`web/src/lib/follow.ts`):

- **The open event, while the app can't reach its box.** The app goes on with
  it at the new address without reloading, so a message half typed or a
  sheet being read stays as it is, and says so: _Your box is at a new
  address, …. This phone found it and carried on there._ The socket goes to
  the new address, which gets the sign-in and whatever was queued as it
  would after any reconnect. The shared documents let go of the old address
  at once and join at the new one only once that box has let the phone in.
- **Any other event, while Your boxes is open.** Only its record changes: its
  row shows the new address, marked _On this Wi-Fi_, and opening it goes
  there.
- **Only on a proof from the last minute.** A box that didn't prove itself is
  asked again a minute later, and one that did is followed within the minute
  or asked again: what had an address a while ago says nothing about what
  has it now.
- **Only to one box.** Two boxes that both prove one event are a box and a
  spare restored from its backup, and which one the crew are on is not for a
  phone to guess: it stays where it is until one of them goes, or somebody
  types an address in **Your boxes**.
- **Only an event whose key the phone kept.** One joined before its box had a
  key is never followed from an announcement, and neither is a box too old
  to sign, or one that won't sign for the address it was found at, as behind
  a port forward. Its address can still be typed.
- **Never while the app reaches its box**, even where the same box announces
  itself at a second address too.

## A box that carries on another event

A spare with no backup, or a bigger box brought in mid-event, starts with a
database of its own, so to every phone it is another event: they send it
nothing of the one they had ([above](#how-the-apps-check-a-box)). What it can
be given is its admin's word that it carries that event on
(`server/src/continues.ts`):

- **Where it is said.** **Admin → This box → Carries on another event** lists
  the events the admin's device has been on, other than this box's own, since
  an event's ID is nothing anybody types. The panel reads it from
  `GET /api/admin/settings` as `continues: { id, name } | null` and sets it with
  `PATCH /api/admin/settings`, which refuses the box's own event and anything
  that isn't an event ID. It is kept in the settings table under `continues`,
  a storage name. It stays open on an unlicensed box, since it is how a spare
  takes over mid-show.
- **Where the box says it.** The event's ID, and nothing else, as `continues`
  in `/api/config`, in the answer to `/api/join`, in the welcome's config and
  live to phones already on the box, and in the TXT record.
- **It is not a proof.** Only the old event's own database could sign for it,
  and that is on the box that has gone. So a phone takes it only as leave to
  ask. Nothing moves without a yes, and nothing about the old event's box
  changes: the new box stays another event, with its own key, and the old
  event keeps its address and key, for when its box is back.

What the apps do with it (`web/src/lib/eventScope.ts`, `lib/moveWork.ts`):

- **From the box running the open event only.** A phone that has joined a box
  saying it carries on an event this phone holds asks, once,
  _Bring your work across?_, wherever the old event's box was. The old event's
  row in **Your boxes** keeps the offer, saying _This box carries it on._ The
  question is asked once for each box that says so; another box saying it
  carries on the same event asks again.
- **Not without it.** A new database at the address a phone knows its event
  by is as likely to be next week's event as a spare, and a question would
  invite last week's sheets into it. So nothing asks: the old event's row in
  **Your boxes** offers the move, saying _Its box started afresh_, for
  somebody who goes looking. A box at that address saying it carries on some
  other event doesn't get even that.
- **Before joining,** a box at the phone's own address saying it carries on
  the open event says so on the screen, _The box at … has changed, and
  carries on “…”_, and still waits for **Open it**. In the list of boxes on
  this Wi-Fi, a box whose TXT record says it carries on an event this phone
  holds says _Carries on …_, with the name this phone knows. Picking it is as
  for any box.

What moves is the same either way: documents and the running order merge,
unsent messages go to the channels with the same names, and unsent show-log
entries from the last day go to the new box's log. The chat history comes
back only from a backup.

## How it behaves on the network

What RFC 6762 asks of a responder, and where the code does it
(`server/src/announce/responder.ts`):

- **Claims its names first.** Three probes 250 ms apart (the first after a
  random 0 to 250 ms), questions of type ANY asking for a multicast answer,
  and the records it would claim in the authority section (§8.1). Then two
  announcements a second apart (§8.3). §8.1 suggests asking for a unicast
  answer; why the box doesn't is under [Sharing port 5353](#sharing-port-5353).
- **Never takes a name another device has.** A reply showing either name in
  use, while probing or afterwards, moves it to the next number: `Event (2)`,
  `crewbox-3f9a1c-2` (§8.1, §9). Two devices probing for one name at once
  compare their records, and the one whose data sorts first waits a second
  and probes again (§8.2). Fifteen conflicts in ten seconds slow it to one
  probe every five.
- **Defends its names**, answering another device's probe for them at once.
- **Answers phones.** Shared records (the PTR) after 20 to 120 ms so answers
  from several boxes spread out, and unique ones at once (§6). What a phone
  will ask next rides along in the additional section: a PTR brings SRV, TXT,
  A and the NSEC saying there is no AAAA, and an SRV brings A and that NSEC
  (RFC 6763 §12), which saves Android a round of questions, since it asks for
  an address only once it knows the host's name.
- **Waits for the rest of a long question.** A phone holding more answers
  than fit in one packet sends the rest after it, and says so with the TC
  bit. The box answers 400 to 500 ms after the last packet that says more
  are coming, and leaves out whatever those packets list, matching them to
  the phone by its address (§7.2). A phone's answer is its own: another
  phone waiting for the same record still gets it.
- **Leaves out what the phone already knows**, when its copy has at least half
  its life left (§7.1), and sends a record at most once a second, or four
  times a second while defending (§6).
- **Answers a question that asks for a unicast reply with one**, when the
  record went out by multicast within the last quarter of its life (§5.4),
  and a one-shot question from a port other than 5353 straight back to that
  port, with the question repeated, TTLs of ten seconds or less and no
  cache-flush bits (§6.7).
- **Says goodbye** (TTL 0) when it stops, is turned off, or the event is
  renamed, so phones drop the old entry now rather than when it lapses:
  75 minutes for the PTR (§10.1). Not for the service-type record, which
  another box may still be offering.
- **Knows its own voice.** Multicast comes back to the socket that sent it,
  and an announcement arriving after the box changed what it says would
  otherwise read as another device's claim. Records it sent in the last five
  seconds are recognised as its own.
- TTLs are 120 s for records naming the host (A, SRV, NSEC) and 4500 s for the
  rest (§10). Packets go out with an IP TTL of 255 (§11).

## Sharing port 5353

The operating system's own responder (mDNSResponder, Avahi, systemd-resolved,
Windows' DNS Client) holds 5353 too. The box's socket opens with address
reuse, as the media watchers' does, so both can listen. Where the operating
system still refuses, the admin panel says the port would not open and the box
tries again every fifteen seconds; everything else about the box is
unaffected, and crew join by address or QR as before.

Sharing the port decides how the box asks. Multicast to 5353 reaches every
socket on it, but a unicast packet reaches only one: mDNSResponder's on a Mac,
whichever Windows picks, usually the newest on Linux (RFC 6762 §15.1). A
device defending a name the box probes for may answer by unicast if asked to
(§5.4), and that answer would go to the operating system's responder, so the
box would take a name another device holds. So its probes ask for a multicast
answer, which §15.1 asks of a responder that isn't first on the port; on a Mac
or Windows the box never is. A phone that asks the box for a unicast answer
still gets one, since that goes to the phone.

Two refusals have their own words in the admin panel:

- **Another program keeps 5353 to itself** (`EADDRINUSE`). The responders
  that come with an operating system share the port; Avahi does unless
  `disallow-other-stacks=yes` is set in `/etc/avahi/avahi-daemon.conf`, which
  the panel names on Linux.
- **macOS's Local Network permission.** Sending multicast needs it, and
  macOS asks it of the app that started the box, Crewbox.app, whose
  `NSLocalNetworkUsageDescription` says why (Apple's TN3179). A send it
  refuses fails with `EHOSTUNREACH`, which on a Mac the panel explains with
  where to allow it. A box run from Terminal is exempt, so this meets only
  the app.

## What has been checked

- **Against the RFCs:** the behaviours above, each in a unit test on a
  stood-in socket and a fake clock (`server/test/announceResponder.test.ts`),
  each test checked to fail when the behaviour it guards is removed.
- **On a real socket:** probing, announcing, answering a browse and a one-shot
  question, and the goodbye, over loopback multicast
  (`server/test/announceSocket.test.ts`). It skips on a machine that will not
  loop multicast back, and `CREWBOX_TEST_REQUIRE_MULTICAST=1` makes that a
  failure.
- **The signature:** checked with WebCrypto (Node's, which implements the same
  specification as the phones' web views) against the published key and the
  address asked at, and refused for another event, another challenge, another
  address or another box's key (`server/test/identity.test.ts`). The same
  event ID and key come back from a real `deploy/backup.sh` and
  `deploy/restore.sh` (`server/test/backupRestore.test.ts`).
- **The address:** over real sockets, the box signs for the address a request
  arrived at and refuses the asker's own address, loopback named from the
  network, and names over plain HTTP, including its certificate's name on its
  plain loopback mirror; over TLS it signs for its certificate's name and
  refuses another (`server/test/identity.test.ts`).
- **The apps' check:** against a stood-in box with a WebCrypto key of its
  own, in unit tests (`web/src/lib/identity.test.ts`, `web/src/events.test.ts`),
  and in a browser against real boxes (`e2e/boxes.spec.ts`): a copy of an
  event's database without its key, at a typed address or at the phone's own,
  is refused and sent nothing, and a copy with its key is followed at either.
  Each rule was removed in turn to see a test fail.
- **Following a box found:** which boxes are asked, how often, and when an
  event follows, in unit tests (`web/src/lib/follow.test.tsx`); the app going
  on in place and the documents waiting for the new box's welcome
  (`web/src/events.test.ts`, `web/src/lib/docs/sync.test.ts`); and in a
  browser against real boxes with the phone's search stood in
  (`e2e/boxes.spec.ts`): a copy without the key, announced at a new address,
  is asked, refused and sent nothing, and a copy with it is followed, with
  a message still half typed in the composer.
- **The apps' page:** what is listed and what is left out, the check when a
  box is picked, the iPhone's first tap and stopping when out of sight, in
  unit tests (`web/src/lib/discovery.test.ts`,
  `web/src/components/NearbyBoxes.test.tsx`), and in a browser against a real
  box with the phone's search stood in (`e2e/discovery.spec.ts`).
- **The apps' search:** the iPhone's compiles in CI and the Android APK is
  built there. Tests check the pieces a build would not miss:
  `NSBonjourServices` names the type the plugin browses for, the storyboard
  loads the view controller that registers the plugin, and every Android
  plugin is registered before the bridge starts
  (`server/test/iosInfoPlist.test.mjs`,
  `server/test/androidPlugins.test.mjs`).
- **The join QR:** what the box prints and what the apps read of it
  (`server/test/joinCode.test.ts`, `web/src/lib/joinCode.test.ts`), with the
  `/connect` QR drawn from the link printed under it, on and off the LAN, by
  a name, and at a forward's address, where it names no event; the printed
  poster's, against a real box at its address, by a name and through a
  forward (`server/test/poster.test.mjs`); the
  check and the join in unit tests (`web/src/lib/identity.test.ts`,
  `web/src/events.test.ts`, `web/src/components/JoinScan.test.tsx`); and in a
  browser against a real box (`e2e/scan.spec.ts`), where every join from its
  poster is proven first, and a poster with another box's key sends it
  nothing. Each rule was removed in turn to see a test fail.
- **Not yet:** an iPhone or an Android phone listing a real box, checking
  one's signature, or scanning its poster. Neither app has been run on
  hardware, and this line changes when it has.
