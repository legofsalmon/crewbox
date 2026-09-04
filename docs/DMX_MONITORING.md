# Listening to the lighting network

Crewbox knows what the rig is _supposed_ to be: the plot has every fixture's
universe, DMX address and channel footprint. It has no idea what the rig is
actually doing. This is the spec for closing that gap by listening to Art-Net
and sACN on the lighting network.

**Status.** All of it is built — sniffer, parsers, state machine, listener,
config, admin panel, fixture verification and live levels.

**And nothing here has met a real rig yet.** Every packet the tests use was
synthesised from the specs below by the same hand that wrote the parsers, so
the suite proves internal consistency and not correctness on the wire. That is
what `scripts/dmx-sniff.mjs --dump` is for. Until a capture lands, treat the
byte-level detail as careful but unconfirmed.

## The one rule

**Crewbox never transmits DMX.** Not ArtDmx, not sACN, not a single byte of
application-layer traffic onto the lighting network. It opens sockets and it
reads. The DMX sockets cannot transmit at all: `send` is taken off them
before they are used (see `receiveOnly`), so a change that tried would fail
in development rather than on a show network.

There is exactly one deliberate exception, and it is not this module: the
**network audit** sends a single ArtPoll — the same discovery packet every
console on the network broadcasts every few seconds — from a socket of its
own, only when an admin pushes the button, and it records the bytes it sent
so venue IT can check them against a capture. See `docs/NETWORK_AUDIT.md`.
Nothing in the monitoring path sends anything, ever.

That is not a nicety. A festival lighting network carries the show, and an
app that can transmit on it is a way to black out a stage from a phone in
somebody's pocket. Every crew phone on the box would inherit whatever the box
can do. Read-only is what makes this safe to put on a show network at all,
and it is the constraint the whole design hangs off.

The one exception is unavoidable and worth naming: **receiving multicast
requires IGMP membership reports**, which are link/network-layer packets the
kernel emits when you join a group. There is no way to receive sACN without
them. They are not DMX and they do not reach any lighting device's data path.
Everything above that layer is silent.

## Scope

**In:** which universes are live, who is sending them, at what rate, whether
two sources are fighting, whether the levels on the wire have actually reached
the stage, what each source says it is transmitting on, and what levels are on
which addresses.

**Out:** transmitting anything. Being a visualiser — beams, focus, gobos,
fixture geometry, rendering. Being a console, a backup console, or a
triggering system. Recording shows.

## What it is for

Not "look at the pretty lights". The value is that it answers questions the
paperwork already poses and cannot answer on its own.

**"Channel 101 is dark — is it the fixture or the desk?"** The plot knows 101
is a Sharpy at 1/17 taking 16 channels. If universe 1 is arriving and nothing
in 17–32 has been above zero since we started watching, the desk isn't
sending it. If data is arriving, the problem is downstream: lamp, power, or
the fixture's own address.

**Patch verification.** Anything in the plot that never sees data is
mis-addressed in the rig or unpatched at the desk. That is a get-in problem
found at the get-in rather than at the line check.

**Universe health.** Which universes are on the wire, from which node, at what
refresh rate. And **two sources on one universe at the same priority** — a
classic festival fault (a spare console left patched, a media server on the
wrong output) that stays invisible until something flickers at the worst
moment.

**Live levels on the plot.** Fixtures in the plan, front elevation and 3D
views dim by what is being sent to them.

Not intensity, and never called it: without a GDTF profile nothing here knows
which of a moving head's sixteen channels is the dimmer, so a head panning
hard in the dark would read as full. What it honestly shows is the highest
value anywhere in a fixture's footprint — enough to watch a rig answer a cue,
not enough to mistake for a visualiser. It is applied as opacity over the
fixture's existing status colour rather than replacing it, and never reaches
zero: a fixture at 0 is still a fixture rigged in that spot.

## Honesty about what a level means

A fixture sitting at zero is indistinguishable from a fixture nobody is
sending to. Crewbox must never say "broken". The verdict it can honestly
reach is:

| Verdict   | Means                                                                                                                |
| --------- | -------------------------------------------------------------------------------------------------------------------- |
| `no-data` | Its universe has not been seen at all.                                                                               |
| `silent`  | Universe is live; every address in this fixture's footprint has been zero for the whole time we have been listening. |
| `live`    | At least one of its addresses has been above zero since we started.                                                  |

Every one of those carries "since HH:MM" in the UI, because that is the only
window we can speak for. A box that started listening two minutes ago knows
nothing about the blackout ten minutes before.

