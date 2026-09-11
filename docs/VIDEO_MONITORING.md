# Watching the LED wall

Crewbox reads LED processors. It cannot control them, and the point of this
document is to say exactly what that means, what is known about the protocols
involved, and — importantly — what is not.

**Status.** Built: the SNMP and HTTP readers, the discovery probe, the
double-confirmation gate, the poller and the pane.

**None of it has met a NovaStar processor directly — but the sister project
now has.** On 2026-09-11 novasun read a live MX40 Pro, read-only, and handed
over the response shapes as a fixture. Driven with them, this module's HTTP
reader graded a wall with no temperatures, no identity and every input
not-connected as **ok**. The reader and the grading were changed against that
fixture; the tests in `server/test/videoCoex.test.ts` under "the shapes a real
MX40 Pro returns" are that fixture. Every claim below carries where it came
from, and a claim without a source is a bug in this document.

## The one rule

**Crewbox watches the wall. It does not drive it.**

There is no encoder anywhere in this codebase that can produce a NovaStar
write — not a register write, not an HTTP PUT, not an SNMP SET. That is not a
review convention:

- `ReadOnlyInit.method` in `server/src/video/coex.ts` is the literal type
  `'GET'`, so no assignment in any file using `CoexIo` can produce another
  verb.
- `ReadOnlyInit.redirect` is the literal `'error'`, and `assertReadOnly` in
  the same file re-checks it — along with the destination port — before the
  real adapter opens anything. A type cannot cover this on its own: following
  a redirect is a decision the far end makes after the compiler has finished,
  and `fetch` follows one unless told not to. See the register bus, below.
- `encodePdu` in `server/src/video/snmp.ts` takes a `PduType` with exactly two
  members, GetRequest and GetNextRequest. SetRequest is 0xa3, and that byte
  appears nowhere in the codebase.
- `isUnicastIpv4` in `shared/src/video.ts` keeps a processor address to one
  host: multicast, the limited broadcast, loopback and `0.0.0.0` are refused,
  and `isOwnBroadcast` additionally refuses the directed broadcast of a subnet
  this box is on — the one class an address alone cannot reveal.
- `server/test/videoReadOnly.test.ts` asserts all of the above by reading
  every source file in `server/src/video/`, so the guarantee survives people
  who have not read this document. It also drives the real adapter at a server
  that answers `302 Location: http://<host>:5200/`, with a listener on 5200,
  and fails if anything arrives — because that one was not visible in the
  source at all.

The same reasoning as `docs/DMX_MONITORING.md`: every crew phone on the box
inherits whatever the box can do, and a festival's video network carries the
show. An app that can black out a screen is a way to black out a screen from
somebody's pocket.

### Where this differs from the lighting listener

The DMX and media-network listeners are **pure receive** — their sockets have
had `send` removed. This module cannot make that promise, because reading a
processor means asking it: an SNMP GET is a packet, and so is an HTTP GET.

So the promise here is a different one, and weaker in exactly one way: crewbox
transmits, but only requests that cannot change device state, and only to
single hosts somebody has named and confirmed — one address at a time, never
a group and never a segment. Adding and arming take a crew session, not the
admin password, which is deliberate: watching a wall is crew work. The sweep,
which is the one thing that addresses a whole segment, is the part that takes
the password. See "The gate" below.

### The register bus, and why nothing touches it

TCP 5200 is NovaStar's register bus. A control session on it is stateful and
may be held exclusively by NovaLCT (**REASONED**, from novasun's
investigation). Nothing in crewbox connects to it — not even to check whether
something is listening.

That was once true only of the code somebody would read. `fetch` follows
redirects by default, so a host at the address an admin typed could answer
`302 Location: http://<processor>:5200/` and the box would open TCP to the bus
and write an HTTP request into it, every twenty seconds — with `method: 'GET'`
intact the whole way, and nothing in this directory wrong. The reader now says
`redirect: 'error'` and the adapter refuses on the destination port before a
socket is opened, and a test with a listener on 5200 proves it.

That has a visible cost, and it is the right trade. An address that answers
nothing on 8001 and 161 could be an empty address, or it could be a VX4S or a
NovaPro UHD Jr, which have no read-only interface at all. Telling those apart
means opening a control session, and a connection made to satisfy curiosity
could take the desk away from the operator using it. So the pane says
"nothing to read" and explains why, rather than finding out.

