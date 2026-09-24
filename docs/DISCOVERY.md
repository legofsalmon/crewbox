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
and use it to fill in an address, and it must still confirm, by connecting,
that the box at that address is the one it thinks: `GET /api/config` returns
the same event ID, and a box an app has joined before will prove itself with
its signing key once that lands (the plan's next step). An app must never send
credentials to an address because of what a TXT record said.

When `tls` names a certificate, connect by that name, as crew typing it would;
the address in the A record is for a box without one.

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
- **Not yet:** an iPhone's or an Android phone's browser listing a real box.
  The apps' side of discovery comes next, and this line changes when it has
  been seen on hardware.