### And whether the wire is the stage

All three of those are statements about what the **desk is sending**. Universe
synchronisation breaks the assumption that sending and outputting are the same
thing: a source sends its data, then sends a separate synchronization packet,
and receivers hold everything until it arrives so several universes land
together. Media servers, LED panels and fast dimmers use it.

So a second, orthogonal verdict, per universe:

| `sync`      | Means                                                                                      |
| ----------- | ------------------------------------------------------------------------------------------ |
| `none`      | Data stands on its own. Wire is stage. Nearly every rig, nearly all the time.              |
| `held`      | Sync-addressed and the sync stream is arriving. These levels are queued, not output.       |
| `frozen`    | Sync-addressed, sync universe joined, nothing arriving on it, force-sync clear. **Stuck.** |
| `lost`      | The same, but force-sync set, so receivers were free to carry on unsynchronised.           |
| `unwatched` | Sync-addressed to a universe this box hasn't joined, so which of the above is unknowable.  |

`frozen` is the one worth the work. E1.31 §11.1.2 stops a receiver
synchronising when no synchronization packet arrives within the data-loss
timeout, and §6.2.6 says what happens then when Force_Synchronization is clear
— the default — components "shall not update with any new packets until
synchronization resumes". The desk carries on sending. Crewbox carries on
showing levels moving. **The stage has not changed since the stream died**, and
from either end on its own it looks like nothing at all.

Two things this deliberately does not do:

- **`everLit` is still recorded for held data.** "Is the desk sending to these
  addresses" is a question about the desk and the patch, and the answer is yes
  whether or not a receiver has been told to take it. Gating the patch check on
  sync would report a correctly patched, correctly synchronised rig as
  unpatched.
- **A non-zero sync address is never on its own enough to say `held`.** §6.2.4.1
  is explicit that a receiver "must not attempt to synchronize any data on a
  Synchronization Address until it has received its first E1.31 Synchronization
  Packet containing that address" — a source advertising an address states an
  intent, not a fact about any receiver. Hence parsing the synchronization
  packet, and hence `unwatched` existing at all: §6.3.3.1 sends those packets
  only to their own universe's multicast group, so a box listening to 1–8 will
  never hear universe 7962's, and calling that a fault would be crying wolf at
  a rig that is fine.

## Protocols

Two parsers, both pure functions from `Buffer` to a typed packet or `null`.
No sockets in the parsers, so they test against captured bytes the way
`mvr.ts` tests against a captured file.

### Art-Net (Art-Net 4)

UDP **6454**, normally broadcast.

```
ID[8]      "Art-Net\0"
OpCode[2]  little-endian; 0x5000 ArtDmx, 0x2100 ArtPollReply
```

`ArtDmx` carries `ProtVer` (≥ 14), `Sequence`, `Physical`, `SubUni`, `Net`,
`Length` (2–512, even) and the data. The 15-bit port address is
`((Net & 0x7F) << 8) | SubUni`, so universes run 0–32767 — note Art-Net counts
from 0 where sACN counts from 1, and the UI must not silently conflate them.

`Sequence` is 0 when disabled, otherwise 1–255 wrapping; used to spot
out-of-order delivery, not to reorder.

`ArtPollReply` is **listened for, never solicited by this module**. Nodes emit
it unsolicited on power-up and periodically, and it carries the node's short
and long name — free source identification with nothing sent from here. (The
network audit's one admin-triggered ArtPoll will also wake replies; that is
its purpose, and it is a different socket in a different module.)

`ArtSync` (opcode **0x5200**) has no payload and no port address. From the
moment a node sees one it buffers ArtDmx rather than outputting it, and it
"shall time out to non-synchronous operation if an ArtSync is not received for
4 seconds or more". Because there is no port address, this is one fact about
the whole network rather than one per universe — which is why `DmxState` keeps
a single ArtSync timer where sACN gets a map keyed by sync universe.

**Data merging**, from the specification's own section, and it changes what a
conflict means on Art-Net:

- A node merges **at most two sources**. "If there are more than two sources,
  the node shall ignore the extra sources" — so a third console is not a
  louder argument, it is a console doing nothing at all, and the admin panel
  says so specifically.
- The merge is **LTP or HTP**, selected per node via ArtAddress. Crewbox
  cannot know which, and does not merge; it shows one source and reports the
  conflict.
- A conflict is detected by **differing sender IP**, or by a differing
  Physical port from the same IP.