## Provenance

Confidence labels, matching the ones novasun uses:

| Label        | Meaning                                                 |
| ------------ | ------------------------------------------------------- |
| **OFFICIAL** | Stated in a NovaStar document                           |
| **DERIVED**  | From decompiled NovaLCT assemblies or published clients |
| **REASONED** | An inference from protocol properties, not observed     |
| **UNKNOWN**  | Not established. Needs a bench. Do not design around it |

Claims marked **OBSERVED** below rest on one unit — a NovaPro MX40 Pro running
a live show, read twice, 35 minutes apart, over HTTP only — and on a NovaPro
UHD Jr on a bench. One unit each, one firmware each. That is what OBSERVED
means here; it does not mean "every controller".

**The source of truth is `legofsalmon/novasun`**, specifically
`docs/read-only-monitoring.md` and `src/novasun/snmp.py`. That repository
carries a standing instruction to keep this one supplied: update the
read-only contract when a finding affects it, keep the confidence labels,
withdraw claims that turn out to be inference, and never widen crewbox's
surface to writes. Protocol facts are not re-derived here — `oids.ts` copies
its numbers from `snmp.py` with the provenance attached.

That arrangement has already earned its keep. The prose summary in
`read-only-monitoring.md` lists the controller identity OIDs loosely enough
to put the primary/backup role in two places; `snmp.py` has the real
transcription. When two accounts of a protocol fact disagree, take the one
carrying its provenance.

### What was withdrawn

An earlier novasun note said the discovery reply "appears to carry model and
name information". That was inferred from a published client discarding bytes
after the prefix, never observed, and **it has been withdrawn**. Nothing here
decodes that payload into labelled fields; `discovery.ts` keeps the tail as an
unlabelled string, and a test asserts it produces no `model` or `name`.

If it had been built on, the pane would be printing invented labels beside a
processor's address at two in the morning.

## The three read paths

In the order the watcher prefers them.

### SNMP — the one NovaStar publishes for this

**OFFICIAL**, from _COEX SNMP Protocol Instructions V1.4.0_, transcribed in
`server/src/video/oids.ts`. GET is read-only by construction, and it carries
more than the HTTP API does: per-point mainboard temperatures and voltages,
fan status, output and input card health, Ethernet link speed, receiving cards
online per port, per-receiving-card temperature and voltage status, per-input
signal presence and connector type, brightness read-back, primary/backup role.

Two things crewbox cannot do, both writes, both surfaced as states rather than
attempted:

- **Switching SNMP on.** It must already be enabled at the controller. A box
  that finds it off falls back to HTTP and the pane says so, naming what a
  human has to do at the front panel or in VMP.
- **Configuring a trap target.** Traps on port 162 would be the right shape
  for a monitoring tool — the controller pushing changes rather than being
  polled — but pointing them at the box is a write. Listening on 162 is not,
  so a venue that has already configured traps is a thing crewbox could pick
  up for free. Not built; noted as the obvious next step.

Applies to MX40 Pro, MX30, MX20, KU20, MX6000 Pro, CX40 Pro (VMP 1.4.0+).

**Why the codec is hand-rolled.** novasun ships the OID map and deliberately
no SNMP client, on the grounds that a hand-rolled ASN.1 encoder is a liability
and every platform has a good one. That is right for a Python investigation
tool and wrong here, for one reason: the library would bring a `set()` with
it, and "there is no encoder that can express a write" is a much stronger
promise than "we don't call the setter". The liability being warned about is a
_general_ ASN.1 implementation; this is one PDU shape out and one in, and a
decode bug costs a missing field on a pane rather than a packet on a show
network. `server/test/videoBer.test.ts` pins the byte layout, including the
hostile-input cases.

### COEX HTTP on 8001 — easier, richer than it looked, and now observed

Endpoint paths are **OFFICIAL** (manual and published clients). Response field
names are **OBSERVED** on one MX40 Pro, and every spelling the manual and the
published clients had suggested was wrong on it:

- `/api/v1/device` answers **HTTP 404**, not a code-6 envelope. Identity comes
  from `monitor/info.name`, `"MX40 Pro_<digits>"`; the model is the prefix
  (REASONED from that one pattern).
- `/device/cabinet` and `input/sources` are **bare lists**, and ids are
  **numbers** — `512`, `768`, and 64-bit cabinet ids.
