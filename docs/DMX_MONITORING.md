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

**Crewbox never transmits DMX.** Not ArtDmx, not sACN, not ArtPoll, not a
single byte of application-layer traffic onto the lighting network. It opens
sockets and it reads.

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
two sources are fighting, and what levels are on which addresses.

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

`ArtPollReply` is **listened for, never solicited**. Nodes emit it unsolicited
on power-up and periodically, and it carries the node's short and long name —
free source identification without us ever sending an ArtPoll.

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