- A source that fails is held in the merge buffer for **10 seconds**. If both
  fail, the node's output holds the last merged result. This is where
  `DATA_LOSS_MS.artnet` comes from — see below; it used to rest on a comment in
  OLA's source, and now rests on the specification.

**Known limitation of staying passive:** a controller configured to unicast
ArtDmx only to nodes that have answered its ArtPoll will not be seen, because
we never announce ourselves. Most consoles broadcast by default. This is a
deliberate trade — being invisible on the show network is worth more than
seeing every possible configuration — and it must be stated plainly in the
admin panel rather than looking like a fault.

### sACN (ANSI E1.31)

UDP **5568**, multicast to `239.255.<universe_hi>.<universe_lo>`. Universes
1–63999.

Three nested layers, all of which must be checked before the data is trusted:

- **Root (ACN):** preamble `0x0010`, postamble `0x0000`, identifier
  `"ASC-E1.17\0\0\0"`, vector `0x00000004`, then the 16-byte source **CID**.
- **Framing:** vector `0x00000002`, `Source Name` (64 bytes UTF-8), `Priority`
  (0–200, default 100), `Synchronization Address`, `Sequence Number`,
  `Options`, `Universe`.
- **DMP:** vector `0x02`, address type `0xa1`, first address `0x0000`,
  increment `0x0001`, property value count, then the START code (`0x00` for
  DMX) followed by up to 512 slots.

Behaviours that are not optional:

- **`preview_data`** (options **bit 7**, mask `0x80`) is discarded. It is a
  console previewing a cue, not the stage.
- **`stream_terminated`** (**bit 6**, mask `0x40`) means that source has gone;
  drop it immediately rather than waiting for the timeout. A terminating
  source sends it three times, so handling must be idempotent.
- **`force_synchronization`** is bit 5, mask `0x20`. Not used here; noted so
  nobody re-derives the bit numbering from scratch.
- **Sequence numbers**: discard a packet whose sequence difference from the
  last one from that CID is between −20 and 0. This is the spec's rule and it
  is what stops a reordered UDP packet from flickering a level backwards.
- **Source timeout**: a source unheard for 2.5 s is gone (E1.31 network data
  loss timeout).
- **Priority**: highest wins. Equal priority from two CIDs on one universe is
  the source conflict worth reporting — E1.31 leaves receiver behaviour
  implementation-defined, which is exactly why nobody notices it happening.
  Among tied sources crewbox shows the **lowest CID**, always: §6.2.3.3 warns
  against schemes that "generate different results from the same source
  combination on different occasions" and names order of arrival as the
  example not to follow, which is what this used to do. It is not a merge and
  is not meant to be one — the useful output is `conflict`, which says nobody
  can know what the rig is doing. §6.2.3.4 and §6.2.3.5 require the algorithm
  and the sources-exceeded behaviour to be declared, which is what this
  paragraph is.
- **Synchronization Address** (framing octets 109–110) and
  **Force_Synchronization** (options bit 5) are both read; the separate
  **E1.31 Synchronization Packet** (root vector `0x08`, framing vector `0x01`,
  no DMP layer) is parsed as well. See "And whether the wire is the stage"
  above for why all three are needed rather than just the first.

A source is identified by CID, not by IP. Two consoles behind one NAT and one
console that changed IP are both handled correctly by that, and neither is by
the alternative. Art-Net has no CID, so its sources are keyed by sender IP and
named from any `ArtPollReply` seen from that IP.

### The universe numbering trap

Three numbering schemes meet here and two of them disagree:

|                      | Range   | Base  |
| -------------------- | ------- | ----- |
| Art-Net Port-Address | 0–32767 | **0** |
| sACN universe        | 1–63999 | 1     |
| A crewbox plot       | ≥ 1     | 1     |

Getting this wrong shifts every fixture by 512 channels — precisely the error
`addressing.ts` already describes as "invisible in a spreadsheet and very
visible on stage". So it is never inferred silently:

- `CREWBOX_DMX_ARTNET_BASE` (default 1) says which plot universe Art-Net 0 is.
- sACN maps one to one.
- Everything that shows a universe shows **both** numbers — "Art-Net 0 → plot
  universe 1" — so a wrong mapping is visible in the admin panel within
  seconds rather than being discovered at the line check.

## Shape

```
server/src/dmx/artnet.ts    Buffer → ArtDmx | ArtPollReply | null
server/src/dmx/sacn.ts      Buffer → E131Data | null
server/src/dmx/state.ts     universes, sources, levels, timeouts, conflicts
server/src/dmx/listener.ts  sockets, membership, lifecycle
```