- `monitor/info.cabinets[]` entries carry `cabinetID: 0` and zero readings on
  every one; the receiving card under `rvCards[]` has the id that matches the
  cabinet list (288 of 288) and the real `temperature.value` and
  `voltage.value`. **Every reading is a `{ name, status, value }` object.**
- There is **no online flag anywhere**. A cabinet that is down is absent from
  `monitor/info`; the roster is `/device/cabinet`. The reader merges the two.
- Input signal is `sourceStatus` — `1` on the inputs feeding the show, `0` on
  the rest (REASONED from that pattern). A disconnected input **still reports
  a resolution**, the EDID default, so signal is never inferred from one.
- Fans are `fanInfos[]` with `fanSpeed` in **rpm**, not a percentage.
- `snmpstate` is `{ "state": false }` — and SNMP was **off** on the unit.
- `monitor/info` returns its cabinets in a **different order on every call**.
  Nothing may be keyed on list position.

`server/test/videoCoex.test.ts` pins both halves: that the observed payload is
read, and that the manual's spellings still are; `parseCabinets` reads the
card under `rvCards[]` first.

Safe to poll while VMP is connected: **OBSERVED for one burst, still REASONED
for a cadence.** Eight GETs against the unit mid-show answered in 0.1 s, no
`Busying`, no visible effect — twice. What a sustained cadence does to VMP is
not established; the 20 s policy stands. Two payloads are large: 342 KB of
cabinets and 265 KB of monitoring for 288 cabinets.

The policy follows novasun's recommendation: status every 20 s, topology every
tenth poll, 200 ms between requests, and a five-second back-off on code 5.

### Nothing — VX4S, NovaPro UHD Jr

No HTTP API and no SNMP agent. Monitoring these means the register bus, and
crewbox will not open it. The pane shows "nothing to read" and says why.

## Discovery, and why it is a send

The plan this module started from was passive: listen on UDP 3800, watch
NovaLCT probe, build an inventory, transmit nothing. **That does not work as a
plan**, and novasun's investigation is what killed it:

- The probe is broadcast to the subnet broadcast address and to multicast
  224.224.125.119 (**DERIVED**), so any host on the segment sees NovaLCT
  scanning. That half is fine.
- The **reply is unicast** back to the requester, at both layer 2 and layer 3
  (**OBSERVED**, by packet capture). A listener on a third host sees the probes
  and never sees what answered.
- VMP **does not probe on a timer** (**OBSERVED**: thirty minutes on a live-show
  network with VMP running and nobody pressing search overheard nothing), and
  an MX40 **never announced itself** in that time. A passive wait would last
  all night.

So crewbox sends the probe itself, once, when an admin asks. The packet is the
eight ASCII bytes `rqProMI:` — a broadcast UDP read with no addressed target,
no register address and no write bit. It cannot change controller state.

That the probe cannot change state is **REASONED**; that a UHD Jr and an MX40
both answered it with no visible effect is **OBSERVED**. The sweep stays behind
two confirmations, never on a timer, and prints verbatim what it transmitted.

It goes to the directed broadcast of the segment `CREWBOX_VIDEO_IFACE` names,
not 255.255.255.255. A limited broadcast leaves by whichever adapter the
routing table fancies, which on a box that also holds the crew Wi-Fi means
probing a network nobody asked about.

## Who may do what

The line is drawn at what a request _is_, not at how much it matters.

| Action                     | Needs                                   |
| -------------------------- | --------------------------------------- |
| Read the pane              | a session                               |
| Add or remove a processor  | a session                               |
| Start or stop watching one | a session, plus a confirmation to start |
| Sweep for processors       | the admin password, plus a confirmation |

Naming a processor and watching it produces addressed GETs, at a fixed rate,
whoever asked for them. Gating that behind the admin password would make the
pane useless to the screens tech it is for while protecting nothing — the
person who knows the processor's address _is_ the screens tech.

The sweep is the exception because it is the one packet here that is not a
read of a named device: a broadcast at a whole segment, from a box that may
also be sitting on the crew Wi-Fi. That is a decision about somebody else's
network, so it takes the password.

The box will not issue a _scan_ intent to a plain session either. Otherwise
the password on `/api/video/scan` would be the only thing holding, and one
lock is easier to leave open than two.

## The gate

Two actions transmit: sweeping for processors, and starting to watch one.
**Neither can be done in a single request**, by anybody.

