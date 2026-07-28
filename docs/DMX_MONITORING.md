# Listening to the lighting network

Crewbox knows what the rig is _supposed_ to be: the plot has every fixture's
universe, DMX address and channel footprint. It has no idea what the rig is
actually doing. This is the spec for closing that gap by listening to Art-Net
and sACN on the lighting network.

This is a plan, not a description. Nothing here is built yet.

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

**Live levels on the plot.** Once the data is there, colouring fixtures by
their current level in the plan, front elevation and 3D views is nearly free.
This is the least important item on the list and should be built last.

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

- **`preview_data`** (options bit 6) is discarded. It is a console previewing
  a cue, not the stage.
- **`stream_terminated`** (bit 5) means that source has gone; drop it
  immediately rather than waiting for the timeout.
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
the alternative.

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

**Levels** — opt-in, per view. A client that is looking at a plot sends the
universes it cares about; the server replies with a full snapshot of those
universes' non-zero addresses, then sends deltas at 4 Hz: only addresses
whose level, quantised to 0–100, has changed. A capped number of pairs per
tick, with the remainder carried into the next one, so a rig doing a strobe
chase cannot saturate a phone. Closing the view unsubscribes.

Nothing subscribes to levels by default. Most of the value — is it arriving,
who is sending it, does the patch match — needs no levels at all.

## Configuration

Off unless asked for. A box that has not been told to listen opens no sockets.

| Variable                | Meaning                                      |
| ----------------------- | -------------------------------------------- |
| `CREWBOX_DMX`           | `off` (default), `artnet`, `sacn`, or `both` |
| `CREWBOX_DMX_IFACE`     | IP of the interface to bind and join on      |
| `CREWBOX_DMX_UNIVERSES` | sACN universes to join, e.g. `1-16,101`      |

`CREWBOX_DMX_IFACE` is effectively required on a box with more than one
interface: bind to `0.0.0.0` and the kernel may join the multicast group on
the wrong NIC and receive nothing, silently. sACN needs an explicit universe
list because there are 63999 groups and you cannot join them all.

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
- **An explicit test that the listener never calls `send`.** The rule at the
  top of this document is the kind that erodes quietly, and a test is the
  only thing that keeps it true a year from now.

## Order of work

1. **Parsers and state, no I/O.** Pure, fully tested, useful to nothing yet.
2. **Listener and the admin panel.** Answers "is anything even reaching us",
   which is the question that decides whether the rest is worth building.
3. **Fixture verification in the lighting module**, wired to the existing
   `todo / rigged / ok / fault` workflow.
4. **Live levels** on the plan, front and 3D views. Last, and opt-in.

Stopping after 2 leaves something worth shipping. That is the point of the
order.