`node:dgram` is core, so this adds no dependency and survives the SEA build
for the same reason `node:sqlite` does.

`state.ts` holds, per universe, the current 512-slot frame and a per-source
record. It is a plain object updated by the parsers' output — no I/O — so the
interesting logic (winning source, conflict detection, timeouts, the
`no-data` / `silent` / `live` verdicts) is testable without a socket.

## Never push frames at phones

Sixteen universes of sACN at full rate is roughly 700 packets/sec and
450 KB/s. That is nothing on the box's wired NIC and fatal over festival
Wi-Fi. The box aggregates; clients receive conclusions.

**Health** — the default, and tiny. A few times a second at most, and only
when something changed: per universe, the winning source's name and priority,
packet rate, last-seen, and whether there is a conflict. A handful of bytes
per universe.

**Levels** — opt-in, per view. A client looking at a plot names the universes
it cares about; the box replies with a snapshot of those universes' non-zero
addresses, then sends only what moved, at 4 Hz. At most 96 changes per
universe per tick, with the remainder carried into the next one, so a rig
doing a strobe chase cannot saturate a phone and nothing is lost — it just
arrives a quarter-second late, which for a level readout is indistinguishable
from on time. Closing the view unsubscribes.

**Verification** needs no levels at all, which is why it is the default. The
box sends `everLit` as a 64-byte bitmap per universe — one bit per address —
and the client turns that into a per-fixture verdict, because only the client
knows where its fixtures are addressed. The bitmap only ever gains bits, so
it is sent when it grows and never diffed.

Nothing subscribes to levels by default. Most of the value — is it arriving,
who is sending it, does the patch match — needs no levels at all.

## Configuration

Off unless asked for. A box that has not been told to listen opens no sockets.

| Variable                  | Meaning                                                     |
| ------------------------- | ----------------------------------------------------------- |
| `CREWBOX_DMX`             | `off` (default), `artnet`, `sacn`, or `both`                |
| `CREWBOX_DMX_IFACE`       | IP of the interface to join multicast groups **on**         |
| `CREWBOX_DMX_UNIVERSES`   | sACN universes to join, e.g. `1-16,101`                     |
| `CREWBOX_DMX_ARTNET_BASE` | Plot universe that Art-Net universe 0 maps to (default `1`) |

`CREWBOX_DMX_IFACE` is the **membership** interface, not a bind address. The
socket always binds `0.0.0.0`; binding it to a specific unicast address stops
multicast arriving at all on Linux. On a box with more than one interface the
membership interface is effectively required, or the kernel picks by routing
table and may join on the wrong NIC and receive nothing, silently.

Universe **64214** is joined on top of whatever is listed, always, so sources
can advertise what they are transmitting on without the box having to guess —
see universe discovery below. It is not counted in the panel's "joined N
universes", which means the ones you asked for.

sACN needs an explicit universe list because there are 63999 groups. It also
needs a short one: **Linux allows 20 memberships per socket by default**
(`net.ipv4.igmp_max_memberships`), so the list is capped at 16 with a clear
error rather than a socket that half-works. More than that wants a second
socket, which is a later problem.

## Admin: "Lighting network"

