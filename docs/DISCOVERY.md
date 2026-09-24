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

| Key       | Value                                                                                                                               |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `txtvers` | `1`, the version of this table.                                                                                                     |
| `id`      | The event's ID (`PublicConfig.eventId`): its database's, minted once. Tells one event's box from another's at the same address.     |
| `name`    | The event's name in full, up to 250 bytes, where the instance label may have been cut or numbered. Empty before the event is named. |
| `ver`     | The box's version, as `/api/health` gives it.                                                                                       |
| `proto`   | The wire protocol's generation (`PROTOCOL_VERSION`).                                                                                |
| `setup`   | `1` once the box has been set up, `0` for a new box nobody has.                                                                     |
| `tls`     | Present when the crew port speaks HTTPS. Its value, when there is one, is the name on the certificate, which is what to connect by. |

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
  with SHA-256 over the UTF-8 bytes of these three lines, with no line break
  after the last:

  ```
  crewbox-identity-v1
  <eventId>
  <challenge>
  ```

  in IEEE P1363 form (r, then s, 64 bytes), base64url, which is what
  WebCrypto's `verify` takes.

- **Check it against the key you kept, never against the one in the answer.**
  Anything can send a key and a signature that agree with each other. A box
  whose answer verifies against the key kept for that event holds that event's
  database, and the app may follow the event to its address. One whose answer
  doesn't, or that has no key, is another box however it announces itself: say
  so and ask, as the app does for a box that has started afresh.
- All of it is public and needs no sign-in, so an app checks a box before it
  sends it a token or anything of the event's.
- An app holding an event from before its box had a key takes the key from
  that box the next time it connects at the address it already has, never
  from a box found somewhere else.

What it does not do: on plain HTTP, something that sits in the middle of the
connection can hand the challenge to the real box and its answer back. The
signature proves that a box holding the key answered, not that nothing stands
between; HTTPS (the `tls` key above) closes that. What it does stop is an app
following its event to the wrong box: another event's, a stale address now
used by something else, or anything announcing an ID it copied.

A box that predates this has no `eventKey` and answers `/api/identity` with a
404; an app treats it as any box it cannot check.

## How the apps look

The iPhone and Android apps browse for `_crewbox._tcp` while a screen that
lists boxes is open: the join screen and **Your boxes**. A web page has no way
to browse, so in a browser those screens are as they were. The page
(`web/src/lib/discovery.ts`) asks the app's `CrewboxDiscovery` plugin to look
(`native/ios/App/App/DiscoveryPlugin.swift`, and `DiscoveryPlugin.java` in the
Android app), and the plugin passes on each service's name, IPv4 addresses and
port, and the TXT keys above. Nothing else.

**Only while somebody is looking.** The search stops when the screen closes
and when the app goes to the background, and starts again when the app is back
in front with the screen open. Nothing looks on a phone in a pocket.

**On an iPhone**, the first search is what brings up iOS's Local Network
alert, so the app doesn't start one until the crew member taps **Find boxes**,
under a line saying what the alert will ask. After that it looks by itself.
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
  the phone's work one tap from going somewhere else.

**Picking one asks the box.** Before using an address it found, the app asks
for `/api/config` there, and takes the event's ID and name from the box's
answer, not the announcement's. A box that doesn't answer, one too old to say
which event it is, and one saying it runs an event this phone holds at another
address are each refused, in a line saying which, and nothing changes. On the
join screen a picked box fills in the server field and moves on to the name;
in **Your boxes** it opens that event, as typing its address would.

**Not yet:** following an event this phone holds to a new address, by checking
the box's signature against the key kept for it
([above](#how-a-box-proves-which-event-it-is)). Until the apps do, a held event
moves only when somebody types its new address.

## How it behaves on the network

What RFC 6762 asks of a responder, and where the code does it
(`server/src/announce/responder.ts`):

- **Claims its names first.** Three probes 250 ms apart (the first after a
  random 0 to 250 ms), questions of type ANY with the unicast-response bit,
  and the records it would claim in the authority section (§8.1). Then two
  announcements a second apart (§8.3).
- **Never takes a name another device has.** A reply showing either name in
  use, while probing or afterwards, moves it to the next number: `Event (2)`,
  `crewbox-3f9a1c-2` (§8.1, §9). Two devices probing for one name at once
  compare their records, and the one whose data sorts first waits a second
  and probes again (§8.2). Fifteen conflicts in ten seconds slow it to one
  probe every five.
- **Defends its names**, answering another device's probe for them at once.
- **Answers phones.** Shared records (the PTR) after 20 to 120 ms so answers
  from several boxes spread out, unique ones at once, and 400 to 500 ms when
  the question says more known answers follow (§6, §7.2). What a phone will
  ask next rides along in the additional section: a PTR brings SRV, TXT, A
  and the NSEC saying there is no AAAA (RFC 6763 §12).
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

The operating system's own responder (mDNSResponder, Avahi, Windows' DNS
Client) holds 5353 too. The box's socket opens with address reuse, as the
media watchers' does, so both can listen. Where the operating system still
refuses, the admin panel says the port would not open and the box tries again
every fifteen seconds; everything else about the box is unaffected, and crew
join by address or QR as before.

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
  specification as the phones' web views) against the published key, and
  refused for another event, another challenge or another box's key
  (`server/test/identity.test.ts`). The same event ID and key come back from a
  real `deploy/backup.sh` and `deploy/restore.sh`
  (`server/test/backupRestore.test.ts`).
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
- **Not yet:** an iPhone or an Android phone listing a real box, or checking
  one's signature. Neither search has been run on hardware, and this line
  changes when it has.