```
POST /api/video/intent    → { token, willSend: [...], target, expiresAt }
POST /api/video/scan      → requires x-video-confirm: <token>
```

The first call sends nothing. It answers with a description of exactly what
would go on the wire and a single-use token bound to the admin who raised it,
scoped to one action and one processor, expiring in two minutes. The second
call requires that token back.

Doing this on the box rather than as a confirm dialog is the point. A dialog
protects the person looking at it; this protects the network. There is no
single call — mistyped, replayed, or made by something holding a token — that
puts a packet on a video network. `server/test/videoRoutes.test.ts` is written
as a list of attempts to get round it.

For watching, the confirmation is not a permission check — there is nothing
being withheld, since a session is enough. It is there because a crew member
is entitled to read what the box is about to put on a show network before it
does.

**Turning monitoring off needs no confirmation.** Stopping is not a
transmission, and anything that makes stopping harder than starting is the
wrong way round on a show day.

## The resting state is silence

A box with the video module enabled and nothing armed contacts nothing. That
is why `video` is safe in the default `CREWBOX_MODULES` list:

- Adding a processor stores an address. It contacts nothing.
- The watcher polls only entries with `monitored` set, which nothing sets
  without a confirmation first.
- A sweep runs once, on request, never on a timer.
- No socket is held open between polls. SNMP opens one per request and closes
  it in `finally`; the discovery socket closes when the sweep ends.

## Configuration

| Variable                       | What it does                                                          |
| ------------------------------ | --------------------------------------------------------------------- |
| `CREWBOX_MODULES`              | Include `video` (on by default) to enable the pane and the routes     |
| `CREWBOX_VIDEO_IFACE`          | The box's address on the video network. Needed **only** for the sweep |
| `CREWBOX_VIDEO_SNMP_COMMUNITY` | SNMP read community, default `public`                                 |

Processors added by address are read without `CREWBOX_VIDEO_IFACE`; only
sweeping needs it, and the pane says so when it is unset.

The community string is not a secret and is not treated as one — SNMPv2c has
no encryption and `public` is what COEX controllers ship with. It is
configurable because some venues change it, and a venue that has will tell you
what to.

## What the pane will not do

It will not fill a gap with a plausible number. Given that nothing here has
been checked against hardware, a pane that rounded uncertainty up to "fine"
would be converting "we don't know" into a decision somebody makes in the
dark. So:

- A controller reporting no temperature contributes no temperature to the row,
  and `gradeReading` returns `unknown` rather than `ok`.
- Receiving cards read over SNMP say "reporting abnormal" — SNMP gives a
  normal/abnormal status, never degrees, and printing degrees would be
  inventing them.
- A cabinet that did not report its online state is treated as online, not as
  down: a sparse payload must not paint a working wall red.
- Endpoints that did not answer are listed on the row, so a gap looks like a
  gap rather than like good news.

## The first day with hardware

novasun names two things worth doing, in order, and both would change this
document:

1. ~~**Capture one `rpProMI:` reply.**~~ **Done.** Replies are unicast; the
   payload is 16 bytes with an 8-byte ASCII tail (`App,0161` on a UHD Jr) that
   carries neither model nor name. Passive discovery is not possible; the
   active, on-demand probe was the right call.
2. ~~**Check whether SNMP is enabled.**~~ **Done, and it was off** on the one
   COEX unit seen. HTTP is the load-bearing read path, which is why its field
   names being observed matters more than the OID map for now.

Still to do: run a COEX poll at 1 Hz for ten minutes with VMP connected and
doing something visible. Two isolated bursts were harmless; a cadence has not
been tried. And unplug one input on a bench day, so `sourceStatus` = signal
becomes OBSERVED rather than reasoned.

## Out of scope, for now

Controlling anything: brightness, presets, blackout, freeze, input select,
test patterns, cabinet configuration. None of it, from any surface, at any
permission level — there is no code in the box that could.

**A control surface is expected later**, and is deliberately a separate piece
of work rather than something this one leaves a hook for. When it arrives it
will need its own decisions about who may drive a wall and how a mistake is
undone, and none of those are answered by "the reader already has an
address". Until then the guarantees above are unconditional, which is the
whole reason they are worth writing down.

Permanently out: the register bus, being a backup for VMP or NovaLCT, and
recording or storing video.