A third panel beside **This box** and **This network**, following the same
rule those two follow — report what is true right now, with the fix attached
to anything that isn't. Reusing `ReadinessCheck { id, label, state, detail,
fix }` gives it the same shape and the same honesty for free.

Checks worth having: whether listening is enabled at all; which interface;
which universes are arriving and from whom; sources that have timed out;
priority conflicts; and, when Art-Net is on but silent, the plain statement
that a unicast-only controller will not be seen because crewbox never
announces itself.

### Health beyond presence

Three further checks are derived entirely from traffic already being
received — nothing new is joined and nothing is ever sent:

- **Frame loss per source** (`dmx-loss`). Both protocols carry sequence
  numbers; gaps are loss, measured over a 10-second window. A straggler that
  arrives late is refunded (reordered, not lost), a forward jump past 40 is
  read as the source restarting its sequence, and a window nothing arrived
  in reports `null` — both protocols suppress unchanged frames, so absence
  is silence by design, and 0% would be invented evidence. Art-Net with
  sequencing disabled (sequence 0) is also `null` for the same reason. The
  panel reports loss at 1% and above.
- **Correlated outage** (`dmx-outage-*`). Two or more universes of one
  protocol losing their last source within a 4-second window, with none of
  that protocol surviving, is reported as one event about the path rather
  than N events about desks. The sharpest form: sACN (multicast) collapsing
  while Art-Net (broadcast) still arrives points at IGMP snooping or the
  switch, and the check says so. Cleared the moment any packet of that
  protocol arrives again.
- **Node inventory** (`dmx-nodes`). Every ArtPollReply overheard — consoles
  poll their nodes constantly, and replies are broadcast — is kept for the
  session with first/last-seen times. A node that stopped replying stays
  listed with how long ago it was last heard, because the vanishing is the
  news. The monitoring path never sends ArtPoll, so the inventory is
  overheard — unless an admin has run a network audit, whose single ArtPoll
  will have woken any node that only answers when asked.

## Deployment note for the runbook

Art-Net conventionally lives on `2.x.x.x` or `10.x.x.x`, usually on its own
switch or VLAN, and crew Wi-Fi does not. Reaching it means a second NIC or a
trunk port — a rigging decision made per venue, not something software can
arrange.

**A box on both networks bridges them.** One side is show-critical, the other
is full of phones belonging to whoever scanned the poster. That should be a
decision someone made on purpose, with the box's firewall configured for it,
and the runbook must say so rather than leaving it to be discovered.

## Verification

- Parser tests over captured and synthesised buffers: valid packets of both
  protocols, truncated, wrong vector, wrong identifier, oversized length,
  `preview_data`, `stream_terminated`, sequence regression, priority ties.
- State tests: source timeout, source replacement, conflict detection,
  `no-data` / `silent` / `live` transitions.
- A loopback integration test that sends synthetic packets to `127.0.0.1` and
  asserts the resulting state. Sending inside a test is fine; it is the
  shipped product that must not send.
- **Read-only is enforced, not just tested.** Every socket has `send` replaced
  with a thrower the instant it is created, so a future change that tries to
  answer an ArtPoll fails in development rather than putting traffic on a show
  network. A test asserts the throw, and another asserts that `mode: off`
  opens no socket at all.

## The problem with testing this

A parser written from a reading of the spec, tested against packets built from
the same reading of the spec, proves only that the author was consistent with
himself. Every test passes and the parser can still be wrong about the wire.

That is not hypothetical. Writing the first draft of this document, the
`preview_data` and `stream_terminated` bits were recorded as 6 and 5. They are
**7 and 6**. A parser built on that would have discarded every live packet as
a preview and reported a silent rig — and a full green test suite would have
agreed with it, because the tests would have set bit 6 too.

Checking against the published protocols caught that one. The rest of the
byte-level detail deserves the same treatment, and the only source that cannot
be circular is bytes off a real rig.

Hence step 0.

## Order of work

**0 — A sniffer that ships nothing.** ✅ `scripts/dmx-sniff.mjs`: one file, no
dependencies, runnable on any machine plugged into the lighting network. It
prints what it sees — protocol, universe, source, priority, packet rate, the
first few slots — and with `--dump <dir>` writes the raw packets to disk.

Nothing about it touches the box. Its whole job is to turn "matches my reading
of the spec" into "matches your rig", and to produce real captured bytes to
use as test fixtures. Half a day, and it de-risks everything after it.

It is also independently useful: point it at a network and it answers "is
Art-Net even reaching this switch port" before crewbox is involved at all.

**1 — Parsers and state, no I/O.** ✅ Pure functions and a plain state object.
Tests over the captured bytes from step 0 where they exist, and over
synthesised ones — clearly labelled as such — where they don't.

```
server/src/dmx/artnet.ts   parseArtNet(buf, fromIp) → DmxFrame | ArtPollReply | null
server/src/dmx/sacn.ts     parseSacn(buf)           → DmxFrame | null
server/src/dmx/state.ts    DmxState: apply, sweep, health, levels, verdict
```

Both parsers produce one protocol-independent `DmxFrame`, so everything
downstream is written once:

```ts
interface DmxFrame {
  protocol: 'artnet' | 'sacn'
  wireUniverse: number // exactly as it appeared on the wire
  sourceId: string // sACN CID hex, or Art-Net sender IP
  sourceName: string
  priority: number // sACN 0–200; Art-Net has none, so 100
  sequence: number
  slots: Uint8Array // index 0 = slot 1
  preview: boolean
  terminated: boolean
}
```

`DmxState` keeps, per universe, the winning source, the rival sources, the
current 512 slots, and an `everLit` bitmap — has this address been above zero
at any point since listening began. That bitmap is the whole `silent` verdict:
512 bytes per universe, and it is the difference between "the desk isn't
sending this" and "nobody has brought it up yet".

**2 — Listener and the admin panel.** ✅ Sockets, membership, config, lifecycle,
and a "Lighting network" panel built from `ReadinessCheck`. This is the first
step that is worth shipping on its own: it answers "is anything even reaching
us", which is the question that decides whether steps 3 and 4 are worth doing.

**3 — Fixture verification.** ✅ `verdict(universe, address, footprint)` against
the plot, surfaced next to the existing `todo / rigged / ok / fault` workflow.
This is where the feature earns its place.

**4 — Live levels.** ✅ The subscribe protocol, deltas, and colouring the plan,
front and 3D views. Last, opt-in, and the least important.

Each step leaves something coherent behind. Stopping after 2 is a reasonable
outcome, not an abandoned half-feature.

## What could go wrong

|     | Risk                                                                      | What we do about it                                                                                             |
| --- | ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| R1  | Byte layouts wrong; tests agree because they share the mistake            | Step 0 before any parser lands                                                                                  |
| R2  | Art-Net 0-based read as plot 1-based, shifting every fixture 512 channels | Explicit `ARTNET_BASE`, both numbers shown everywhere                                                           |
| R3  | More than 20 sACN universes silently fails to join                        | Cap at 16, error naming `igmp_max_memberships`                                                                  |
| R4  | Multicast bind differs across Linux/macOS/Windows                         | Bind `0.0.0.0` + explicit membership interface — verified working; still needs a run on macOS and Windows boxes |
| R5  | Windows Firewall drops inbound UDP                                        | Admin panel distinguishes "not listening" from "listening, nothing arriving"                                    |
| R6  | IGMP-snooping switch with no querier eats the multicast                   | Same distinction; documented as a network fault, not a crewbox one                                              |
| R7  | Art-Net controller unicasts only to nodes that answered ArtPoll           | Stated in the panel; accepted cost of never transmitting                                                        |
| R8  | Box bridges the show network to crew Wi-Fi                                | Off by default; runbook says it plainly                                                                         |
| R9  | CI can't do loopback multicast                                            | Integration test skips cleanly; parser and state tests need no sockets                                          |

Loopback multicast and the bind/membership pattern have been confirmed
working on Linux with Node 22 — `bind(5568)` on `0.0.0.0`, then
`addMembership('239.255.0.1', '127.0.0.1')`, receives. So the integration test
is real rather than mocked, where the platform allows it.

## Open decisions

- **Which universes does a plot actually use?** The server holds the Yjs docs
  but shouldn't have to understand them. Simplest is for the client to send
  the universes its plot references when it opens the lighting view, and for
  the server to keep nothing per-plot. That also means the box only joins
  groups somebody is looking at, which sidesteps R3 in the common case.
- ~~**Protocol version.**~~ Settled: `handleServer` switches on `msg.type`
  with no `default` and no exhaustiveness check, so a client that meets an
  unknown message type ignores it. New types are additive in both directions
  and `PROTOCOL_VERSION` does not need a bump.

## What the fixture profiles added

Everything above is what the wire says. What it _means_ comes from the
fixture's own GDTF profile, which an MVR already carries for every type in
the rig — crewbox unzipped those files for the mode footprint and threw the
rest away.

`web/src/modules/lighting/model/gdtf.ts` reads the rest, against the
published GDTF 1.2 specification rather than from memory (same reasoning as
step 0 above: a parser and its tests written from one person's reading of a
spec prove only that the two agree). `gdtfLive.ts` joins it to the levels.

| Before                                            | With a profile                                  |
| ------------------------------------------------- | ----------------------------------------------- |
| "the highest value in these 16 channels"          | "the dimmer is at 60%"                          |
| a fixture is _live_ if any of its channels moved  | _live_ if its **dimmer** has been up            |
| no colour                                         | emitters, CMY flags and colour-wheel slots      |
| no orientation                                    | pan and tilt in the profile's own degrees       |
| a level bar                                       | every channel, named, with its decoded value    |
| 400 mm assumed per fixture for the truss estimate | the fixture's own dimensions, and it says which |
| 0 W and 0 kg for an imported rig                  | the manufacturer's figures                      |

Two things that look like details and are not:

- **`DMXValue` is `Uint/n` and converts between byte counts by mirroring,**
  not shifting. `255/1` in a 16-bit channel is 65535, not 65280. Getting it
  backwards puts every range boundary of every 16-bit channel slightly out,
  which never looks like an error.
- **A multi-cell fixture defines one cell and references its geometry N
  times.** Reading the channel list naively reports a 12-cell bar as
  occupying three channels — and the address collision check would then
  happily patch something on top of cells 2 to 12.

Where a profile can't answer, the answer degrades and says so: no dimmer
channel falls back to peak-in-footprint and the live bar reports how many
fixtures were judged which way; a fixture patched across several DMX breaks
has channels this can't place, and the readout shows them with no address
rather than reading the wrong slots.

## Cross-checking against other people's work

Everything above was written from the published specifications. That is
necessary and not sufficient — the first draft of this design had sACN's
option bits one place too low, and a suite built on it would have been green
while calling every live rig silent. Reading a spec is a thing you can do
wrong quietly.

So the constants were checked a second time against implementations written
by people who have never seen this codebase. Where two unrelated projects
agree with each other _and_ with the standard, a misreading has to be shared
three ways to survive.

| Source                                               | What it settled                                                                                                                                         |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [ANSI E1.31-2018][e131] (ESTA TSP, free)             | The standard itself.                                                                                                                                    |
| [libe131][libe131] (C)                               | Every sACN offset, by construction — its packed struct _is_ the layout. Also the option bit numbers, the validation set, and the sequence discard rule. |
| [Hundemeier/sacn][pysacn] (Python)                   | The same offsets, reached independently: `raw_data[112] & 0b10000000` for preview, `& 0b01000000` for terminated, `& 0b00100000` for force-sync.        |
| [Art-Net 4 specification][artnet] (Artistic Licence) | The standard itself.                                                                                                                                    |
| [OLA][ola] `plugins/artnet/ArtNetPackets.h`          | ArtDmx field order and the opcodes; `id[8]` + opcode puts ArtPollReply's short name at 26 and long name at 44.                                          |
| [OLA][ola] `plugins/artnet/ArtNetNode.h`             | `MERGE_TIMEOUT = 10` seconds, "as per the spec".                                                                                                        |
| [python-gdtf][pygdtf] test files                     | A real GDTF profile written by another tool — see `web/src/modules/lighting/model/__fixtures__/`.                                                       |

### What that turned up

Two things, both in code that was already shipping:

**The Art-Net data-loss timeout was sACN's.** `state.ts` timed out every
source at 2.5 seconds, which is E1.31's figure. Art-Net re-transmits an
unchanged frame only about every 4 seconds and its merge timeout is 10, so a
console parked on a look — most of a show — was dropped between its own
keep-alives and the panel flapped between "receiving" and "nothing arriving"
on a completely healthy rig. A monitor that cries wolf is worse than no
monitor. The timeout is now per protocol.

**The DMP layer's addressing was not checked.** E1.31 fixes a DMX packet to
one shape: single-byte properties, first address 0, increment 1. Both
reference implementations reject all three mismatches; crewbox checked none,
so other DMP traffic on port 5568 could have been read as levels at offsets
that only make sense for this one layout. Now checked, with a test.

A third, smaller: an sACN priority above the legal 200 is now capped rather
than believed, so a malformed source can't take a universe off a console
correctly asking for 200.

## Then against the standards themselves

Colm supplied **ANSI E1.31-2025** and **ANSI E1.11-2024** — newer revisions
than the implementations above were built against. The documents are ESTA's
copyright and are not redistributable, so they are not in this repo; what
follows is clause references and the factual constants, which is what the
code needed.

Everything the implementations had agreed on was confirmed:

| Checked                                                                     | Clause         | Result                                                     |
| --------------------------------------------------------------------------- | -------------- | ---------------------------------------------------------- |
| Options bits — Preview_Data 7, Stream_Terminated 6, Force_Synchronization 5 | §6.2.6         | Confirmed. The bits this design originally had wrong.      |
| Sequence discard — signed 8-bit `B − A` in (−20, 0]                         | §6.7.2         | Confirmed exactly, including the window.                   |
| `E131_NETWORK_DATA_LOSS_TIMEOUT` = 2.5 s                                    | §6.7.1, App. A | Confirmed.                                                 |
| Priority is 0–200, highest wins                                             | §6.2.3         | Confirmed; the cap matches the standard's own bound.       |
| Terminated packets' values must be ignored                                  | §6.2.6         | Already correct — `apply()` returns before touching slots. |
| Receivers must not vary their answer for the same source set                | §6.2.3.3       | **Not met.** Order of arrival decided it — now lowest CID. |
| The receiver's algorithm must be declared                                   | §6.2.3.4/5     | Now written down, here and on `pickWinner`.                |

And it corrected one piece of reasoning that was wrong even though the fix it
justified was right:

**Both protocols suppress unchanged data.** The comment on `DATA_LOSS_MS`
used to say sACN sources stream continuously and Art-Net ones don't. They
both stop repeating themselves; E1.31 §6.6.2 has an sACN source send three
identical packets and then a keep-alive every 800–1000 ms. So the real rule
is the same for both — _tolerate two missed keep-alives_ — and the numbers
differ only because the intervals do. Right answer, wrong reason, now fixed
in the comment.

Two questions closed with no code:

- **Per-address priority (start code 0xDD) is not in E1.31.** It is a vendor
  extension. Rejecting every non-zero START code is correct per the standard,
  so there is nothing to implement.
- **Alternate START codes** more generally are E1.11's business, and a
  monitor that only wants levels is right to ignore them.

### Then built from it

**Universe synchronisation, both protocols.** ✅ The standard's §11 turned out
to describe a fault crewbox could not see and could not have guessed at: a rig
frozen on its last look because its synchronization stream died, while the desk
carries on sending and every other check in the panel reads green. Reading
§6.2.4.1, §6.3, §6.2.6 and §11.1.2 together is what makes the five-way verdict
above possible — in particular that a sync _address_ is an intent and only the
sync _packet_ makes it a fact, which a from-memory implementation would have
got wrong in the direction of false alarms.

Art-Net's ArtSync got the same treatment from its own specification: opcode
0x5200, no port address, four-second reversion.

**Deterministic arbitration.** ✅ §6.2.3.3 asked for it directly and crewbox
was not doing it. See the table above.

**Universe discovery.** ✅ E1.31 has a discovery packet that lists the
universes a source is transmitting, sent to universe 64214 every 10 seconds.
§12 says why it exists, and it describes crewbox exactly:

> Universe Discovery is specifically intended to reduce the imposed load on a
> network that would otherwise be created by a monitoring system joining every
> single E1.31 multicast group in order to probe its traffic to report this
> same information.

So the box joins 64214 whenever sACN is on, regardless of what anyone listed —
one membership, ahead of any universe somebody guessed at. 16 universes plus
this is 17, still inside the kernel's 20. It is kept out of the `joined` count
in the admin panel, which means "universes you asked to watch".

What it buys is the check that could not exist before: **a box listening to
1–2 while the desk advertises 1–8 looks, from every other check in the panel,
like a network fault.** It is a typo in one environment variable, and the
panel now names the universes to add.

Two details from the standard that shape the implementation:

- **Pages are unreliable by design.** §6.7.1.1: pages "may be dropped or
  arrive out of order, potentially even mixed in between different runs of
  pages", and how a receiver copes is explicitly out of scope. Waiting for a
  complete set reports nothing at all when one page keeps getting lost;
  reporting the union silently presents half a desk as all of it. So crewbox
  reports the union **and says whether it is complete** — "2 of 3 pages seen".
  Pages are stored and aged individually, so a source that drops a universe
  stops advertising it rather than claiming it forever.
- **Sources may be slow to admit a change.** §12.2 lets a source that has
  stopped transmitting wait until "no later than the second
  `E131_UNIVERSE_DISCOVERY_INTERVAL`" before updating its list, so the staleness
  window is 20 s. Anything shorter would call a conforming desk stale while it
  behaves exactly as specified.

A source that implements none of this is not a fault and is not reported as
one — §12 notes that "some legacy sources may not support it, meaning that a
list of universes cannot ever be guaranteed to be complete".

### Still outstanding

None of this replaces a real console. Three documents agreeing on a byte
offset says nothing about whether a grandMA3 on a festival network behaves
the way they say. `scripts/dmx-sniff.mjs --dump` remains the thing to run
first.

**Art-Net now has a partial pass.** It is not an ESTA standard — the
specification is Artistic Licence's own (v1.4, rev 1.4dp). Colm supplied its
Data Merging and synchronisation sections, which closed the last provenance
gap: the **10-second** merge timeout `DATA_LOSS_MS.artnet` uses is the
specification's own figure and no longer rests on a comment in OLA's source.
The same pass added the two-source merge limit, the LTP/HTP selection, the
IP-and-Physical conflict rule and ArtSync's four-second reversion, all of
which are now in "Art-Net (Art-Net 4)" above.

The rest of the Art-Net layer — the ArtPollReply name offsets in particular —
has still only been read once.
